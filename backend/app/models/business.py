import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Integer, String, Text, UniqueConstraint, func
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


class NotesMode(str, enum.Enum):
    """Кто может публиковать записи в доске «Заметки/новости» дашборда
    (см. DashboardNote ниже). owner_only — пишет только владелец бизнеса,
    остальные сотрудники только читают (сценарий «новости для сотрудников»);
    everyone — писать может любой активный сотрудник бизнеса (сценарий
    «общие быстрые заметки команды»). Удалять свою запись может её автор
    всегда, любую запись — всегда владелец (модерация), независимо от режима."""

    owner_only = "owner_only"
    everyone = "everyone"


class MessagingPermission(str, enum.Enum):
    """Кто кому может писать личные сообщения (см. app/models/messaging.py).
    owner_only (по умолчанию, консервативный вариант): обычные сотрудники
    могут писать ЛС только владельцу бизнеса — друг другу переписку начать
    не могут (владелец при этом может писать всем и создавать групповые
    чаты). everyone: любой активный сотрудник может написать ЛС любому
    другому и создавать групповые чаты — открытая переписка внутри команды.
    Не путать с ACL-правом "employees" (Position/Permission) — это право
    регулирует доступ к разделу «Сотрудники» (администрирование персонала),
    а не то, кто кому может отправить сообщение."""

    owner_only = "owner_only"
    everyone = "everyone"


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
    # Режим доски "Заметки/новости" на дашборде — см. NotesMode выше. По
    # умолчанию owner_only (более консервативный вариант: ни один сотрудник
    # не может писать на общую доску, пока владелец сам не разрешит).
    notes_mode: Mapped[NotesMode] = mapped_column(
        Enum(NotesMode, name="notes_mode"), default=NotesMode.owner_only, nullable=False
    )
    # Режим личных сообщений — см. MessagingPermission выше. По умолчанию
    # owner_only — тем же консервативным принципом, что и notes_mode.
    messaging_permission: Mapped[MessagingPermission] = mapped_column(
        Enum(MessagingPermission, name="messaging_permission"),
        default=MessagingPermission.owner_only,
        nullable=False,
    )
    # Логотип бизнеса — ссылка ИЛИ data: URL (см. миграцию 0007 и
    # BusinessLogoUpdate/AccountSettings.tsx). NULL — логотип не задан.
    logo_url: Mapped[str | None] = mapped_column(Text(), nullable=True)
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
    # Ручной порядок карточек для перетаскивания в UI (66-й проход) — тот же
    # idiom, что EquipmentCategory.position/EquipmentWarehouse.position, но
    # названо sort_order, а не "position": "position" на этой модели уже
    # означает саму должность, Position.position читалось бы двусмысленно.
    # НЕ уникально и НЕ обязательно плотное — см. _apply_position_reorder в
    # app/api/routes/positions.py.
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Обязательная двухфакторная аутентификация для этой должности (66-й
    # проход) — сотрудник с такой должностью и без включённой 2FA не получит
    # доступа ни к одному business-scoped эндпоинту, пока не включит 2FA в
    # профиле (см. проверку в app/core/deps.py::get_business_context). Не
    # распространяется на владельца бизнеса (у него нет position_id) и на
    # платформенного админа.
    require_2fa: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Цвет карточки должности (67-й проход, обзор страницы «Сотрудники») —
    # один из фиксированных ключей палитры на фронте (см. POSITION_COLORS в
    # lib/format.ts), а не произвольный hex: так бейджи должности везде в
    # интерфейсе (карточка должности, строка в "Команде", реверс-матрица)
    # красятся одной и той же готовой парой фон/текст, без риска, что
    # владелец подберёт нечитаемое сочетание. NULL — цвет не задан, в UI
    # используется нейтральный серый.
    color: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # Короткое описание обязанностей должности (67-й проход) — раньше у
    # должности было только название, без пояснения, что за роль и чем
    # занимается человек с ней; чисто информационное поле, ни на что не
    # влияет технически.
    description: Mapped[str | None] = mapped_column(Text(), nullable=True)
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
    # Телефон сотрудника (67-й проход) — раньше единственным контактом в
    # карточке был email; если человек не отвечает на почту, дозвониться
    # через CRM было нечем. Свободный текст, не валидируется строгим
    # форматом (номера бывают разных стран/форматов записи), видимость та
    # же, что у email/last_login_at — только владельцу/платформенному
    # админу (см. _employee_out в app/api/routes/employees.py).
    phone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Заметки о сотруднике (67-й проход) — тот же смысл, что ClientNote у
    # клиента, но проще: одно текстовое поле, а не лента отдельных записей
    # (для сотрудника это не так критично — карточку правит только
    # владелец, конкурентное редактирование не сценарий). Видно ТОЛЬКО
    # владельцу/платформенному админу — вообще не отдаётся самому
    # сотруднику и остальной команде ни при каких обстоятельствах.
    notes: Mapped[str | None] = mapped_column(Text(), nullable=True)
    # Фото сотрудника (67-й проход) — тот же idiom, что Business.logo_url:
    # data: URL, закодированный на фронте до отправки (см. компонент
    # загрузки фото в EditEmployeeModal.tsx), а не файл на диске/в
    # object-storage. NULL — фото не задано, в UI показываются инициалы.
    photo_url: Mapped[str | None] = mapped_column(Text(), nullable=True)
    # Личная настройка дашборда (какие плашки/панели скрыты, их переименованные
    # подписи) — JSON-строка {"hidden": [...], "labels": {...}}, см.
    # app/schemas/business.py::DashboardPrefs. Хранится per-Employee (то есть
    # per-человек в КОНКРЕТНОМ бизнесе), а не на User — один и тот же человек
    # может работать в нескольких бизнесах и настраивать дашборд каждого
    # по-своему. NULL = настроек ещё нет, используются значения по умолчанию.
    dashboard_prefs: Mapped[str | None] = mapped_column(Text(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (UniqueConstraint("business_id", "user_id", name="uq_employee_business_user"),)


class DashboardNote(Base):
    """Одна запись в доске «Заметки/новости» на дашборде — см. NotesMode на
    Business. Сознательно НЕ единое перезаписываемое поле (риск потери данных
    при одновременном редактировании двумя сотрудниками — last-write-wins), а
    лента отдельных записей: каждая новая запись не затирает предыдущие, и
    несколько человек могут писать одновременно без конфликтов. author_name —
    снимок имени сотрудника на момент публикации (не JOIN на Employee.name),
    чтобы запись оставалась читаемой, даже если сотрудника позже переименуют
    или отключат."""

    __tablename__ = "dashboard_notes"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    employee_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("employees.id", ondelete="CASCADE"), nullable=False
    )
    author_name: Mapped[str] = mapped_column(String(255), nullable=False)
    text: Mapped[str] = mapped_column(Text(), nullable=False)
    # Простая отметка "выполнено" — НЕ полноценный чек-лист/трекер задач
    # (сознательно, см. UX-обзор дашборда). Переключать может тот же, кому
    # доступно удаление записи (автор или владелец бизнеса) — см.
    # app/api/routes/notes.py.
    done: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
