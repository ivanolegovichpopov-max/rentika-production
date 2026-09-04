import csv
import io
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile, status
from pydantic import EmailStr, TypeAdapter, ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.deps import BusinessContext, get_business_context
from app.core.security import PasswordPolicyError, hash_password, validate_password_policy
from app.core.clock import utcnow
from app.database import get_db
from app.models.audit import AuditLog
from app.models.business import Employee, EmployeeStatus, Position
from app.models.inventory import ClientNote, Rental, RentalPhoto
from app.models.user import User
from app.schemas.business import (
    ActivityLogEntry,
    ActivityLogPage,
    EmployeeImportResult,
    EmployeeImportRowResult,
    EmployeeInvite,
    EmployeeOut,
    EmployeeUpdate,
    EmployeeWorkloadOut,
)

router = APIRouter(prefix="/businesses/{business_id}/employees", tags=["employees"])

_EMAIL_ADAPTER = TypeAdapter(EmailStr)


def _require_owner(ctx: BusinessContext) -> None:
    if not ctx.full_access:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Управление сотрудниками доступно только владельцу бизнеса")


def _employee_out(employee: Employee, email: str | None, last_login_at=None) -> EmployeeOut:
    return EmployeeOut(
        id=employee.id,
        user_id=employee.user_id,
        name=employee.name,
        email=email,
        last_login_at=last_login_at,
        position_id=employee.position_id,
        is_owner=employee.is_owner,
        status=employee.status,
        created_at=employee.created_at,
    )


@router.get("", response_model=list[EmployeeOut])
async def list_employees(ctx: BusinessContext = Depends(get_business_context), db: Session = Depends(get_db)):
    # Список сотрудников виден всей команде (см. блок "Команда" в сайдбаре
    # дашборда) без отдельного ACL-права — просто по факту членства в
    # бизнесе, управление (invite/update/disable) отдельно защищено
    # _require_owner на мутирующих эндпоинтах ниже. Email и last_login_at —
    # исключение (64-й/65-й проходы): чужие адреса почты и время последнего
    # входа обычным сотрудникам не показываем, только владельцу/платформенному
    # админу (ctx.full_access), поэтому join с User делаем всегда (дёшево), а
    # оба поля кладём в ответ условно.
    rows = db.execute(
        select(Employee, User.email, User.last_login_at)
        .join(User, User.id == Employee.user_id)
        .where(Employee.business_id == ctx.business_id)
    ).all()
    return [
        _employee_out(employee, email if ctx.full_access else None, last_login_at if ctx.full_access else None)
        for employee, email, last_login_at in rows
    ]


@router.post("", response_model=EmployeeOut, status_code=status.HTTP_201_CREATED)
async def invite_employee(
    request: Request,
    body: EmployeeInvite,
    ctx: BusinessContext = Depends(get_business_context),
    db: Session = Depends(get_db),
):
    """Упрощённая модель приглашения: владелец сразу задаёт сотруднику email и
    временный пароль (передаёт лично, не по почте — почтовая доставка вне
    рамок текущей версии, см. PRODUCTION_ARCHITECTURE.md). Сотрудник может
    сменить пароль после первого входа через обычный profile-эндпоинт."""
    _require_owner(ctx)

    if body.position_id is not None:
        position = db.get(Position, body.position_id)
        if position is None or position.business_id != ctx.business_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Указанная должность не найдена в этом бизнесе")

    try:
        await validate_password_policy(body.temporary_password, email=body.email)
    except PasswordPolicyError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    user = db.scalar(select(User).where(User.email == body.email))
    if user is None:
        user = User(email=body.email, password_hash=hash_password(body.temporary_password))
        db.add(user)
        db.flush()
    else:
        existing_membership = db.scalar(
            select(Employee).where(Employee.business_id == ctx.business_id, Employee.user_id == user.id)
        )
        if existing_membership is not None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Этот пользователь уже сотрудник данного бизнеса")

    employee = Employee(
        business_id=ctx.business_id,
        user_id=user.id,
        name=body.name,
        position_id=body.position_id,
        # invited, а не сразу active (66-й проход) — раньше это поле
        # существовало только в модели/схемах и никогда фактически не
        # использовалось: любой приглашённый сотрудник считался активным
        # ещё до своего первого входа. Реальный переход invited -> active
        # происходит при первом успешном входе (см.
        # app/api/routes/auth.py::_activate_invited_employees) — до этого
        # get_business_context (app/core/deps.py) всё равно не пропустит
        # его ни на один business-scoped эндпоинт, так что практического
        # разрыва в доступе это не создаёт, а статус в списке "Команда"
        # честно показывает "ещё не подтвердил приглашение входом".
        status=EmployeeStatus.invited,
    )
    db.add(employee)
    log_action(
        db,
        business_id=ctx.business_id,
        user_id=ctx.user.id,
        action="invite",
        resource="employee",
        resource_id=str(user.id),
        ip_address=request.client.host if request.client else None,
    )
    db.commit()
    db.refresh(employee)
    return _employee_out(employee, body.email)


@router.patch("/{employee_id}", response_model=EmployeeOut)
async def update_employee(
    employee_id: uuid.UUID,
    body: EmployeeUpdate,
    ctx: BusinessContext = Depends(get_business_context),
    db: Session = Depends(get_db),
):
    """64-й проход добавил сюда два ранее недоступных из интерфейса сценария,
    хотя сам PATCH существовал и раньше:
    1) реальное редактирование уже нанятого сотрудника (имя/должность) —
       до этого прохода фронтенд вызывал этот эндпоинт только с status
       (кнопка "Отключить"), возможность сменить имя/должность нигде не
       была доступна пользователю, хотя тело запроса это всегда позволяло;
    2) сброс временного пароля (new_password) — раньше сменить пароль мог
       только сам сотрудник через профиль после первого входа; если он не
       смог войти вовсе (забыл/потерял временный пароль), владелец был
       бессилен.
    position_id также теперь можно явно ОБНУЛИТЬ ("Без должности") — раньше
    body.position_id is not None означало одновременно и "не трогать", и
    "снять должность нельзя", то есть очистить поле в принципе было нельзя.
    Различаем через model_fields_set (пришло ли поле в теле запроса вообще),
    а не через его значение."""
    _require_owner(ctx)
    employee = db.get(Employee, employee_id)
    if employee is None or employee.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Сотрудник не найден")
    if employee.is_owner:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Нельзя изменить запись владельца бизнеса")

    # before/after для журнала действий (65-й проход) — тот же idiom
    # "<поле>_before"/"<поле>_after", что и editDetails() в
    # RentalHistorySection.tsx на фронте (см. app/api/routes/rentals.py
    # ::edit_rental). Должность фиксируем по НАЗВАНИЮ, а не по id — id ничего
    # не скажет читающему журнал без ещё одного похода в справочник
    # должностей, а сама должность к моменту чтения журнала могла быть уже
    # переименована или удалена (title на момент правки — как раз то, что
    # тогда реально видел сотрудник).
    name_before = employee.name
    status_before = employee.status
    position_before_title = None
    if employee.position_id is not None:
        prev_position = db.get(Position, employee.position_id)
        position_before_title = prev_position.title if prev_position else None

    if body.name is not None:
        employee.name = body.name
    position_after_title = position_before_title
    if "position_id" in body.model_fields_set:
        if body.position_id is not None:
            position = db.get(Position, body.position_id)
            if position is None or position.business_id != ctx.business_id:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Указанная должность не найдена в этом бизнесе")
            employee.position_id = body.position_id
            position_after_title = position.title
        else:
            employee.position_id = None
            position_after_title = None
    if body.status is not None:
        employee.status = body.status

    change_meta: dict = {}
    if body.name is not None and body.name != name_before:
        change_meta["name_before"] = name_before
        change_meta["name_after"] = body.name
    if "position_id" in body.model_fields_set and position_after_title != position_before_title:
        change_meta["position_before"] = position_before_title
        change_meta["position_after"] = position_after_title
    if body.status is not None and body.status != status_before:
        change_meta["status_before"] = status_before.value
        change_meta["status_after"] = body.status.value

    user = db.get(User, employee.user_id)
    if body.new_password is not None:
        try:
            await validate_password_policy(body.new_password, email=user.email if user else None)
        except PasswordPolicyError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        if user is not None:
            user.password_hash = hash_password(body.new_password)
        log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="reset_password", resource="employee", resource_id=str(employee_id))

    if change_meta:
        log_action(
            db,
            business_id=ctx.business_id,
            user_id=ctx.user.id,
            action="update",
            resource="employee",
            resource_id=str(employee_id),
            meta=change_meta,
        )
    db.commit()
    db.refresh(employee)
    return _employee_out(employee, user.email if user else None, user.last_login_at if user else None)


@router.delete("/{employee_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_employee(
    employee_id: uuid.UUID, ctx: BusinessContext = Depends(get_business_context), db: Session = Depends(get_db)
):
    _require_owner(ctx)
    employee = db.get(Employee, employee_id)
    if employee is None or employee.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Сотрудник не найден")
    if employee.is_owner:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Нельзя удалить владельца бизнеса")

    employee.status = EmployeeStatus.disabled
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="disable", resource="employee", resource_id=str(employee_id))
    db.commit()


# ============================================================
# Журнал действий по всему бизнесу и сводка нагрузки команды (64-й проход) —
# по образцу rental_history (app/api/routes/rentals.py): читает существующий
# AuditLog, который и раньше писался практически на каждое действие по всему
# бэкенду, просто нигде не читался обратно владельцу бизнеса за пределами
# одной конкретной аренды. Оба эндпоинта — только для владельца/платформенного
# админа: список сотрудников виден всей команде без ACL (см. list_employees
# выше), а вот "кто что делал" и "кто сколько сделал" — это уже управление
# персоналом, та же граница, что и invite/update/disable.
# ============================================================


@router.get("/activity", response_model=ActivityLogPage)
async def employee_activity(
    ctx: BusinessContext = Depends(get_business_context),
    db: Session = Depends(get_db),
    employee_id: uuid.UUID | None = Query(default=None, description="Фильтр по одному сотруднику"),
    days: int | None = Query(
        default=None, ge=1, le=3650, description="Только события не старше N дней (как пресеты FinanceTab)"
    ),
    resource: str | None = Query(
        default=None,
        description="Фильтр по типу ресурса (66-й проход) — например 'employee', 'position', 'rental'; значения те же, что в поле resource ответа",
    ),
    action: str | None = Query(
        default=None,
        description="Фильтр по типу действия (66-й проход) — например 'create', 'update', 'delete'; значения те же, что в поле action ответа",
    ),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0, description="Пагинация (65-й проход) — сколько самых свежих записей пропустить"),
):
    _require_owner(ctx)
    filters = [AuditLog.business_id == ctx.business_id]
    if employee_id is not None:
        target = db.get(Employee, employee_id)
        if target is None or target.business_id != ctx.business_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Сотрудник не найден")
        filters.append(AuditLog.user_id == target.user_id)
    if days is not None:
        filters.append(AuditLog.created_at >= utcnow() - timedelta(days=days))
    # Фильтр по ресурсу/действию (66-й проход) — раньше журнал можно было
    # сузить только по сотруднику и периоду; при активной команде список
    # действий одного типа (например все "update_permissions" по должностям)
    # приходилось искать глазами среди всех событий подряд.
    if resource is not None:
        filters.append(AuditLog.resource == resource)
    if action is not None:
        filters.append(AuditLog.action == action)
    rows = db.execute(
        select(AuditLog, Employee.name)
        # Условие на business_id прямо в ON, не в WHERE — по той же причине,
        # что и в rental_history: один и тот же user_id может быть Employee
        # сразу в нескольких бизнесах, без этого условия LEFT JOIN задвоил бы
        # строку на каждый такой бизнес.
        .join(Employee, (Employee.user_id == AuditLog.user_id) & (Employee.business_id == ctx.business_id), isouter=True)
        .where(*filters)
        .order_by(AuditLog.created_at.desc())
        # Пагинация (65-й проход): запрашиваем на одну запись больше limit,
        # чтобы узнать has_more, не делая отдельный COUNT(*) запрос — та же
        # идея, что и "fetch limit+1" в других постраничных списках проекта.
        .offset(offset)
        .limit(limit + 1)
    ).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    return ActivityLogPage(
        items=[
            ActivityLogEntry(
                id=log.id,
                action=log.action,
                resource=log.resource,
                resource_id=log.resource_id,
                employee_name=employee_name,
                meta=log.meta,
                created_at=log.created_at,
            )
            for log, employee_name in rows
        ],
        has_more=has_more,
    )


@router.get("/workload", response_model=list[EmployeeWorkloadOut])
async def employee_workload(
    ctx: BusinessContext = Depends(get_business_context),
    db: Session = Depends(get_db),
    days: int | None = Query(
        default=None, ge=1, le=3650, description="Только события не старше N дней (как пресеты FinanceTab)"
    ),
):
    _require_owner(ctx)
    employees = db.scalars(
        select(Employee).where(Employee.business_id == ctx.business_id, Employee.status != EmployeeStatus.disabled)
    ).all()
    if not employees:
        return []

    cutoff = utcnow() - timedelta(days=days) if days is not None else None

    def _counts_by_employee(model, employee_column, since=None, until=None) -> dict[uuid.UUID, int]:
        bounds = []
        if since is not None:
            bounds.append(model.created_at >= since)
        if until is not None:
            bounds.append(model.created_at < until)
        return dict(
            db.execute(
                select(employee_column, func.count())
                .where(model.business_id == ctx.business_id, employee_column.is_not(None), *bounds)
                .group_by(employee_column)
            ).all()
        )

    rentals_by_employee = _counts_by_employee(Rental, Rental.created_by_employee_id, since=cutoff)
    notes_by_employee = _counts_by_employee(ClientNote, ClientNote.employee_id, since=cutoff)
    photos_by_employee = _counts_by_employee(RentalPhoto, RentalPhoto.employee_id, since=cutoff)

    # Сравнение с предыдущим периодом такой же длины (66-й проход) — только
    # когда клиент вообще запросил days; для "весь период" сравнивать не с
    # чем (сам период ничем не ограничен сверху). "Предыдущий" — окно [cutoff
    # - days; cutoff), сразу перед текущим, той же длины в днях.
    rentals_prev: dict[uuid.UUID, int] = {}
    notes_prev: dict[uuid.UUID, int] = {}
    photos_prev: dict[uuid.UUID, int] = {}
    if days is not None:
        prev_since = cutoff - timedelta(days=days)
        rentals_prev = _counts_by_employee(Rental, Rental.created_by_employee_id, since=prev_since, until=cutoff)
        notes_prev = _counts_by_employee(ClientNote, ClientNote.employee_id, since=prev_since, until=cutoff)
        photos_prev = _counts_by_employee(RentalPhoto, RentalPhoto.employee_id, since=prev_since, until=cutoff)

    return [
        EmployeeWorkloadOut(
            employee_id=e.id,
            employee_name=e.name,
            rentals_created=rentals_by_employee.get(e.id, 0),
            client_notes=notes_by_employee.get(e.id, 0),
            rental_photos=photos_by_employee.get(e.id, 0),
            rentals_created_prev=rentals_prev.get(e.id, 0) if days is not None else None,
            client_notes_prev=notes_prev.get(e.id, 0) if days is not None else None,
            rental_photos_prev=photos_prev.get(e.id, 0) if days is not None else None,
        )
        for e in employees
    ]


@router.post("/import", response_model=EmployeeImportResult)
async def import_employees(
    request: Request,
    file: UploadFile,
    ctx: BusinessContext = Depends(get_business_context),
    db: Session = Depends(get_db),
):
    """Упрощённый CSV-импорт сотрудников (66-й проход) — то же декодирование/
    парсинг, что import_equipment (app/api/routes/equipment.py), но
    сознательно БЕЗ редактируемого превью-грида на фронте (см.
    EmployeeImportModal.tsx): приглашение — это операция с реальными
    учётными данными (email, временный пароль), а не карточка товара,
    результат импорта и так сразу виден на вкладке "Команда", поэтому
    промежуточный шаг "поправить перед отправкой" здесь не так ценен, как
    для оборудования/клиентов, и опущен ради простоты.

    Ожидаемые колонки: email, name, temporary_password; опционально —
    position (точное название уже существующей в этом бизнесе должности,
    без учёта регистра). Незнакомое название должности — ошибка строки, а
    не молчаливое создание сотрудника без должности."""
    _require_owner(ctx)

    raw_bytes = await file.read()
    try:
        text = raw_bytes.decode("utf-8-sig")  # -sig съедает BOM, который Excel любит дописывать
    except UnicodeDecodeError:
        try:
            text = raw_bytes.decode("cp1251")  # частый экспорт из старого Excel на Windows
        except UnicodeDecodeError:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Не удалось прочитать файл — ожидается CSV в UTF-8 или Windows-1251")

    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Пустой файл или отсутствует строка заголовка")
    fieldnames = {(f or "").strip().lower() for f in reader.fieldnames}
    if "email" not in fieldnames or "name" not in fieldnames or "temporary_password" not in fieldnames:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "В заголовке файла должны быть как минимум колонки: email, name, temporary_password",
        )

    positions_by_title = {
        p.title.lower(): p for p in db.scalars(select(Position).where(Position.business_id == ctx.business_id)).all()
    }

    results: list[EmployeeImportRowResult] = []
    created_count = 0

    for row_num, raw_row in enumerate(reader, start=2):  # строка 1 — заголовок
        row = {(k or "").strip().lower(): (v or "").strip() for k, v in raw_row.items() if k}
        email = row.get("email", "")
        name = row.get("name", "")
        temporary_password = row.get("temporary_password", "")
        position_title = row.get("position", "")
        try:
            if not email:
                raise ValueError("Пустой email")
            try:
                _EMAIL_ADAPTER.validate_python(email)
            except ValidationError:
                raise ValueError(f"Некорректный email: {email}")
            if not name:
                raise ValueError("Пустое имя")
            position_id = None
            if position_title:
                position = positions_by_title.get(position_title.lower())
                if position is None:
                    raise ValueError(f"Должность «{position_title}» не найдена в этом бизнесе")
                position_id = position.id

            try:
                await validate_password_policy(temporary_password, email=email)
            except PasswordPolicyError as exc:
                raise ValueError(str(exc)) from exc

            user = db.scalar(select(User).where(User.email == email))
            if user is None:
                user = User(email=email, password_hash=hash_password(temporary_password))
                db.add(user)
                db.flush()
            else:
                existing_membership = db.scalar(
                    select(Employee).where(Employee.business_id == ctx.business_id, Employee.user_id == user.id)
                )
                if existing_membership is not None:
                    raise ValueError("Этот пользователь уже сотрудник данного бизнеса")

            employee = Employee(
                business_id=ctx.business_id,
                user_id=user.id,
                name=name,
                position_id=position_id,
                status=EmployeeStatus.invited,
            )
            db.add(employee)
            db.flush()
            db.refresh(employee)
            results.append(EmployeeImportRowResult(row=row_num, ok=True, name=name, employee=_employee_out(employee, email)))
            created_count += 1
        except ValueError as exc:
            results.append(EmployeeImportRowResult(row=row_num, ok=False, name=name or f"строка {row_num}", error=str(exc)))

    if created_count:
        log_action(
            db,
            business_id=ctx.business_id,
            user_id=ctx.user.id,
            action="import",
            resource="employee",
            resource_id=f"{created_count} сотрудников",
            ip_address=request.client.host if request.client else None,
        )
        db.commit()
    else:
        db.rollback()

    return EmployeeImportResult(total=len(results), created=created_count, failed=len(results) - created_count, results=results)
