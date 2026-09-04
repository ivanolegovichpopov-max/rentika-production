import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.deps import BusinessContext, get_business_context
from app.core.security import PasswordPolicyError, hash_password, validate_password_policy
from app.database import get_db
from app.models.audit import AuditLog
from app.models.business import Employee, EmployeeStatus, Position
from app.models.inventory import ClientNote, Rental, RentalPhoto
from app.models.user import User
from app.schemas.business import (
    ActivityLogEntry,
    EmployeeInvite,
    EmployeeOut,
    EmployeeUpdate,
    EmployeeWorkloadOut,
)

router = APIRouter(prefix="/businesses/{business_id}/employees", tags=["employees"])


def _require_owner(ctx: BusinessContext) -> None:
    if not ctx.full_access:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Управление сотрудниками доступно только владельцу бизнеса")


def _employee_out(employee: Employee, email: str | None) -> EmployeeOut:
    return EmployeeOut(
        id=employee.id,
        user_id=employee.user_id,
        name=employee.name,
        email=email,
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
    # _require_owner на мутирующих эндпоинтах ниже. Email — исключение
    # (64-й проход): чужие адреса почты обычным сотрудникам не показываем,
    # только владельцу/платформенному админу (ctx.full_access), поэтому
    # join с User делаем всегда (дёшево), а email кладём в ответ условно.
    rows = db.execute(
        select(Employee, User.email).join(User, User.id == Employee.user_id).where(Employee.business_id == ctx.business_id)
    ).all()
    return [_employee_out(employee, email if ctx.full_access else None) for employee, email in rows]


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
        status=EmployeeStatus.active,
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

    if body.name is not None:
        employee.name = body.name
    if "position_id" in body.model_fields_set:
        if body.position_id is not None:
            position = db.get(Position, body.position_id)
            if position is None or position.business_id != ctx.business_id:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Указанная должность не найдена в этом бизнесе")
            employee.position_id = body.position_id
        else:
            employee.position_id = None
    if body.status is not None:
        employee.status = body.status

    user = db.get(User, employee.user_id)
    if body.new_password is not None:
        try:
            await validate_password_policy(body.new_password, email=user.email if user else None)
        except PasswordPolicyError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        if user is not None:
            user.password_hash = hash_password(body.new_password)
        log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="reset_password", resource="employee", resource_id=str(employee_id))

    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="update", resource="employee", resource_id=str(employee_id))
    db.commit()
    db.refresh(employee)
    return _employee_out(employee, user.email if user else None)


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


@router.get("/activity", response_model=list[ActivityLogEntry])
async def employee_activity(
    ctx: BusinessContext = Depends(get_business_context),
    db: Session = Depends(get_db),
    employee_id: uuid.UUID | None = Query(default=None, description="Фильтр по одному сотруднику"),
    limit: int = Query(default=100, ge=1, le=500),
):
    _require_owner(ctx)
    filters = [AuditLog.business_id == ctx.business_id]
    if employee_id is not None:
        target = db.get(Employee, employee_id)
        if target is None or target.business_id != ctx.business_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Сотрудник не найден")
        filters.append(AuditLog.user_id == target.user_id)
    rows = db.execute(
        select(AuditLog, Employee.name)
        # Условие на business_id прямо в ON, не в WHERE — по той же причине,
        # что и в rental_history: один и тот же user_id может быть Employee
        # сразу в нескольких бизнесах, без этого условия LEFT JOIN задвоил бы
        # строку на каждый такой бизнес.
        .join(Employee, (Employee.user_id == AuditLog.user_id) & (Employee.business_id == ctx.business_id), isouter=True)
        .where(*filters)
        .order_by(AuditLog.created_at.desc())
        .limit(limit)
    ).all()
    return [
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
    ]


@router.get("/workload", response_model=list[EmployeeWorkloadOut])
async def employee_workload(ctx: BusinessContext = Depends(get_business_context), db: Session = Depends(get_db)):
    _require_owner(ctx)
    employees = db.scalars(
        select(Employee).where(Employee.business_id == ctx.business_id, Employee.status != EmployeeStatus.disabled)
    ).all()
    if not employees:
        return []

    rentals_by_employee = dict(
        db.execute(
            select(Rental.created_by_employee_id, func.count())
            .where(Rental.business_id == ctx.business_id, Rental.created_by_employee_id.is_not(None))
            .group_by(Rental.created_by_employee_id)
        ).all()
    )
    notes_by_employee = dict(
        db.execute(
            select(ClientNote.employee_id, func.count())
            .where(ClientNote.business_id == ctx.business_id, ClientNote.employee_id.is_not(None))
            .group_by(ClientNote.employee_id)
        ).all()
    )
    photos_by_employee = dict(
        db.execute(
            select(RentalPhoto.employee_id, func.count())
            .where(RentalPhoto.business_id == ctx.business_id, RentalPhoto.employee_id.is_not(None))
            .group_by(RentalPhoto.employee_id)
        ).all()
    )

    return [
        EmployeeWorkloadOut(
            employee_id=e.id,
            employee_name=e.name,
            rentals_created=rentals_by_employee.get(e.id, 0),
            client_notes=notes_by_employee.get(e.id, 0),
            rental_photos=photos_by_employee.get(e.id, 0),
        )
        for e in employees
    ]
