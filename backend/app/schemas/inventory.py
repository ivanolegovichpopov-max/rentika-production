import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field, field_validator

from app.models.inventory import ClientRating, ClientType, EquipmentStatus, RentalStatus


def _strip_or_raise(value: str) -> str:
    """Обрезает пробелы и не даёт строке из одних пробелов пройти как
    непустой name/category — Field(min_length=1) сам по себе это не ловит,
    т.к. считает длину ДО обрезки (" " проходит как длина 1). Добавлено в
    четырнадцатом проходе (пункт 2 обзора формы "Добавить")."""

    stripped = value.strip()
    if not stripped:
        raise ValueError("не может быть пустым или состоять только из пробелов")
    return stripped


def _strip_optional(value: str | None) -> str | None:
    if value is None:
        return None
    return _strip_or_raise(value)


class EquipmentCategoryCreate(BaseModel):
    """Создание записи в справочнике категорий — эндпоинт доступен только
    владельцу бизнеса (см. app/api/routes/equipment.py:create_equipment_category,
    ctx.full_access), сама схема этого не проверяет."""

    name: str = Field(min_length=1, max_length=255)

    _strip_name = field_validator("name")(_strip_or_raise)


class EquipmentCategoryRename(BaseModel):
    """PATCH-переименование записи справочника — пятнадцатый проход
    (управление категориями). Отдельная от EquipmentCategoryCreate схема
    только для ясности эндпоинта в OpenAPI; по содержанию идентична."""

    name: str = Field(min_length=1, max_length=255)

    _strip_name = field_validator("name")(_strip_or_raise)


class EquipmentReorder(BaseModel):
    """Тело запроса на ручной порядок справочника (категорий/складов) —
    двадцатый проход, п.1 обзора: перетаскивание строк в модалках
    "Категории"/"Склады". order — ПОЛНЫЙ список id записей справочника этого
    бизнеса в желаемом порядке; частичный список отклоняется (см.
    app/api/routes/equipment.py:reorder_equipment_categories/warehouses) —
    иначе непереданные записи остались бы с "дырявым" position и порядок
    между уже упорядоченными и неупомянутыми записями стал бы непредсказуем."""

    order: list[uuid.UUID] = Field(min_length=1)


class EquipmentCategoryOut(BaseModel):
    id: uuid.UUID
    name: str
    created_at: datetime
    # Сколько позиций оборудования сейчас используют эту категорию —
    # добавлено в пятнадцатом проходе вместе с управлением справочником
    # (переименование/удаление): фронтенду это нужно, чтобы решить, можно ли
    # удалить категорию, и просто как полезная информация в списке.
    # ВСЕГДА проставляется явно в роутах (не read напрямую из ORM-объекта
    # через from_attributes — это вычисляемое поле, не колонка), поэтому
    # default не задан намеренно: пропущенное значение — сигнал забытого
    # места в коде, а не 0 по умолчанию.
    equipment_count: int

    model_config = {"from_attributes": True}


class EquipmentWarehouseCreate(BaseModel):
    """Создание записи в справочнике складов — восемнадцатый проход, точная
    аналогия EquipmentCategoryCreate (эндпоинт доступен только владельцу
    бизнеса, см. create_equipment_warehouse, ctx.full_access)."""

    name: str = Field(min_length=1, max_length=255)

    _strip_name = field_validator("name")(_strip_or_raise)


class EquipmentWarehouseRename(BaseModel):
    name: str = Field(min_length=1, max_length=255)

    _strip_name = field_validator("name")(_strip_or_raise)


class EquipmentWarehouseOut(BaseModel):
    id: uuid.UUID
    name: str
    created_at: datetime
    equipment_count: int

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
    # Длина "шага после" ступенчатого тарифа в днях (двадцатый проход, п.4
    # обзора) — см. докстринг Equipment.after_period_days и
    # app/services/pricing.py:item_cost_for_days. Как и три поля тарифа выше,
    # backend НЕ требует их обязательного совместного заполнения (та же
    # снисходительность, что и раньше — "всё или ничего" проверяет только
    # фронт, см. EquipmentTab.tsx:tieredProblem) — незаполненный тариф просто
    # не применяется (item_cost_for_days откатывается на daily_rate).
    after_period_days: int | None = Field(default=None, ge=1)
    # Склад — необязательное поле (восемнадцатый проход), в отличие от
    # category: не у каждого бизнеса несколько точек хранения.
    warehouse: str | None = Field(default=None, max_length=255)
    notes: str | None = Field(default=None, max_length=4000)

    _strip_name = field_validator("name")(_strip_or_raise)
    _strip_category = field_validator("category")(_strip_or_raise)
    _strip_warehouse = field_validator("warehouse")(_strip_optional)


class EquipmentBulkCreate(EquipmentCreate):
    """То же самое, что EquipmentCreate, плюс количество одинаковых позиций
    (двадцатый проход, п.3 обзора — "30 пар одной модели костылей"). Каждая
    позиция остаётся ОТДЕЛЬНОЙ строкой оборудования (свой id, свой статус,
    своя история аренд) — это сознательно НЕ поле "количество" на уровне
    одной записи (см. обсуждение с пользователем: для проката важно
    отслеживать состояние/повреждения/аренду каждой физической единицы по
    отдельности, а не только суммарный остаток). quantity — только удобство
    ввода на одной форме, а не новая модель данных; см.
    app/api/routes/equipment.py:create_equipment_bulk и группировку
    одинаковых позиций одной строкой в таблице на фронте
    (EquipmentTab.tsx:buildEquipmentRenderRows)."""

    quantity: int = Field(default=1, ge=1, le=200)


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
    after_period_days: int | None = Field(default=None, ge=1)
    warehouse: str | None = Field(default=None, max_length=255)
    status: EquipmentStatus | None = None
    maintenance_until: date | None = None
    notes: str | None = Field(default=None, max_length=4000)

    _strip_name = field_validator("name")(_strip_optional)
    _strip_category = field_validator("category")(_strip_optional)
    _strip_warehouse = field_validator("warehouse")(_strip_optional)


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
    after_period_days: int | None
    warehouse: str | None
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
    after_period_days: str = ""
    warehouse: str | None = None
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
    # ---- 25-й проход ----
    client_type: ClientType = ClientType.individual
    contact_person: str | None = None
    inn: str | None = None
    default_discount_percent: float | None = Field(default=None, ge=0, le=100)
    tags: str | None = None
    blacklist_reason: str | None = None


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
    # ---- 25-й проход ----
    client_type: ClientType | None = None
    contact_person: str | None = None
    inn: str | None = None
    default_discount_percent: float | None = Field(default=None, ge=0, le=100)
    tags: str | None = None
    blacklist_reason: str | None = None


class ClientOut(BaseModel):
    id: uuid.UUID
    name: str
    phone: str | None
    email: str | None
    doc: str | None
    rating: ClientRating
    notes: str | None
    created_at: datetime
    # ---- 25-й проход ----
    client_type: ClientType
    contact_person: str | None
    inn: str | None
    default_discount_percent: float | None
    tags: str | None
    blacklist_reason: str | None

    model_config = {"from_attributes": True}


class ClientNoteCreate(BaseModel):
    """Новая запись в журнале клиента (25-й проход, п.4) — см.
    ClientNote в app/models/inventory.py. employee_id проставляется на
    сервере из текущего аутентифицированного сотрудника, а не приходит
    от клиента запроса."""

    text: str = Field(min_length=1, max_length=2000)


class ClientNoteOut(BaseModel):
    id: uuid.UUID
    client_id: uuid.UUID
    employee_id: uuid.UUID | None
    employee_name: str | None = None
    text: str
    created_at: datetime

    model_config = {"from_attributes": True}


class ClientImportRowResult(BaseModel):
    """Одна строка CSV-импорта клиентов — тот же принцип отчёта построчно,
    что и EquipmentImportRowResult (см. app/api/routes/clients.py:import_clients):
    невалидные строки не роняют весь запрос, каждая получает свой статус.
    duplicate_warning — True, если телефон строки совпал с уже существующим
    клиентом (либо с уже импортированной в этом же файле строкой) — сама
    строка при этом ВСЁ РАВНО создаётся (совпадающий телефон — не всегда
    один и тот же человек, например у членов семьи), но сотрудник видит
    предупреждение в отчёте и может решить объединить карточки вручную
    (см. ClientMerge)."""

    row: int
    ok: bool
    name: str
    error: str | None = None
    client: ClientOut | None = None
    duplicate_warning: bool = False


class ClientImportResult(BaseModel):
    total: int
    created: int
    failed: int
    results: list[ClientImportRowResult]


class ClientMerge(BaseModel):
    """Слияние дублей клиента (24-й проход, п.7 обзора «Клиенты») — см.
    app/api/routes/clients.py:merge_client. into_client_id — карточка-ЦЕЛЬ,
    которая остаётся; клиент из пути запроса — источник, будет удалён после
    переноса на него всей истории аренд."""

    into_client_id: uuid.UUID


class RentalCreate(BaseModel):
    client_id: uuid.UUID
    equipment_ids: list[uuid.UUID] = Field(min_length=1)
    start_date: date
    end_date: date
    # 25-й проход, п.7: если не передана явно — сервер подставит фиксированную
    # рублёвую скидку сам, рассчитав её из Client.default_discount_percent (см.
    # app/api/routes/rentals.py:create_rental). Явно переданное значение (в том
    # числе 0) всегда имеет приоритет над клиентской умолчательной скидкой.
    discount: float | None = Field(default=None, ge=0)


class RentalItemOut(BaseModel):
    equipment_id: uuid.UUID
    daily_rate_snapshot: float
    period_days_snapshot: int | None
    period_price_snapshot: float | None
    period_price_after_snapshot: float | None
    after_period_days_snapshot: int | None

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
