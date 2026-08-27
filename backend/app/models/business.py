import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import GUID


class BusinessStatus(str, enum.Enum):
    active = "active"
    suspended = "suspended"


class EmployeeStatus(str, enum.Enum):
    invited = "invited"
    active = "active"
    disabled = "disabled"


class ResourceType(str, enum.Enum):
    """Ресурсы, на которые распространяются ACL-права должности."""

    clients = "clients"
    equipment = "equipment"
    rentals = "rentals"
    finance = "finance"
    employees = "employees"


class PermissionLevel(str, enum.Enum):
    none = "none"
    view = "view"
    edit = "edit"


LEVEL_ORDER = {PermissionLevel.none: 0, PermissionLevel.view: 1, PermissionLevel.edit: 2}


class Business(Base):
    """Тенант. Каждый бизнес-клиент Ивана — это одна строка здесь; все
    операционные данные (оборудование/клиенты/аренды) привязаны к business_id
    и физически изолированы политиками RLS (см. alembic-миграцию)."""

    __tablename__ = "businesses"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    owner_user_id: Mapped[uuid.UUID] = mapped_column(GUID(), nullable=False)
    status: Mapped[BusinessStatus] = mapped_column(
        Enum(BusinessStatus, name="business_status"), default=BusinessStatus.active, nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Position(Base):
    """Должность внутри конкретного бизнеса (например, «Менеджер по прокату»,
    «Бухгалтер») — свой набор для каждого business_id, не общий справочник."""

    __tablename__ = "positions"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (UniqueConstraint("business_id", "title", name="uq_position_business_title"),)


class Permission(Base):
    """Право должности на конкретный ресурс. Отсутствие строки трактуется как
    `none` (см. app/core/deps.py:get_effective_permission) — можно не заводить
    явные `none`-строки для каждой должности x ресурса."""

    __tablename__ = "permissions"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    position_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("positions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    resource: Mapped[ResourceType] = mapped_column(Enum(ResourceType, name="resource_type"), nullable=False)
    level: Mapped[PermissionLevel] = mapped_column(
        Enum(PermissionLevel, name="permission_level"), default=PermissionLevel.none, nullable=False
    )

    __table_args__ = (UniqueConstraint("position_id", "resource", name="uq_permission_position_resource"),)


class Employee(Base):
    """Связка «пользователь работает в этом бизнесе». Владелец бизнеса — тоже
    Employee (is_owner=True), но у него всегда полный доступ вне зависимости
    от position_id/Permission — так задумано пользователем явно."""

    __tablename__ = "employees"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    position_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("positions.id", ondelete="SET NULL"), nullable=True
    )
    is_owner: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    status: Mapped[EmployeeStatus] = mapped_column(
        Enum(EmployeeStatus, name="employee_status"), default=EmployeeStatus.active, nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (UniqueConstraint("business_id", "user_id", name="uq_employee_business_user"),)
