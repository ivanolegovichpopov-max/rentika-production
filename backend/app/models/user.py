import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import GUID


class User(Base):
    """Учётная запись платформы. Один User может владеть/работать в нескольких
    Business (через Employee) — это отличает production-модель от однотенантной
    Supabase-версии, где auth.users был привязан к одному общему пространству."""

    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)

    # Иван — единственный, у кого это True. Полный доступ ко всем бизнесам
    # (техподдержка/администрирование платформы), в обход обычных ACL-проверок.
    is_platform_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # --- 2FA (TOTP, RFC 6238) ---
    totp_secret: Mapped[str | None] = mapped_column(String(64), nullable=True)
    totp_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    totp_backup_codes: Mapped[str | None] = mapped_column(
        String(1024), nullable=True, doc="JSON-массив хэшей одноразовых backup-кодов"
    )

    # --- Защита от подбора пароля ---
    failed_login_attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Момент последнего успешного входа (65-й проход) — проставляется в
    # /auth/login при успешной проверке пароля (см. app/api/routes/auth.py).
    # NULL, пока пользователь ни разу не входил (например, только что
    # приглашённый сотрудник, ещё не открывавший приложение под своим
    # логином) — раньше на странице «Сотрудники» не было способа понять,
    # входил ли вообще человек в систему и когда в последний раз.
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class RefreshToken(Base):
    """Refresh-токены хранятся не как сами значения, а как хэши (SHA-256) —
    утечка БД сама по себе не даёт захватить чужую сессию. Ротируются при
    каждом использовании (см. app/core/security.py: refresh_access_token)."""

    __tablename__ = "refresh_tokens"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), index=True, nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
