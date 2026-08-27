"""
Тестовая инфраструктура: SQLite in-memory вместо реального Postgres — быстро,
без внешних зависимостей для CI. RLS-политики (единственная часть схемы,
специфичная для Postgres) здесь не проверяются — это осознанный компромисс
(см. app/database.py:set_tenant_context), tenant-изоляция на уровне
прикладной логики покрыта тестами (test_tenant_isolation.py), а RLS как
второй рубеж защиты — см. README, раздел "Проверка RLS на реальном Postgres".
"""
import os

# Выставляем ДО импорта app.* — pydantic-settings читает env один раз при
# первом импорте app.config. Отключаем сетевую проверку HIBP в тестах:
# юнит-тесты не должны зависеть от доступности внешнего API.
os.environ.setdefault("PASSWORD_CHECK_HIBP", "false")
os.environ.setdefault("JWT_SECRET", "test-secret-not-for-production-use-only-in-ci")
# ENVIRONMENT=production включает Secure-флаг на refresh-cookie (см.
# app/api/routes/auth.py) — правильно для реального HTTPS-деплоя, но
# TestClient обращается по http://testserver, и Secure-cookie туда просто не
# отправился бы обратно, как и в настоящем браузере.
os.environ.setdefault("ENVIRONMENT", "test")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models  # noqa: F401
from app.database import Base, get_db
from app.main import app


@pytest.fixture()
def db_session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    TestingSessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)


@pytest.fixture()
def client(db_session):
    from app.core.rate_limit import limiter

    def _override_get_db():
        try:
            yield db_session
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db
    # In-memory rate-limit storage переживает между тестами в рамках одного
    # процесса pytest — без сброса второй тест по счёту упёрся бы в лимит
    # регистрации (5/hour), рассчитанный на реальных пользователей, а не на
    # тестовый прогон в одну секунду.
    limiter.reset()
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def register_business(client, email="owner@example.com", password="correct horse battery staple", business_name="Тестовый прокат"):
    resp = client.post(
        "/api/auth/register",
        json={"email": email, "password": password, "business_name": business_name},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}
