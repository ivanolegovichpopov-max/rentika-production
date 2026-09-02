import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import GUID


class AuditLog(Base):
    """Журнал действий — не ради галочки: при разборе инцидента («кто удалил
    клиента», «кто поменял права сотруднику») это единственный источник
    правды, который не зависит от того, что кто-то потом почистил основные
    таблицы. Пишется на уровне сервисного слоя (app/core/audit.py), не триггерами БД —
    так проще приложить осмысленный meta (что именно изменилось)."""

    __tablename__ = "audit_log"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), nullable=True, index=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    resource: Mapped[str] = mapped_column(String(64), nullable=False)
    resource_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    meta: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Журнал аренды (42-й проход, rental_history) сортируется от новых к
    # старым, и ВАЖНА стабильная сортировка внутри одной секунды — несколько
    # действий подряд обычное дело (а с массовыми действиями по списку аренд
    # это станет и вовсе типичным случаем: пачка record'ов пишется в цикле
    # за миллисекунды). Секундного разрешения server_default=func.now() на
    # SQLite (в тестах) не хватает; тот же приём, что уже применён у
    # ClientNote.created_at и RentalPhoto.created_at — клиентский default с
    # микросекундной точностью, server_default остаётся подстраховкой на
    # случай прямой SQL-вставки в обход ORM.
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), server_default=func.now()
    )
