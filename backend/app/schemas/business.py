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


class PositionUpdate(BaseModel):
    """Переименование должности (64-й проход — раньше название задавалось
    только при создании и дальше было неизменным; DELETE на должность уже
    существовал на бэке, а PATCH на переименование — нет)."""

    title: str = Field(min_length=1, max_length=255)


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


class EmployeeWorkloadOut(BaseModel):
    """Сводка нагрузки сотрудника (64-й проход) — агрегаты по уже
    существующим полям employee_id/created_by_employee_id на Rental/
    ClientNote/ClientDocument/RentalPhoto (проставляются при создании этих
    записей уже давно, просто нигде не суммировались). НЕ подменяет журнал
    действий выше — это именно счётчики "сколько сделано", для быстрой
    сводки по команде на одном экране, без просмотра списка событий."""

    employee_id: uuid.UUID
    employee_name: str
    rentals_created: int
    client_notes: int
    rental_photos: int


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
