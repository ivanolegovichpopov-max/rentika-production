import uuid
from datetime import datetime

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.models.business import BusinessStatus, EmployeeStatus, MessagingPermission, NotesMode, PermissionLevel, ResourceType


class BusinessOut(BaseModel):
    id: uuid.UUID
    name: str
    status: BusinessStatus
    notes_mode: NotesMode
    messaging_permission: MessagingPermission
    logo_url: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class BusinessLogoUpdate(BaseModel):
    # None — убрать логотип (вернуться к дефолтной марке). Ограничение длины
    # — грубый предохранитель от чрезмерно больших data: URL (на фронте файл
    # дополнительно ограничен по размеру ДО кодирования в base64, см.
    # AccountSettings.tsx) — не точный лимит именно на изображение, а защита
    # от отправки в БД произвольно огромной строки.
    logo_url: str | None = Field(default=None, max_length=2_000_000)


class PositionCreate(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    # Копировать права с уже существующей должности (66-й проход) — вместо
    # того чтобы новая должность всегда начинала с "чистого листа" (все
    # права none) и владельцу приходилось вручную выставлять их заново для
    # похожей роли. Если задано — источник должен принадлежать тому же
    # бизнесу (см. create_position), иначе 404; если не задано — прежнее
    # поведение (все права none).
    copy_permissions_from: uuid.UUID | None = None


class PermissionIn(BaseModel):
    resource: ResourceType
    level: PermissionLevel


class PositionOut(BaseModel):
    id: uuid.UUID
    title: str
    permissions: list[PermissionIn] = []
    # Ручной порядок карточек (66-й проход) — см. Position.sort_order.
    sort_order: int = 0
    # Обязательная 2FA для этой должности (66-й проход) — см. Position.require_2fa.
    require_2fa: bool = False
    # Сколько активных/приглашённых/отключённых сотрудников сейчас на этой
    # должности (66-й проход) — раньше владельцу приходилось открывать
    # "Команду" и вручную считать по фильтру, чтобы понять, можно ли
    # безопасно удалить должность или переименовать её без сюрпризов.
    employee_count: int = 0

    model_config = {"from_attributes": True}


class PositionUpdatePermissions(BaseModel):
    permissions: list[PermissionIn]


class PositionUpdate(BaseModel):
    """Переименование должности (64-й проход — раньше название задавалось
    только при создании и дальше было неизменным; DELETE на должность уже
    существовал на бэке, а PATCH на переименование — нет)."""

    title: str = Field(min_length=1, max_length=255)


class PositionReorder(BaseModel):
    """Тело запроса на ручной порядок карточек должностей (66-й проход) —
    та же механика, что EquipmentReorder (app/schemas/inventory.py):
    order — ПОЛНЫЙ список id должностей этого бизнеса в желаемом порядке,
    частичный список отклоняется (см. app/api/routes/positions.py:
    reorder_positions), чтобы непереданные должности не остались с
    "дырявым" sort_order."""

    order: list[uuid.UUID] = Field(min_length=1)


class PositionRequire2FAUpdate(BaseModel):
    require_2fa: bool


class EmployeeInvite(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=255)
    position_id: uuid.UUID | None = None
    temporary_password: str = Field(min_length=12, max_length=128)


class EmployeeOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    name: str
    # Email сотрудника (64-й проход) — раньше нигде не отдавался клиенту,
    # хотя и есть на связанном User (Employee.email на самой модели нет,
    # проставляется вручную в routes/employees.py через join с User).
    # None для всех, КРОМЕ владельца/платформенного админа (ctx.full_access)
    # — обычным сотрудникам чужие email из списка команды не показываем,
    # даже если сам список им виден (см. list_employees — он не требует
    # full_access, только валидное членство в бизнесе).
    email: str | None = None
    # Момент последнего успешного входа (65-й проход) — та же видимость, что
    # и у email выше: None для всех, КРОМЕ владельца/платформенного админа.
    # Дополнительно (в отличие от email) в принципе может быть None и для
    # владельца — это означает не "скрыто", а "сотрудник ни разу не входил"
    # (см. app/models/user.py::User.last_login_at), различать эти два случая
    # должен фронтенд по флагу видимости email/last_login_at в ответе, а не
    # по самому значению.
    last_login_at: datetime | None = None
    position_id: uuid.UUID | None
    is_owner: bool
    status: EmployeeStatus
    created_at: datetime

    model_config = {"from_attributes": True}


class EmployeeUpdate(BaseModel):
    name: str | None = None
    position_id: uuid.UUID | None = None
    status: EmployeeStatus | None = None
    # Сброс временного пароля сотруднику (64-й проход) — раньше сменить
    # пароль мог только сам сотрудник через профиль после входа; если он
    # забыл временный пароль ДО первого входа (или потерял доступ), владелец
    # был бессилен что-либо сделать. Проверяется той же политикой пароля,
    # что и при приглашении (см. update_employee).
    new_password: str | None = Field(default=None, min_length=12, max_length=128)


class ActivityLogEntry(BaseModel):
    """Одна запись общего журнала действий по бизнесу (64-й проход) — та же
    идея, что и RentalHistoryEntry (app/schemas/inventory.py), но не по
    одной аренде, а по всем ресурсам сразу: читает уже существующий
    AuditLog, который пишется практически на каждое значимое действие по
    всему бэкенду (клиенты, оборудование, аренды, сотрудники, должности,
    сообщения…), но раньше нигде не читался обратно владельцу бизнеса —
    только вручную через БД при разборе инцидентов. Владелец видит здесь
    "кто и что делал" по всей команде, не открывая каждую аренду/клиента
    по отдельности."""

    id: uuid.UUID
    action: str
    resource: str
    resource_id: str | None = None
    employee_name: str | None = None
    meta: dict | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class ActivityLogPage(BaseModel):
    """Страница журнала действий (65-й проход) — раньше /activity отдавал
    голый список максимум на limit=500 записей без какого-либо признака,
    есть ли более старые события за пределами этой страницы; при активной
    команде реальная история быстро упирается в этот потолок и хвост
    молча обрезался. has_more — есть ли ещё более старые записи ДО
    последней из items (запрашиваются следующим вызовом через offset)."""

    items: list[ActivityLogEntry]
    has_more: bool


class EmployeeWorkloadOut(BaseModel):
    """Сводка нагрузки сотрудника (64-й проход) — агрегаты по уже
    существующим полям employee_id/created_by_employee_id на Rental/
    ClientNote/ClientDocument/RentalPhoto (проставляются при создании этих
    записей уже давно, просто нигде не суммировались). НЕ подменяет журнал
    действий выше — это именно счётчики "сколько сделано", для быстрой
    сводки по команде на одном экране, без просмотра списка событий.

    *_prev (66-й проход) — те же три счётчика за ПРЕДЫДУЩИЙ период такой же
    длины, сразу перед текущим (например текущие 7 дней и предыдущие 7 дней
    до них), чтобы показать тренд "стало больше/меньше", а не голое число
    без контекста. Заполняются только когда клиент запросил days (для "весь
    период" сравнивать не с чем — сам период не ограничен) — None означает
    именно "сравнение недоступно", а не "было 0"."""

    employee_id: uuid.UUID
    employee_name: str
    rentals_created: int
    client_notes: int
    rental_photos: int
    rentals_created_prev: int | None = None
    client_notes_prev: int | None = None
    rental_photos_prev: int | None = None


class EmployeeImportRowResult(BaseModel):
    """Одна строка отчёта об импорте сотрудников из CSV (66-й проход) — тот
    же idiom, что EquipmentImportRowResult (app/schemas/inventory.py), но
    без превью-грида на фронте (см. EmployeeImportModal.tsx) — список
    приглашённых сотрудников и так виден на вкладке "Команда" сразу после
    импорта, повторно показывать его в модалке избыточно."""

    row: int
    ok: bool
    name: str
    error: str | None = None
    employee: EmployeeOut | None = None


class EmployeeImportResult(BaseModel):
    total: int
    created: int
    failed: int
    results: list[EmployeeImportRowResult]


class DashboardPrefs(BaseModel):
    """Личная настройка дашборда текущего сотрудника: какие плашки/панели
    скрыты и в каком порядке/раскладке показывать остальные. Список валидных
    id — фиксированный набор блоков дашборда на фронтенде (6 стат-плашек +
    панели, включая "panel-notes"); бэкенд сознательно не валидирует
    конкретные значения id — это непрозрачная для сервера настройка UI, а не
    бизнес-данные. Именных подписей (rename) здесь больше нет — пользователь
    попросил заменить переименование на перетаскивание блоков.

    stat_order — порядок id стат-плашек верхнего ряда (только горизонтальный
    reorder). panel_rows — раскладка панелей построчно сверху вниз, в каждой
    строке 1 или 2 id (2 id в строке = панели показаны рядом на одном уровне,
    как "Ближайшие возвраты"/"Загрузка по категориям" по умолчанию)."""

    hidden: list[str] = Field(default_factory=list, max_length=64)
    stat_order: list[str] = Field(default_factory=list, max_length=64)
    panel_rows: list[list[str]] = Field(default_factory=list, max_length=64)

    @field_validator("hidden", "stat_order")
    @classmethod
    def _cap_id_list(cls, value: list[str]) -> list[str]:
        return [str(v)[:64] for v in value][:64]

    @field_validator("panel_rows")
    @classmethod
    def _validate_panel_rows(cls, value: list[list[str]]) -> list[list[str]]:
        if len(value) > 64:
            raise ValueError("Слишком много строк раскладки панелей")
        cleaned: list[list[str]] = []
        total = 0
        for row in value:
            if not isinstance(row, list) or len(row) < 1 or len(row) > 2:
                raise ValueError("В каждой строке раскладки должно быть 1 или 2 блока")
            total += len(row)
            if total > 64:
                raise ValueError("Слишком много блоков в раскладке панелей")
            cleaned.append([str(v)[:64] for v in row])
        return cleaned


class NotesModeOut(BaseModel):
    mode: NotesMode


class NotesModeUpdate(BaseModel):
    mode: NotesMode


class NoteCreate(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


class NoteOut(BaseModel):
    id: uuid.UUID
    author_name: str
    text: str
    created_at: datetime
    done: bool = False
    # Проставляется в роуте по контексту запроса (можно ли ЭТОМУ пользователю
    # удалить ИМЕННО эту запись) — не хранится в БД, поэтому не участвует в
    # model_config from_attributes напрямую (см. app/api/routes/notes.py).
    can_delete: bool = False

    model_config = {"from_attributes": True}


class NoteUpdate(BaseModel):
    """Простая отметка "выполнено" — НЕ полноценный чек-лист/трекер задач
    (сознательно, см. UX-обзор дашборда). Кто может переключать — та же
    проверка, что и на удаление (автор записи или владелец бизнеса), см.
    app/api/routes/notes.py::update_note."""

    done: bool
