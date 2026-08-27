import uuid
from datetime import datetime

from pydantic import BaseModel, EmailStr, Field

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
