"""
Модель проката 1-в-1 повторяет схему из index-supabase.html (см. SPEC.md
раздел 9.3 в исходном проекте), с добавлением business_id для multi-tenant
изоляции. Бизнес-логика тарифов (posуточная/ступенчатая цена) остаётся такой
же, как в клиентском прототипе — переносится в отдельный сервис
app/services/pricing.py при портировании эндпоинтов (см. задачу #43 в плане).
"""
import enum
import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Enum, ForeignKey, Integer, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import GUID


class EquipmentStatus(str, enum.Enum):
    available = "available"
    rented = "rented"
    maintenance = "maintenance"
    retired = "retired"


class RentalStatus(str, enum.Enum):
    booked = "booked"
    active = "active"
    overdue = "overdue"
    returned = "returned"
    cancelled = "cancelled"


class ClientRating(str, enum.Enum):
    normal = "normal"
    watch = "watch"          # «на контроле»
    blacklist = "blacklist"  # «чёрный список»


class Equipment(Base):
    __tablename__ = "equipment"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    category: Mapped[str] = mapped_column(String(255), nullable=False)
    code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    daily_rate: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    deposit: Mapped[float] = mapped_column(Numeric(12, 2), default=0, nullable=False)
    # Ступенчатый тариф (опционально): после period_days цена за день падает
    # до period_price_after; period_price — цена за первый период целиком.
    period_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    period_price: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    period_price_after: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    status: Mapped[EquipmentStatus] = mapped_column(
        Enum(EquipmentStatus, name="equipment_status"), default=EquipmentStatus.available, nullable=False
    )
    maintenance_until: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Client(Base):
    __tablename__ = "clients"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    rating: Mapped[ClientRating] = mapped_column(
        Enum(ClientRating, name="client_rating"), default=ClientRating.normal, nullable=False
    )
    notes: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Rental(Base):
    __tablename__ = "rentals"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    client_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("clients.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    actual_return: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[RentalStatus] = mapped_column(
        Enum(RentalStatus, name="rental_status"), default=RentalStatus.booked, nullable=False
    )
    damage_fee: Mapped[float] = mapped_column(Numeric(12, 2), default=0, nullable=False)
    created_by_employee_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class RentalItem(Base):
    """Снимок цены оборудования на момент оформления аренды — сознательно НЕ
    пересчитывается задним числом, даже если позже поменяется daily_rate у
    Equipment (тот же принцип, что и в index-supabase.html)."""

    __tablename__ = "rental_items"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    rental_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("rentals.id", ondelete="CASCADE"), nullable=False, index=True
    )
    equipment_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("equipment.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    daily_rate_snapshot: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    period_days_snapshot: Mapped[int | None] = mapped_column(Integer, nullable=True)
    period_price_snapshot: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    period_price_after_snapshot: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
