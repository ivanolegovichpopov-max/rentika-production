import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.deps import BusinessContext, get_business_context
from app.core.security import PasswordPolicyError, hash_password, validate_password_policy
from app.database import get_db
from app.models.business import Employee, EmployeeStatus, Position
from app.models.user import User
from app.schemas.business import EmployeeInvite, EmployeeOut, EmployeeUpdate

router = APIRouter(prefix="/businesses/{business_id}/employees", tags=["employees"])


def _require_owner(ctx: BusinessContext) -> None:
    if not ctx.full_access:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Управление сотрудниками доступно только владельцу бизнеса")


@router.get("", response_model=list[EmployeeOut])
async def list_employees(ctx: BusinessContext = Depends(get_business_context), db: Session = Depends(get_db)):
    return db.scalars(select(Employee).where(Employee.business_id == ctx.business_id)).all()


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
    return employee


@router.patch("/{employee_id}", response_model=EmployeeOut)
async def update_employee(
    employee_id: uuid.UUID,
    body: EmployeeUpdate,
    ctx: BusinessContext = Depends(get_business_context),
    db: Session = Depends(get_db),
):
    _require_owner(ctx)
    employee = db.get(Employee, employee_id)
    if employee is None or employee.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Сотрудник не найден")
    if employee.is_owner:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Нельзя изменить запись владельца бизнеса")

    if body.name is not None:
        employee.name = body.name
    if body.position_id is not None:
        position = db.get(Position, body.position_id)
        if position is None or position.business_id != ctx.business_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Указанная должность не найдена в этом бизнесе")
        employee.position_id = body.position_id
    if body.status is not None:
        employee.status = body.status

    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="update", resource="employee", resource_id=str(employee_id))
    db.commit()
    db.refresh(employee)
    return employee


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
