import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.deps import BusinessContext, get_business_context
from app.database import get_db
from app.models.business import Permission, Position, PermissionLevel, ResourceType
from app.schemas.business import PositionCreate, PositionOut, PositionUpdate, PositionUpdatePermissions

router = APIRouter(prefix="/businesses/{business_id}/positions", tags=["positions"])


def _require_owner(ctx: BusinessContext) -> None:
    # Управление должностями и правами — только владелец бизнеса (или платформенный
    # админ). Это НЕ то же самое, что require_permission(employees, edit) —
    # право "редактировать сотрудников" не должно само по себе давать право
    # менять ACL-матрицу всех должностей, иначе сотрудник с edit на employees
    # мог бы выдать себе edit на finance.
    if not ctx.full_access:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Управление должностями доступно только владельцу бизнеса")


@router.get("", response_model=list[PositionOut])
async def list_positions(ctx: BusinessContext = Depends(get_business_context), db: Session = Depends(get_db)):
    positions = db.scalars(select(Position).where(Position.business_id == ctx.business_id)).all()
    result = []
    for p in positions:
        perms = db.scalars(select(Permission).where(Permission.position_id == p.id)).all()
        result.append(PositionOut(id=p.id, title=p.title, permissions=[{"resource": x.resource, "level": x.level} for x in perms]))
    return result


@router.post("", response_model=PositionOut, status_code=status.HTTP_201_CREATED)
async def create_position(
    body: PositionCreate, ctx: BusinessContext = Depends(get_business_context), db: Session = Depends(get_db)
):
    _require_owner(ctx)
    position = Position(business_id=ctx.business_id, title=body.title)
    db.add(position)
    db.flush()
    # Все права по умолчанию — "none": явные строки не нужны (см.
    # get_effective_permission — отсутствие строки трактуется как none), но
    # заводим их сразу, чтобы UI сразу показывал полную матрицу ресурсов.
    for resource in ResourceType:
        db.add(Permission(position_id=position.id, resource=resource, level=PermissionLevel.none))
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="create", resource="position", resource_id=str(position.id))
    db.commit()
    return PositionOut(id=position.id, title=position.title, permissions=[])


@router.patch("/{position_id}", response_model=PositionOut)
async def rename_position(
    position_id: uuid.UUID,
    body: PositionUpdate,
    ctx: BusinessContext = Depends(get_business_context),
    db: Session = Depends(get_db),
):
    """Переименование должности (64-й проход) — раньше название задавалось
    только один раз при создании (PositionCreate) и дальше было неизменным
    ни на бэке, ни на фронте; при этом права (PUT .../permissions) и
    удаление (DELETE ниже) редактировать уже умели. UniqueConstraint
    business_id+title — при конфликте отдаём то же читаемое 400, что и на
    создании должности с уже занятым названием (см. create_position выше,
    где сама ошибка ловится на уровне БД, а не заранее)."""
    _require_owner(ctx)
    position = db.get(Position, position_id)
    if position is None or position.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Должность не найдена")

    title_before = position.title
    position.title = body.title
    log_action(
        db,
        business_id=ctx.business_id,
        user_id=ctx.user.id,
        action="rename",
        resource="position",
        resource_id=str(position_id),
        # title_before/title_after — тот же idiom "<поле>_before"/"<поле>_after",
        # что и editDetails() в RentalHistorySection.tsx на фронте, чтобы
        # журнал действий сотрудников мог показать "было → стало", а не
        # только факт переименования без деталей.
        meta={"title_before": title_before, "title_after": body.title} if title_before != body.title else None,
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Должность с таким названием уже существует")

    perms = db.scalars(select(Permission).where(Permission.position_id == position_id)).all()
    return PositionOut(id=position.id, title=position.title, permissions=[{"resource": x.resource, "level": x.level} for x in perms])


@router.put("/{position_id}/permissions", response_model=PositionOut)
async def update_permissions(
    position_id: uuid.UUID,
    body: PositionUpdatePermissions,
    ctx: BusinessContext = Depends(get_business_context),
    db: Session = Depends(get_db),
):
    _require_owner(ctx)
    position = db.get(Position, position_id)
    if position is None or position.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Должность не найдена")

    for item in body.permissions:
        perm = db.scalar(
            select(Permission).where(Permission.position_id == position_id, Permission.resource == item.resource)
        )
        if perm:
            perm.level = item.level
        else:
            db.add(Permission(position_id=position_id, resource=item.resource, level=item.level))

    log_action(
        db,
        business_id=ctx.business_id,
        user_id=ctx.user.id,
        action="update_permissions",
        resource="position",
        resource_id=str(position_id),
        meta={"permissions": [p.model_dump(mode="json") for p in body.permissions]},
    )
    db.commit()

    perms = db.scalars(select(Permission).where(Permission.position_id == position_id)).all()
    return PositionOut(id=position.id, title=position.title, permissions=[{"resource": x.resource, "level": x.level} for x in perms])


@router.delete("/{position_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_position(
    position_id: uuid.UUID, ctx: BusinessContext = Depends(get_business_context), db: Session = Depends(get_db)
):
    _require_owner(ctx)
    position = db.get(Position, position_id)
    if position is None or position.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Должность не найдена")
    db.delete(position)
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="delete", resource="position", resource_id=str(position_id))
    db.commit()
