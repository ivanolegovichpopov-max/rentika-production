"""
Модель проката 1-в-1 повторяет схему из index-supabase.html (см. SPEC.md
раздел 9.3 в исходном проекте), с добавлением business_id для multi-tenant
изоляции. Бизнес-логика тарифов (posуточная/ступенчатая цена) остаётся такой
же, как в клиентском прототипе — переносится в отдельный сервис
app/services/pricing.py при портировании эндпоинтов (см. задачу #43 в плане).
"""
import enum
import uuid
from datetime import date, datetime, timezone

from sqlalchemy import JSON, Date, DateTime, Enum, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint, func
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


class RentalPhotoStage(str, enum.Enum):
    """Этап аренды, к которому относится фото состояния оборудования (41-й
    проход) — то же деление, что и у issue_notes/return_notes на Rental,
    только для вложений. "return" как значение enum, но не как имя атрибута
    Python (зарезервированное слово) — атрибут называется return_."""

    issue = "issue"
    return_ = "return"


class ClientType(str, enum.Enum):
    """Физлицо или организация (25-й проход, обзор «глазами обычного
    пользователя», п.2) — у организации другой набор реквизитов для
    договора (контактное лицо, ИНН вместо паспорта). Client.name используется
    для ОБОИХ типов как есть — для организации это название компании, второе
    поле для имени не заводилось."""

    individual = "individual"
    company = "company"


class EquipmentCategory(Base):
    """Жёсткий справочник категорий оборудования (одиннадцатый... нет,
    тринадцатый проход — см. claude/notes.md). Создание записи в справочнике
    — привилегия исключительно владельца бизнеса (см. app/api/routes/
    equipment.py: create_equipment_category использует ctx.full_access, а не
    edit_dep) — этим же принципом уже управляются Position/Permission и
    business.notes_mode/messaging_permission. Обычные роли с доступом
    view/edit на «Оборудование» могут только ВЫБИРАТЬ из уже существующих
    категорий при заведении/редактировании позиции (см. Equipment.category
    ниже) — свободный ввод текста для них закрыт валидацией на уровне API,
    иначе весь смысл жёсткого справочника (нет дублей вроде «Инструмент» /
    «инструмент» / «инструменты») теряется.

    equipment.category намеренно остаётся простой строкой без FK на эту
    таблицу (см. комментарий там) — эта таблица используется только для
    валидации на уровне API и для автодополнения на фронте, а не как
    единственный источник истины о том, какие значения физически лежат в
    equipment.category (после миграции там могут быть и старые «мусорные»
    значения — см. 0008_equipment_categories.py, backfill из уже
    существующих данных)."""

    __tablename__ = "equipment_categories"
    __table_args__ = (UniqueConstraint("business_id", "name", name="uq_equipment_category_business_name"),)

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # Ручной порядок для перетаскивания в UI (двадцатый проход, п.1 обзора —
    # "перетаскивание категорий/складов"). НЕ уникально и НЕ обязательно
    # плотное (0,1,2,…) — только относительный порядок сортировки внутри
    # бизнеса имеет значение; см. app/api/routes/equipment.py:
    # _next_category_position (новые записи добавляются в конец) и
    # reorder_equipment_categories (перезаписывает position у всего набора
    # разом при перетаскивании). Бэкафилл существующих записей — см.
    # 0011_equipment_ordering_and_tiered_pricing.py (по алфавиту, чтобы
    # порядок списка не "прыгнул" сразу после миграции).
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class EquipmentWarehouse(Base):
    """Жёсткий справочник складов/точек хранения — восемнадцатый проход, по
    прямой аналогии с EquipmentCategory выше (тот же принцип: создание
    записи — привилегия владельца бизнеса, equipment.warehouse — простая
    строка без FK, эта таблица только для валидации на уровне API и
    автодополнения на фронте). В отличие от category поле необязательное —
    у бизнеса с одной точкой хранения справочник может оставаться пустым."""

    __tablename__ = "equipment_warehouses"
    __table_args__ = (UniqueConstraint("business_id", "name", name="uq_equipment_warehouse_business_name"),)

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # См. EquipmentCategory.position выше — та же механика ручного порядка.
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Equipment(Base):
    __tablename__ = "equipment"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # Без FK на equipment_categories намеренно — см. докстринг EquipmentCategory
    # выше. Валидация «категория должна существовать в справочнике» живёт на
    # уровне API (app/api/routes/equipment.py:_ensure_category), не в схеме БД —
    # это даёт миграции безопасно переехать со старыми/мусорными значениями
    # без риска упасть на constraint-violation при бэкафилле.
    category: Mapped[str] = mapped_column(String(255), nullable=False)
    # Склад/точка хранения (восемнадцатый проход) — тот же принцип, что и у
    # category (без FK, валидация на уровне API), но НЕОБЯЗАТЕЛЬНОЕ поле: не
    # у каждого бизнеса несколько точек хранения.
    warehouse: Mapped[str | None] = mapped_column(String(255), nullable=True)
    code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    daily_rate: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    deposit: Mapped[float] = mapped_column(Numeric(12, 2), default=0, nullable=False)
    # Ступенчатый тариф (опционально): первые period_days дней стоят
    # period_price целиком; каждый ПОЛНЫЙ ИЛИ НАЧАТЫЙ шаг длиной
    # after_period_days дней сверх этого стоит period_price_after (двадцатый
    # проход, п.4 обзора — "190₽ за любую часть недели сверху": раньше
    # period_price_after делился на period_days и размазывался линейно по
    # дням, из-за чего "цену за неделю" нельзя было ввести напрямую — только
    # пересчитав её в цену за сутки в уме. Теперь у "шага после" своя
    # собственная длина, независимая от длины первого периода — см.
    # app/services/pricing.py:item_cost_for_days. after_period_days==None —
    # это ТОЛЬКО обратная совместимость сырых вызовов функции без явного
    # значения (см. докстринг item_cost_for_days); у любой записи в БД,
    # где вообще задан ступенчатый тариф, это поле всегда заполнено (см.
    # 0011_equipment_ordering_and_tiered_pricing.py — бэкафилл существующих
    # строк на after_period_days=1 с пересчётом period_price_after к цене за
    # одни сутки, что математически не меняет уже посчитанные суммы).
    period_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    period_price: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    period_price_after: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    after_period_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[EquipmentStatus] = mapped_column(
        Enum(EquipmentStatus, name="equipment_status"), default=EquipmentStatus.available, nullable=False
    )
    maintenance_until: Mapped[date | None] = mapped_column(Date, nullable=True)
    # Свободная заметка по позиции (состояние, комплектация, особенности —
    # что угодно, что не влезает в структурированные поля). Добавлено по
    # запросу пользователя в тринадцатом проходе.
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    # ---- 29-й проход: мягкое удаление ("Корзина") — см. докстринг
    # миграции 0014_soft_delete_and_client_flags. NULL = позиция активна и
    # видна в обычных списках; заполнено = лежит в корзине (восстановима
    # через POST .../equipment/{id}/restore, пока не будет автоматически
    # зачищена — см. app/services/trash.py:purge_expired — или удалена
    # окончательно вручную из UI корзины).
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_by_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Client(Base):
    __tablename__ = "clients"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # email намеренно без unique — один и тот же email в реальности нередко
    # указывают несколько разных клиентов одного бизнеса (см. демо-прототип).
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    doc: Mapped[str | None] = mapped_column(String(255), nullable=True)  # паспорт/иной документ, для договора
    rating: Mapped[ClientRating] = mapped_column(
        Enum(ClientRating, name="client_rating"), default=ClientRating.normal, nullable=False
    )
    notes: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    # ---- 25-й проход (обзор «глазами обычного пользователя») ----
    client_type: Mapped[ClientType] = mapped_column(
        Enum(ClientType, name="client_type"), default=ClientType.individual, nullable=False
    )
    # Контактное лицо и ИНН имеют смысл только для client_type=company — на
    # уровне БД/схемы это НЕ проверяется (та же снисходительность, что и у
    # "всё или ничего" в ступенчатом тарифе оборудования — см. EquipmentCreate),
    # проверка чисто визуальная на фронте (форма показывает эти поля только
    # для организации).
    contact_person: Mapped[str | None] = mapped_column(String(255), nullable=True)
    inn: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # Скидка по умолчанию для этого клиента, В ПРОЦЕНТАХ (0-100) — в отличие
    # от Rental.discount, который фиксированная сумма в рублях за конкретную
    # аренду: клиентский умолчательный размер скидки логичнее держать в
    # процентах, потому что сумма аренды каждый раз разная, а скидка "всегда
    # 10%" — нет. Применяется как ПОДСКАЗКА при создании новой аренды (см.
    # app/api/routes/rentals.py:create_rental) — переводится в фиксированную
    # рублёвую Rental.discount один раз в момент создания, дальше живёт как
    # обычная скидка конкретной аренды (её по-прежнему можно поменять вручную).
    default_discount_percent: Mapped[float | None] = mapped_column(Numeric(5, 2), nullable=True)
    # Свободные метки через запятую ("постоянный,оптовик") — сознательно НЕ
    # отдельная таблица-справочник (как категории оборудования): теги здесь
    # произвольные, без нужды в переименовании/подсчёте использований на
    # уровне бизнеса, поэтому простое текстовое поле дешевле и достаточно.
    tags: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Причина занесения в чёрный список — чтобы через полгода кто-то другой
    # из команды видел, ПОЧЕМУ клиент проблемный, а не только сам факт.
    # Очищается фронтом при снятии статуса "чёрный список" (см. ClientsTab.tsx).
    blacklist_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # ---- 26-й проход (обзор вкладки «Клиенты» — проф. взгляд + «глазами
    # обычного пользователя», согласовано целиком) ----
    # День рождения — только дата, без времени: используется на фронте для
    # фильтра "Дни рождения на этой неделе" (тот же принцип, что и
    # isDormantClient в ClientsTab.tsx — считается из уже загруженного
    # списка, отдельный эндпоинт не нужен).
    birthday: Mapped[date | None] = mapped_column(Date(), nullable=True)
    # Доп. контакты клиента-организации ([{name, role, phone}, ...]) —
    # JSON-список, целиком перезаписывается при сохранении формы, в отличие
    # от client_notes у него нет своего времени/автора на запись (см.
    # комментарий в alembic/versions/0013_client_extras.py).
    additional_contacts: Mapped[list[dict] | None] = mapped_column(JSON, nullable=True)
    # ---- 29-й проход: см. докстринг миграции 0014_soft_delete_and_client_flags ----
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_by_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True
    )
    # Постоянная пометка "когда-то был в чёрном списке" — не сбрасывается
    # автоматически при смене рейтинга на другой (см. update_client), чтобы
    # сотрудники видели, кто перед ними, даже после реабилитации клиента.
    was_blacklisted: Mapped[bool] = mapped_column(default=False, server_default="false", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ClientDocument(Base):
    """Прикреплённый скан/фото документа клиента (паспорт, доверенность и
    т.п.) — 26-й проход. Хранится как base64 в текстовой колонке: в проекте
    нет настроенного объектного хранилища (S3/аналоги), а для объёма файлов,
    разумного для скана документа (лимит проверяется в
    app/api/routes/clients.py), Postgres/SQLite TEXT достаточно — заводить
    внешнее хранилище было бы непропорционально задаче. Append-only с точки
    зрения содержимого (файл не редактируется, только удаляется целиком),
    тем же духом, что и ClientNote."""

    __tablename__ = "client_documents"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    client_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True
    )
    employee_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True
    )
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    data_base64: Mapped[str] = mapped_column(Text, nullable=False)
    # Короткая пометка "что это за документ" (29-й проход, повторный обзор,
    # п.12 — "непонятно, какой документ есть какой, если их несколько, а
    # называются они как в телефоне сфотографировавшего"). Необязательное —
    # старые/невыставленные документы просто идентифицируются по filename,
    # как и раньше.
    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), server_default=func.now()
    )


class ClientNote(Base):
    """Журнал записей по клиенту (25-й проход, п.4 обзора) — в отличие от
    Client.notes (одно затираемое поле, "текущая памятка"), это лента
    отдельных датированных записей ("14 авг: звонил, спрашивал про
    виброплиту") с указанием, кто из сотрудников её оставил — по духу
    близко к AuditLog (история не переписывается задним числом), но не
    настолько строго: с 37-го прохода автор может изменить ТЕКСТ или
    удалить СВОЮ запись, и только в течение короткого окна после
    добавления (см. CLIENT_NOTE_DELETE_WINDOW_MINUTES и _note_can_modify в
    app/api/routes/clients.py, одно и то же окно на оба действия) — это
    закрывает случай "опечатался, сразу заметил", но не даёт задним числом
    почистить/переписать историю недельной/месячной давности. Владелец
    бизнеса (ctx.full_access) может изменить или удалить любую запись без
    ограничения по времени — та же модерационная логика, что и у
    DashboardNote (app/api/routes/notes.py)."""

    __tablename__ = "client_notes"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    client_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("clients.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # SET NULL, а не RESTRICT/CASCADE — увольнение/удаление сотрудника не
    # должно ни блокироваться его старыми записями в журнале, ни утаскивать
    # их за собой; текст записи сам по себе остаётся ценным без автора.
    employee_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True
    )
    text: Mapped[str] = mapped_column(String(2000), nullable=False)
    # Журнал сортируется от новых к старым (см. list_client_notes) — в
    # отличие от остальных created_at в проекте (server_default=func.now()),
    # здесь ВАЖНА сортировка внутри одной секунды (несколько записей подряд —
    # обычное дело), а секундного разрешения server_default на SQLite (в
    # тестах) и теоретически близких по времени запросов на Postgres может не
    # хватить. Поэтому клиентский default с микросекундной точностью — он
    # приоритетнее server_default при обычной вставке через ORM (тот остаётся
    # подстраховкой на случай прямой SQL-вставки в обход ORM).
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), server_default=func.now()
    )


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
    # Фиксированная скидка в рублях (не процент!), вручную вводимая
    # сотрудником — вычитается из итога отдельно от damage_fee, как в
    # демо-прототипе (r.discount).
    discount: Mapped[float] = mapped_column(Numeric(12, 2), default=0, nullable=False)
    # Свободный текст состояния при выдаче/возврате — переносится 1-в-1 из
    # демо-прототипа (r.issueNotes/r.returnNotes), печатается на актах
    # приёма-передачи и возврата.
    issue_notes: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    return_notes: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    created_by_employee_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # Депозит возвращён клиенту (42-й проход) — отдельный факт от самого
    # закрытия аренды: deposit_total (см. RentalOut) считается "вживую" по
    # ТЕКУЩЕМУ Equipment.deposit позиций и никогда не хранится как отдельная
    # сумма на аренде, поэтому "возвращён" не может быть просто датой на уже
    # существующем денежном поле — это независимый факт, который сотрудник
    # проставляет сам (обычно после "Принять возврат", но не обязан
    # совпадать по времени — иногда депозит отдают на следующий день).
    # NULL = ещё не возвращён, дата = когда отметили.
    deposit_returned_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    # Учёт оплаты (46-й проход) — накопительная сумма всех платежей по этой
    # аренде, а не единственное значение: сотрудник может получать деньги
    # несколькими заходами (депозит при брони, остаток при возврате), см.
    # POST .../payment в app/api/routes/rentals.py — ДОБАВЛЯЕТ переданную
    # сумму к уже накопленной, той же логикой, что и damage_fee при
    # частичном возврате. Остаток к оплате (total - paid_amount) нигде не
    # хранится — total сам по себе не хранится, считается вживую (см.
    # app/services/pricing.py:compute_rental_breakdown), поэтому и остаток
    # может для активной/просроченной аренды меняться день ото дня, как и
    # сам total.
    paid_amount: Mapped[float] = mapped_column(Numeric(12, 2), default=0, nullable=False)
    # Доп. услуги аренды (46-й проход, по итогам обсуждения "как принять
    # доп. сумму за доставку/накачку SUP-борда") — В ОТЛИЧИЕ от paid_amount
    # и damage_fee (накапливаются несколькими заходами), это ОДНО значение,
    # заменяемое целиком — тот же принцип, что и discount: сотрудник
    # вписывает сумму при создании аренды (RentalCreate.extra_fee) или
    # правит её позже через "Изменить" (RentalEdit.extra_fee /
    # app/api/routes/rentals.py:edit_rental), а не добавляет платёж поверх
    # платежа. Входит в total наравне с damage_fee (см.
    # app/services/pricing.py:compute_rental_breakdown). extra_fee_note —
    # необязательная короткая подпись ("Доставка + накачка SUP"), чтобы в
    # акте и в журнале изменений было видно, за что именно взяли деньги, а
    # не голая цифра — сознательно свободный текст, а не отдельный
    # справочник услуг (обсуждали — не нужен для MVP).
    extra_fee: Mapped[float] = mapped_column(Numeric(12, 2), default=0, nullable=False)
    extra_fee_note: Mapped[str | None] = mapped_column(String(200), nullable=True)


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
    # См. Equipment.after_period_days — снимок того же поля на момент
    # оформления аренды (двадцатый проход).
    after_period_days_snapshot: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Частичный возврат по позициям (41-й проход) — NULL, пока конкретная
    # единица оборудования ещё не возвращена; заполняется либо точечным
    # POST .../return-items (часть позиций аренды возвращена раньше
    # остальных — например клиент вернул палатку сегодня, а генератор
    # оставил себе ещё на неделю), либо обычным POST .../return (закрывает
    # СРАЗУ ВСЕ ещё не возвращённые позиции той же датой — см.
    # app/api/routes/rentals.py:return_rental). Оборудование освобождается
    # для новой брони сразу по факту простановки этого поля, не дожидаясь,
    # пока вернутся остальные позиции аренды (см. _find_blocking_rental) —
    # это и есть весь смысл доработки: раньше аренда занимала оборудование
    # оптом до момента, пока ПОСЛЕДНЯЯ позиция не будет закрыта.
    returned_at: Mapped[date | None] = mapped_column(Date, nullable=True)


class RentalPhoto(Base):
    """Фото состояния оборудования при выдаче/возврате (41-й проход) — то же
    хранение, что и ClientDocument (base64 в TEXT-колонке, см. её докстринг
    про отсутствие объектного хранилища в проекте), но привязано к Rental
    целиком, а не к отдельной позиции: на практике сотрудник фотографирует
    комплект как есть (например, весь груз в кузове), а не каждую единицу
    оборудования по отдельности."""

    __tablename__ = "rental_photos"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    rental_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("rentals.id", ondelete="CASCADE"), nullable=False, index=True
    )
    employee_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True
    )
    # values_callable обязателен здесь: SQLAlchemy по умолчанию хранит В БД
    # ИМЯ атрибута enum'а (.name), а не его значение (.value) — для всех
    # остальных enum'ов проекта это неразличимо, потому что там имя и
    # значение совпадают (RentalStatus.active == "active" и т.п.). У этого
    # enum'а — нет: имя атрибута return_ (return — зарезервированное слово
    # Python), а значение "return". Без values_callable в БД легла бы строка
    # "return_", которая разошлась бы с тем, что отдаёт/принимает Pydantic
    # (использует .value, то есть "return") — эндпоинты просто перестали бы
    # находить совпадение при фильтрации по stage.
    stage: Mapped[RentalPhotoStage] = mapped_column(
        Enum(RentalPhotoStage, name="rental_photo_stage", values_callable=lambda enum_cls: [e.value for e in enum_cls]),
        nullable=False,
    )
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    data_base64: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), server_default=func.now()
    )
