"""
Конфигурация приложения. Все значения читаются из переменных окружения
(см. .env.example и docker-compose.yml) — в коде нет ни одного секрета.
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- База данных ---
    # Строка подключения от имени ограниченной прикладной роли (НЕ суперпользователь) —
    # это важно для того, чтобы Row Level Security в Postgres реально применялась
    # (суперпользователь и владелец таблицы обходят RLS по умолчанию).
    database_url: str = "postgresql+psycopg://rentika_app:changeme@db:5432/rentika"
    # Строка подключения от имени суперпользователя — используется ТОЛЬКО сервисом
    # миграций (создание ролей, ALTER TABLE ... ENABLE ROW LEVEL SECURITY и т.п.).
    database_admin_url: str = "postgresql+psycopg://postgres:changeme@db:5432/rentika"

    # --- Redis (rate limiting) ---
    # В docker-compose переопределяется на redis://redis:6379/0 (см. .env.example) —
    # общее хранилище лимитов нужно, если backend когда-нибудь будет запущен
    # в нескольких репликах за балансировщиком. По умолчанию (локальный запуск,
    # тесты) используется in-memory backend библиотеки `limits`, без внешних
    # зависимостей.
    redis_url: str = "memory://"

    # --- JWT ---
    jwt_secret: str = "CHANGE-ME-IN-PRODUCTION-32-BYTES-MIN"
    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = 30
    refresh_token_ttl_days: int = 30

    # --- Пароли (NIST SP 800-63B, 2024) ---
    password_min_length: int = 12
    password_max_length: int = 128
    # Проверка по базе утечек Have I Been Pwned (k-anonymity, без передачи самого
    # пароля наружу — уходит только первые 5 символов SHA1). Можно отключить для
    # полностью изолированного (air-gapped) развёртывания.
    password_check_hibp: bool = True

    # --- 2FA ---
    totp_issuer: str = "RENTIKA CRM"

    # --- CORS ---
    cors_origins: list[str] = ["http://localhost:5173"]

    # --- Платформенный суперадмин (Иван) ---
    # Email, который при регистрации автоматически получает is_platform_admin=True.
    # В production стоит завести только один такой аккаунт и убрать значение отсюда
    # (переопределяется только через переменную окружения, не хардкожен).
    platform_admin_email: str | None = None

    environment: str = "production"


settings = Settings()
