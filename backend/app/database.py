"""
Подключение к БД. Ключевая деталь для multi-tenant изоляции: перед каждым
запросом, привязанным к конкретному бизнесу, мы выставляем сессионную
переменную Postgres `app.rls.business_id` через `set_config(..., true)`
(аналог SET LOCAL, но параметризуемый) — политики RLS на таблицах
equipment/clients/rentals/rental_items читают именно её (см.
alembic/versions/0001_initial.py). Это работает ТОЛЬКО если приложение
подключается ролью, для которой RLS не обходится (обычная роль без
BYPASSRLS/SUPERUSER — см. database_admin_url и роль rentika_app,
создаваемую миграцией).
"""
from collections.abc import Generator

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings

engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def set_tenant_context(db: Session, business_id: str) -> None:
    """Включить RLS-контекст для конкретного бизнеса на всё время запроса.

    Один HTTP-запрос может открыть НЕСКОЛЬКО последовательных транзакций на
    одной и той же Session — например create_equipment делает db.commit(),
    а следующий db.refresh(item) молча открывает новую транзакцию. set_config
    с third-arg=true (аналог SET LOCAL) живёт только до конца ТЕКУЩЕЙ
    транзакции, поэтому одного вызова в начале запроса недостаточно: вторая
    транзакция унаследовала бы пустой контекст, RLS отфильтровала бы вообще
    всё, и db.refresh() падал бы с "Could not refresh instance" (было
    воспроизведено при ручном end-to-end прогоне на реальном Postgres перед
    тем, как добавили обработчик after_begin ниже).

    Решение: запоминаем business_id в session.info и переустанавливаем его
    через event-хук `after_begin` при открытии КАЖДОЙ новой транзакции на
    этой сессии — а не полагаемся на единственный вызов в начале запроса.
    """
    if db.bind is None or db.bind.dialect.name != "postgresql":
        return
    db.info["rls_business_id"] = str(business_id)
    if db.in_transaction():
        # Транзакция уже открыта (сессия использовалась до вызова этой
        # функции) — применяем контекст немедленно, не дожидаясь следующего
        # after_begin (событие сработает только при СЛЕДУЮЩЕМ begin).
        db.execute(text("SELECT set_config('app.rls.business_id', :bid, true)"), {"bid": str(business_id)})


def clear_tenant_context(db: Session) -> None:
    """Явно снять контекст (используется в платформенных/admin-эндпоинтах,
    где обращение идёт к нескольким бизнесам сразу — это единственное место,
    где RLS обходится осознанно, через отдельную привилегированную роль)."""
    if db.bind is None or db.bind.dialect.name != "postgresql":
        return
    db.info.pop("rls_business_id", None)
    if db.in_transaction():
        db.execute(text("RESET app.rls.business_id"))


@event.listens_for(Session, "after_begin")
def _reapply_rls_context_on_new_transaction(session, transaction, connection):  # noqa: ARG001
    """Срабатывает при открытии КАЖДОЙ новой транзакции на любой Session в
    процессе (включая SQLite-сессии в тестах — для них dialect.name !=
    'postgresql', и хук ничего не делает). Именно этот хук, а не разовый
    вызов set_tenant_context, гарантирует, что RLS-контекст переживает
    commit() посреди одного HTTP-запроса."""
    if connection.dialect.name != "postgresql":
        return
    business_id = session.info.get("rls_business_id")
    if business_id:
        connection.execute(text("SELECT set_config('app.rls.business_id', :bid, true)"), {"bid": business_id})
