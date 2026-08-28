import uuid
from datetime import datetime

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.models.business import BusinessStatus, EmployeeStatus, PermissionLevel, ResourceType


class BusinessOut(BaseModel):
    id: uuid.UUID
    name: str
    status: BusinessStatus
    created_at: datetime

    model_config = {"from_attributes": True}


class PositionCreate(BaseModel):
    title: str = Field(min_length=1, max_length=255)


class PermissionIn(BaseModel):
    resource: ResourceType
    level: PermissionLevel


class PositionOut(BaseModel):
    id: uuid.UUID
    title: str
    permissions: list[PermissionIn] = []

    model_config = {"from_attributes": True}


class PositionUpdatePermissions(BaseModel):
    permissions: list[PermissionIn]


class EmployeeInvite(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=255)
    position_id: uuid.UUID | None = None
    temporary_password: str = Field(min_length=12, max_length=128)


class EmployeeOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    name: str
    position_id: uuid.UUID | None
    is_owner: bool
    status: EmployeeStatus

    model_config = {"from_attributes": True}


class EmployeeUpdate(BaseModel):
    name: str | None = None
    position_id: uuid.UUID | None = None
    status: EmployeeStatus | None = None


class DashboardPrefs(BaseModel):
    """Личная настройка дашборда текущего сотрудника: id скрытых плашек/панелей
    и переименованные подписи по id. Список валидных id — фиксированный набор
    из 12 блоков дашборда на фронтенде (6 стат-плашек + 6 панелей); бэкенд
    сознательно не валидирует конкретные значения id — это чисто "непрозрачная"
    для сервера пользовательская настройка UI, а не бизнес-данные."""

    hidden: list[str] = Field(default_factory=list, max_length=64)
    labels: dict[str, str] = Field(default_factory=dict)

    @field_validator("hidden")
    @classmethod
    def _cap_hidden_item_length(cls, value: list[str]) -> list[str]:
        return [v[:64] for v in value]

    @field_validator("labels")
    @classmethod
    def _cap_labels(cls, value: dict[str, str]) -> dict[str, str]:
        if len(value) > 64:
            raise ValueError("Слишком много переименованных блоков")
        return {k[:64]: v[:120] for k, v in value.items()}
