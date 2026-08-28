import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field

from app.models.inventory import ClientRating, EquipmentStatus, RentalStatus


class EquipmentCategoryCreate(BaseModel):
    """Создание записи в справочнике категорий — эндпоинт доступен только
    владельцу бизнеса (см. app/api/routes/equipment.py:create_equipment_category,
    ctx.full_access), сама схема этого не проверяет."""

    name: str = Field(min_length=1, max_length=255)


class EquipmentCategoryOut(BaseModel):
    id: uuid.UUID
    name: str
    created_at: datetime

    model_config = {"from_attributes": True}


class EquipmentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    category: str = Field(min_length=1, max_length=255)
    code: str | None = None
    daily_rate: float = Field(ge=0)
    deposit: float = Field(ge=0, default=0)
    period_days: int | None = Field(default=None, ge=1)
    period_price: float | None = Field(default=None, ge=0)
    period_price_after: float | None = Field(default=None, ge=0)
    notes: str | None = Field(default=None, max_length=4000)


class EquipmentUpdate(BaseModel):
    """Частичное обновление оборудования — все поля необязательны (в отличие
    от EquipmentCreate). Используется и полной формой редактирования (шлёт
    все поля), и точечными действиями слайдовера (смена статуса/даты
    окончания обслуживания по одному полю), как в демо-прототипе
    (openEquipmentDetail: кнопки статуса и поле maintenanceUntil шлют
    изменения независимо от формы редактирования)."""

    name: str | None = Field(default=None, min_length=1, max_length=255)
    category: str | None = Field(default=None, min_length=1, max_length=255)
    code: str | None = None
    daily_rate: float | None = Field(default=None, ge=0)
    deposit: float | None = Field(default=None, ge=0)
    period_days: int | None = Field(default=None, ge=1)
    period_price: float | None = Field(default=None, ge=0)
    period_price_after: float | None = Field(default=None, ge=0)
    status: EquipmentStatus | None = None
    maintenance_until: date | None = None
    notes: str | None = Field(default=None, max_length=4000)


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
    notes: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class EquipmentImportRow(BaseModel):
    """Одна строка CSV-импорта — те же поля, что и EquipmentCreate, но без
    строгой валидации на уровне схемы (пустая строка/мусор из файла не
    должны падать с 422 на весь запрос разом — каждая строка проверяется
    руками в эндпоинте и получает свой собственный статус в отчёте, см.
    EquipmentImportRowResult)."""

    row: int
    name: str = ""
    category: str = ""
    code: str | None = None
    daily_rate: str = ""
    deposit: str = ""
    period_days: str = ""
    period_price: str = ""
    period_price_after: str = ""
    notes: str | None = None


class EquipmentImportRowResult(BaseModel):
    row: int
    ok: bool
    name: str
    error: str | None = None
    equipment: EquipmentOut | None = None


class EquipmentImportResult(BaseModel):
    total: int
    created: int
    failed: int
    results: list[EquipmentImportRowResult]


class ClientCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    phone: str | None = None
    email: str | None = None
    doc: str | None = None
    rating: ClientRating = ClientRating.normal
    notes: str | None = None


class ClientUpdate(BaseModel):
    """Частичное обновление клиента — все поля необязательны, меняются
    только переданные (см. PATCH /clients/{id}). Раньше этот эндпоинт
    принимал ClientCreate (требует name), из-за чего точечное действие
    «сменить рейтинг» из карточки клиента (шлёт только {rating}) падало
    с 422 — тем же паттерном, что был найден и исправлен для оборудования
    во втором проходе. Исправлено по аналогии."""

    name: str | None = Field(default=None, min_length=1, max_length=255)
    phone: str | None = None
    email: str | None = None
    doc: str | None = None
    rating: ClientRating | None = None
    notes: str | None = None


class ClientOut(BaseModel):
    id: uuid.UUID
    name: str
    phone: str | None
    email: str | None
    doc: str | None
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
    discount: float
    # Свободный текст состояния при выдаче/возврате (демо: r.issueNotes /
    # r.returnNotes) — печатается на актах приёма-передачи и возврата.
    issue_notes: str | None
    return_notes: str | None
    created_at: datetime
    # Финансовая раскладка — см. app/services/pricing.py:compute_rental_breakdown.
    # amount оставлен как алиас total ради обратной совместимости (сравнивался
    # напрямую в tests/test_rentals_flow.py и может использоваться где-то ещё).
    planned_days: int
    actual_days: int
    late_days: int
    base: float
    late_fee: float
    total: float
    amount: float
    # Сумма ТЕКУЩИХ (не снятых на момент оформления) залогов по оборудованию
    # в аренде — сознательное упрощение относительно демо-прототипа, который
    # снимает снимок залога в момент бронирования. Здесь снимка залога нет,
    # поэтому deposit_total читается "вживую" из Equipment.deposit на момент
    # ответа и может измениться, если залог у оборудования потом поменяют.
    deposit_total: float
    items: list[RentalItemOut] = []

    model_config = {"from_attributes": True}


class RentalIssue(BaseModel):
    # Пусто/не передано → подставляется дефолтный текст демо-прототипа
    # (см. app/api/routes/rentals.py:DEFAULT_ISSUE_NOTES).
    issue_notes: str | None = Field(default=None, max_length=1000)


class RentalReturn(BaseModel):
    damage_fee: float = Field(ge=0, default=0)
    discount: float = Field(ge=0, default=0)
    actual_return: date | None = None
    # Пусто/не передано → подставляется дефолтный текст демо-прототипа
    # (см. app/api/routes/rentals.py:DEFAULT_RETURN_NOTES).
    return_notes: str | None = Field(default=None, max_length=1000)


class RentalEdit(BaseModel):
    """Правка брони/активной аренды — мирроит editRentalForm демо-прототипа.
    Все поля опциональны: передаётся только то, что реально меняется."""

    start_date: date | None = None
    end_date: date | None = None
    equipment_ids: list[uuid.UUID] | None = None
    discount: float | None = Field(default=None, ge=0)
