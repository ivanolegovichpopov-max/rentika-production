import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field

from app.models.inventory import ClientRating, EquipmentStatus, RentalStatus


class EquipmentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    category: str = Field(min_length=1, max_length=255)
    code: str | None = None
    daily_rate: float = Field(ge=0)
    deposit: float = Field(ge=0, default=0)
    period_days: int | None = Field(default=None, ge=1)
    period_price: float | None = Field(default=None, ge=0)
    period_price_after: float | None = Field(default=None, ge=0)


class EquipmentOut(BaseModel):
    id: uuid.UUID
    name: str
    category: str
    code: str | None
    daily_rate: float
    deposit: float
    period_days: int | None
    period_price: float | None
    period_price_after: float | None
    status: EquipmentStatus
    maintenance_until: date | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ClientCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    phone: str | None = None
    rating: ClientRating = ClientRating.normal
    notes: str | None = None


class ClientOut(BaseModel):
    id: uuid.UUID
    name: str
    phone: str | None
    rating: ClientRating
    notes: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class RentalCreate(BaseModel):
    client_id: uuid.UUID
    equipment_ids: list[uuid.UUID] = Field(min_length=1)
    start_date: date
    end_date: date


class RentalItemOut(BaseModel):
    equipment_id: uuid.UUID
    daily_rate_snapshot: float
    period_days_snapshot: int | None
    period_price_snapshot: float | None
    period_price_after_snapshot: float | None

    model_config = {"from_attributes": True}


class RentalOut(BaseModel):
    id: uuid.UUID
    client_id: uuid.UUID
    start_date: date
    end_date: date
    actual_return: date | None
    status: RentalStatus
    damage_fee: float
    created_at: datetime
    amount: float
    items: list[RentalItemOut] = []

    model_config = {"from_attributes": True}


class RentalReturn(BaseModel):
    damage_fee: float = Field(ge=0, default=0)
    actual_return: date | None = None
