import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field, field_validator

from app.models.inventory import ClientRating, ClientType, EquipmentStatus, RentalPhotoStage, RentalStatus


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


# ---- 29-й проход: лёгкая валидация формата (п.5/19 обзора — "телефон можно
# указать любой, ИНН вообще не ввести") — НЕ жёсткая привязка к российским
# правилам там, где бизнес явно планирует продавать за рубежом (см. п.5),
# только защита от заведомого мусора вроде "+70" (2 цифры). ----


def _validate_phone_format(value: str | None) -> str | None:
    """Если телефон указан — считаем цифры (не формат/маску, тот вопрос
    фронта, см. formatPhoneInput в lib/format.ts) и требуем разумное
    количество: 10-15, тот же диапазон, что и в E.164 (номер без кода
    страны — минимум 10 цифр, полный международный номер — максимум 15).
    Пустая строка/None — телефон необязателен, пропускаем без ошибки."""

    if value is None:
        return None
    stripped = value.strip()
    if not stripped:
        return None
    digits = sum(ch.isdigit() for ch in stripped)
    if digits < 10 or digits > 15:
        raise ValueError("похоже на некорректный номер телефона — должно быть от 10 до 15 цифр")
    return stripped


def _validate_inn_format(value: str | None) -> str | None:
    """ИНН — только цифры, 10 знаков у организации или 12 у ИП/физлица (та
    же длина, что и в реальных российских правилах). Пустая строка/None —
    поле необязательно само по себе (обязательность для client_type=company
    проверяется отдельно, на уровне маршрута — см. _require_company_fields в
    app/api/routes/clients.py, там уже известно окончательное, слитое с
    базой состояние клиента, а не только то, что пришло в этом запросе)."""

    if value is None:
        return None
    stripped = value.strip()
    if not stripped:
        return None
    if not stripped.isdigit() or len(stripped) not in (10, 12):
        raise ValueError("ИНН должен состоять из 10 цифр (организация) или 12 цифр (ИП/физлицо)")
    return stripped


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


class EquipmentTrashedOut(EquipmentOut):
    """Позиция оборудования в корзине (29-й проход) — см. ClientTrashedOut,
    та же идея."""

    deleted_at: datetime
    deleted_by_name: str | None = None


class EquipmentRestoreOut(BaseModel):
    id: uuid.UUID
    restored: bool = True


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


class ClientContact(BaseModel):
    """Один доп. контакт клиента-организации (26-й проход) — см.
    Client.additional_contacts в app/models/inventory.py. Список таких
    объектов целиком перезаписывается при сохранении формы.

    ВХОДНАЯ схема — используется только в ClientCreate/ClientUpdate. Валидатор
    телефона здесь оправдан: он не даёт сохранить заведомый мусор ПРИ ЗАПИСИ.
    См. ClientContactOut ниже — для чтения уже сохранённых данных нужна
    отдельная схема без этой проверки."""

    name: str = Field(min_length=1, max_length=255)
    role: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=32)

    _validate_phone = field_validator("phone")(_validate_phone_format)


class ClientContactOut(BaseModel):
    """Тот же доп. контакт, но для ОТДАЧИ клиенту — БЕЗ валидатора формата
    телефона (29-й проход, разбор прод-инцидента сразу после раскатки
    строгой проверки телефона: у части клиентов доп. контакты были сохранены
    ДО того, как валидатор появился, и в БД спокойно лежат номера вроде
    "+7 12". Если переиспользовать ClientContact (с валидатором) в ClientOut,
    FastAPI пытается провалидировать эти уже сохранённые значения ПРИ ЧТЕНИИ
    и падает с ResponseValidationError → 500 на весь список клиентов —
    ни один клиент бизнеса не отдаётся, пока в БД есть хоть один такой
    "старый" контакт. Валидация форматов должна работать только на входе
    (не пускать мусор внутрь), но не может ломать чтение уже сохранённых
    данных — отдаём как есть, без проверки."""

    name: str
    role: str | None
    phone: str | None


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
    # ---- 26-й проход ----
    birthday: date | None = None
    additional_contacts: list[ClientContact] | None = None

    _validate_phone = field_validator("phone")(_validate_phone_format)
    _validate_inn = field_validator("inn")(_validate_inn_format)


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
    # ---- 26-й проход ----
    birthday: date | None = None
    additional_contacts: list[ClientContact] | None = None

    _validate_phone = field_validator("phone")(_validate_phone_format)
    _validate_inn = field_validator("inn")(_validate_inn_format)


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
    # ---- 26-й проход ----
    birthday: date | None
    additional_contacts: list[ClientContactOut] | None
    # ---- 29-й проход ----
    was_blacklisted: bool

    model_config = {"from_attributes": True}


class ClientTrashedOut(ClientOut):
    """Клиент в корзине (29-й проход) — то же самое, что ClientOut, плюс
    когда и кем удалён. Отдельная схема, а не опциональные поля в ClientOut
    — deleted_at/deleted_by у активного (не удалённого) клиента не несут
    смысла и нигде в обычных ответах не нужны."""

    deleted_at: datetime
    deleted_by_name: str | None = None


class ClientRestoreOut(BaseModel):
    id: uuid.UUID
    restored: bool = True


class ClientDocumentOut(BaseModel):
    """Прикреплённый скан/фото документа клиента (26-й проход) — см.
    ClientDocument в app/models/inventory.py. data_base64 включён в ответ
    напрямую (тот же принцип простоты, что и у остальных небольших вложений
    в проекте — отдельного эндпоинта на скачивание не заводим, лимит размера
    файла (5 МБ) держит объём ответа разумным)."""

    id: uuid.UUID
    client_id: uuid.UUID
    employee_id: uuid.UUID | None
    employee_name: str | None = None
    filename: str
    content_type: str
    size_bytes: int
    data_base64: str
    # 29-й проход, повторный обзор, п.12 — короткая подпись документа
    # ("Разворот паспорта", "Прописка"), необязательная.
    label: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class ClientDocumentUpdate(BaseModel):
    """Изменение подписи уже загруженного документа (label — единственное
    редактируемое поле; сам файл/имя неизменяемы после загрузки, тем же
    append-only принципом, что и остальное содержимое ClientDocument)."""

    label: str | None = Field(default=None, max_length=255)


class ClientNoteCreate(BaseModel):
    """Новая запись в журнале клиента (25-й проход, п.4) — см.
    ClientNote в app/models/inventory.py. employee_id проставляется на
    сервере из текущего аутентифицированного сотрудника, а не приходит
    от клиента запроса."""

    text: str = Field(min_length=1, max_length=2000)


class ClientNoteUpdate(BaseModel):
    """Правка текста своей же записи (37-й проход, продолжение — та же
    политика, что и на удаление: см. _note_can_modify в
    app/api/routes/clients.py). Отдельная схема, а не переиспользование
    ClientNoteCreate — семантически это правка существующей записи, и на
    будущее у неё могут появиться свои поля, не связанные с созданием."""

    text: str = Field(min_length=1, max_length=2000)


class ClientNoteOut(BaseModel):
    id: uuid.UUID
    client_id: uuid.UUID
    employee_id: uuid.UUID | None
    employee_name: str | None = None
    text: str
    created_at: datetime
    # Может ли ТЕКУЩИЙ пользователь изменить/удалить именно эту запись (37-й
    # проход) — считается на сервере (автор + окно по времени, либо владелец
    # бизнеса без ограничений — см. _note_can_modify в
    # app/api/routes/clients.py) и просто отдаётся фронту готовым флагом,
    # чтобы кнопки "Изменить"/"Удалить" в журнале не дублировали эту логику
    # на клиенте и не могли разъехаться с тем, что реально разрешат
    # PATCH/DELETE-эндпоинты. Сейчас у обоих флагов одно и то же правило
    # (окно+автор/владелец), но это два отдельных поля на случай, если
    # политика для правки и удаления когда-нибудь разойдётся.
    can_edit: bool = False
    can_delete: bool = False

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
    # Частичный возврат по позициям (41-й проход) — см. RentalItem.returned_at
    # в app/models/inventory.py. None = позиция ещё у клиента.
    returned_at: date | None = None

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
    # Депозит возвращён клиенту (42-й проход) — отдельный факт от закрытия
    # аренды, см. Rental.deposit_returned_at в app/models/inventory.py.
    deposit_returned_at: date | None = None
    items: list[RentalItemOut] = []

    model_config = {"from_attributes": True}


class RentalIssue(BaseModel):
    # Пусто/не передано → подставляется дефолтный текст демо-прототипа
    # (см. app/api/routes/rentals.py:DEFAULT_ISSUE_NOTES).
    issue_notes: str | None = Field(default=None, max_length=1000)


class RentalCancel(BaseModel):
    """43-й проход, п.5 обзора — необязательная причина отмены, попадает в
    meta записи журнала (action="cancel", см. rental_history), а не в
    отдельное поле Rental: причина нужна только как контекст для истории,
    самой аренде она ничего не меняет."""

    reason: str | None = Field(default=None, max_length=500)


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


class RentalReturnItems(BaseModel):
    """Частичный возврат — возвращаются ТОЛЬКО перечисленные позиции аренды,
    остальные остаются у клиента, аренда в целом остаётся активной (если
    только этим запросом не закрываются как раз ПОСЛЕДНИЕ невозвращённые
    позиции — тогда см. app/api/routes/rentals.py:return_rental_items,
    аренда автоматически закрывается тем же путём, что и обычный полный
    возврат). equipment_ids — минимум одна позиция; damage_fee здесь
    СКЛАДЫВАЕТСЯ с уже накопленным на аренде (а не заменяет его) — ущерб
    может обнаружиться по частям, при разных заездах клиента за товаром."""

    equipment_ids: list[uuid.UUID] = Field(min_length=1)
    actual_return: date | None = None
    return_notes: str | None = Field(default=None, max_length=1000)
    damage_fee: float = Field(ge=0, default=0)


class RentalPhotoOut(BaseModel):
    """Фото состояния оборудования при выдаче/возврате (41-й проход) — см.
    RentalPhoto в app/models/inventory.py, та же простая схема хранения, что
    и ClientDocumentOut."""

    model_config = {"from_attributes": True}

    id: uuid.UUID
    rental_id: uuid.UUID
    employee_id: uuid.UUID | None
    employee_name: str | None = None
    stage: RentalPhotoStage
    filename: str
    content_type: str
    size_bytes: int
    data_base64: str
    created_at: datetime


class RentalDepositReturn(BaseModel):
    """Отметка "депозит возвращён клиенту" (42-й проход) — см.
    Rental.deposit_returned_at. returned=true проставляет дату (сегодня, если
    свою не передали), returned=false снимает отметку (на случай ошибки)."""

    returned: bool
    returned_at: date | None = None


class RentalHistoryEntry(BaseModel):
    """Одна запись журнала изменений аренды (42-й проход) — читает
    существующий AuditLog (app/models/audit.py), который и раньше писал
    события create/issue/edit/return/return_items/cancel по каждой аренде
    (см. log_action(...) по всему rentals.py), просто до этого прохода
    нигде не читался обратно в интерфейс."""

    action: str
    employee_name: str | None = None
    meta: dict | None = None
    created_at: datetime

    model_config = {"from_attributes": True}
