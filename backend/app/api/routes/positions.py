import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.deps import BusinessContext, get_business_context
from app.database import get_db
from app.models.business import Employee, Permission, Position, PermissionLevel, ResourceType
from app.schemas.business import (
    PositionCopyPermissions,
    PositionCreate,
    PositionOut,
    PositionRequire2FAUpdate,
    PositionReorder,
    PositionUpdate,
    PositionUpdatePermissions,
)

router = APIRouter(prefix="/businesses/{business_id}/positions", tags=["positions"])


def _require_owner(ctx: BusinessContext) -> None:
    # Управление должностями и правами — только владелец бизнеса (или платформенный
    # админ). Это НЕ то же самое, что require_permission(employees, edit) —
    # право "редактировать сотрудников" не должно само по себе давать право
    # менять ACL-матрицу всех должностей, иначе сотрудник с edit на employees
    # мог бы выдать себе edit на finance.
    if not ctx.full_access:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Управление должностями доступно только владельцу бизнеса")


def _employee_counts(db: Session, business_id: uuid.UUID) -> dict[uuid.UUID, int]:
    """Число сотрудников на каждой должности бизнеса (66-й проход) — одним
    групповым запросом, чтобы не считать COUNT по одному на должность."""
    return dict(
        db.execute(
            select(Employee.position_id, func.count(Employee.id))
            .where(Employee.business_id == business_id, Employee.position_id.isnot(None))
            .group_by(Employee.position_id)
        ).all()
    )


def _position_out(db: Session, position: Position, employee_count: int) -> PositionOut:
    perms = db.scalars(select(Permission).where(Permission.position_id == position.id)).all()
    return PositionOut(
        id=position.id,
        title=position.title,
        permissions=[{"resource": x.resource, "level": x.level} for x in perms],
        sort_order=position.sort_order,
        require_2fa=position.require_2fa,
        employee_count=employee_count,
        color=position.color,
        description=position.description,
    )


@router.get("", response_model=list[PositionOut])
async def list_positions(ctx: BusinessContext = Depends(get_business_context), db: Session = Depends(get_db)):
    positions = db.scalars(
        select(Position).where(Position.business_id == ctx.business_id).order_by(Position.sort_order, Position.title)
    ).all()
    counts = _employee_counts(db, ctx.business_id)
    return [_position_out(db, p, counts.get(p.id, 0)) for p in positions]


@router.post("", response_model=PositionOut, status_code=status.HTTP_201_CREATED)
async def create_position(
    body: PositionCreate, ctx: BusinessContext = Depends(get_business_context), db: Session = Depends(get_db)
):
    _require_owner(ctx)
    existing = db.scalars(select(Position).where(Position.business_id == ctx.business_id)).all()
    # Новая карточка — в конец списка по текущему ручному порядку, не по
    # алфавиту/дате создания (см. Position.sort_order).
    next_sort_order = (max((p.sort_order for p in existing), default=-1)) + 1
    position = Position(
        business_id=ctx.business_id,
        title=body.title,
        sort_order=next_sort_order,
        color=body.color,
        description=body.description,
    )
    db.add(position)
    db.flush()

    source_perms: dict[ResourceType, PermissionLevel] = {}
    if body.copy_permissions_from is not None:
        # Копирование прав с существующей должности (66-й проход) — источник
        # обязан принадлежать этому же бизнесу, иначе владелец одного
        # бизнеса теоретически мог бы угадать id чужой должности и узнать её
        # матрицу прав по факту успешного/неуспешного ответа.
        source = db.get(Position, body.copy_permissions_from)
        if source is None or source.business_id != ctx.business_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Должность-источник для копирования прав не найдена")
        source_perms = {
            row.resource: row.level
            for row in db.scalars(select(Permission).where(Permission.position_id == source.id)).all()
        }

    # Права по умолчанию — "none", либо скопированные у source_perms (см.
    # выше); явные строки не обязательны (см. get_effective_permission —
    # отсутствие строки трактуется как none), но заводим их сразу, чтобы UI
    # сразу показывал полную матрицу ресурсов.
    for resource in ResourceType:
        db.add(Permission(position_id=position.id, resource=resource, level=source_perms.get(resource, PermissionLevel.none)))
    log_action(
        db,
        business_id=ctx.business_id,
        user_id=ctx.user.id,
        action="create",
        resource="position",
        resource_id=str(position.id),
        meta={"copied_permissions_from": str(body.copy_permissions_from)} if body.copy_permissions_from else None,
    )
    db.commit()
    return _position_out(db, position, 0)


@router.post("/reorder", response_model=list[PositionOut])
async def reorder_positions(
    body: PositionReorder, ctx: BusinessContext = Depends(get_business_context), db: Session = Depends(get_db)
):
    """Ручной порядок карточек должностей (66-й проход) — та же механика,
    что reorder_equipment_categories/warehouses (app/api/routes/equipment.py:
    _apply_reorder), но со своей копией здесь: атрибут порядка называется
    sort_order, а не position, и модель — Position, не одна из моделей
    inventory.py, так что общий helper не переиспользуется напрямую."""
    _require_owner(ctx)
    rows = db.scalars(select(Position).where(Position.business_id == ctx.business_id)).all()
    by_id = {row.id: row for row in rows}
    order_ids = list(dict.fromkeys(body.order))  # де-дуп, сохраняя порядок — на случай случайного дубля в теле запроса
    if set(order_ids) != set(by_id.keys()):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Список должен содержать все должности этого бизнеса ровно по одному разу, без пропусков.",
        )
    for sort_order, position_id in enumerate(order_ids):
        by_id[position_id].sort_order = sort_order
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="reorder", resource="position")
    db.commit()

    positions = db.scalars(
        select(Position).where(Position.business_id == ctx.business_id).order_by(Position.sort_order, Position.title)
    ).all()
    counts = _employee_counts(db, ctx.business_id)
    return [_position_out(db, p, counts.get(p.id, 0)) for p in positions]


@router.patch("/{position_id}", response_model=PositionOut)
async def update_position(
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
    где сама ошибка ловится на уровне БД, а не заранее).

    67-й проход добавил сюда независимо изменяемые color/description —
    каждое поле применяется, только если реально пришло в теле запроса
    (см. model_fields_set), поэтому можно прислать один только цвет или
    одно только описание, не трогая остальное. Название действия в журнале
    сохраняем "rename", если title изменился (совместимость с фильтром
    action=rename и существующими тестами/данными) — и новое "update",
    когда меняются ТОЛЬКО color/description без title."""
    _require_owner(ctx)
    position = db.get(Position, position_id)
    if position is None or position.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Должность не найдена")

    title_before = position.title
    color_before = position.color
    description_before = position.description

    fields = body.model_fields_set
    if "title" in fields and body.title is not None:
        position.title = body.title
    if "color" in fields:
        position.color = body.color
    if "description" in fields:
        position.description = body.description

    change_meta: dict = {}
    if position.title != title_before:
        change_meta["title_before"] = title_before
        change_meta["title_after"] = position.title
    if position.color != color_before:
        change_meta["color_before"] = color_before
        change_meta["color_after"] = position.color
    if position.description != description_before:
        change_meta["description_before"] = description_before
        change_meta["description_after"] = position.description

    if change_meta:
        log_action(
            db,
            business_id=ctx.business_id,
            user_id=ctx.user.id,
            action="rename" if "title_before" in change_meta else "update",
            resource="position",
            resource_id=str(position_id),
            meta=change_meta,
        )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Должность с таким названием уже существует")

    counts = _employee_counts(db, ctx.business_id)
    return _position_out(db, position, counts.get(position.id, 0))


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

    # before/after по каждому ИЗМЕНИВШЕМУСЯ ресурсу (66-й проход) — раньше
    # meta хранила только полный список permissions ПОСЛЕ изменения, без
    # прежних значений, так что журнал действий не мог показать "было →
    # стало" для этого действия, в отличие от rename_position/update_employee
    # (см. тот же idiom "<поле>_before"/"<поле>_after" там).
    before_levels = {
        row.resource: row.level
        for row in db.scalars(select(Permission).where(Permission.position_id == position_id)).all()
    }
    changes = []
    for item in body.permissions:
        perm = db.scalar(
            select(Permission).where(Permission.position_id == position_id, Permission.resource == item.resource)
        )
        prev_level = before_levels.get(item.resource, PermissionLevel.none)
        if prev_level != item.level:
            changes.append({"resource": item.resource.value, "level_before": prev_level.value, "level_after": item.level.value})
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
        meta={"changes": changes} if changes else None,
    )
    db.commit()

    counts = _employee_counts(db, ctx.business_id)
    return _position_out(db, position, counts.get(position.id, 0))


@router.post("/{position_id}/copy-permissions", response_model=PositionOut)
async def copy_permissions(
    position_id: uuid.UUID,
    body: PositionCopyPermissions,
    ctx: BusinessContext = Depends(get_business_context),
    db: Session = Depends(get_db),
):
    """Скопировать матрицу прав с другой должности на уже существующую
    (67-й проход) — та же логика копирования, что и copy_permissions_from
    при СОЗДАНИИ должности (см. create_position), но применимая к уже
    заведённой карточке: если "эталонная" должность позже поменяла права,
    применить их на другую должность одной кнопкой, а не вручную ресурс за
    ресурсом через обычную матрицу."""
    _require_owner(ctx)
    position = db.get(Position, position_id)
    if position is None or position.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Должность не найдена")
    if body.source_position_id == position_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Нельзя скопировать права должности на саму себя")
    source = db.get(Position, body.source_position_id)
    if source is None or source.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Должность-источник для копирования прав не найдена")

    source_levels = {
        row.resource: row.level
        for row in db.scalars(select(Permission).where(Permission.position_id == source.id)).all()
    }
    before_levels = {
        row.resource: row.level
        for row in db.scalars(select(Permission).where(Permission.position_id == position_id)).all()
    }
    changes = []
    for resource in ResourceType:
        new_level = source_levels.get(resource, PermissionLevel.none)
        prev_level = before_levels.get(resource, PermissionLevel.none)
        if prev_level != new_level:
            changes.append({"resource": resource.value, "level_before": prev_level.value, "level_after": new_level.value})
        perm = db.scalar(select(Permission).where(Permission.position_id == position_id, Permission.resource == resource))
        if perm:
            perm.level = new_level
        else:
            db.add(Permission(position_id=position_id, resource=resource, level=new_level))

    log_action(
        db,
        business_id=ctx.business_id,
        user_id=ctx.user.id,
        action="copy_permissions",
        resource="position",
        resource_id=str(position_id),
        meta={"source_position_id": str(source.id), "source_title": source.title, "changes": changes} if changes else None,
    )
    db.commit()

    counts = _employee_counts(db, ctx.business_id)
    return _position_out(db, position, counts.get(position.id, 0))


@router.patch("/{position_id}/require-2fa", response_model=PositionOut)
async def update_require_2fa(
    position_id: uuid.UUID,
    body: PositionRequire2FAUpdate,
    ctx: BusinessContext = Depends(get_business_context),
    db: Session = Depends(get_db),
):
    """Включение/выключение обязательной 2FA для должности (66-й проход) —
    см. Position.require_2fa и проверку в app/core/deps.py::get_business_context.
    Отдельный PATCH, а не часть update_permissions/rename_position — это не
    ACL-право и не название, а отдельная политика безопасности должности,
    и владелец должен иметь возможность включить/выключить её, не трогая
    остальное."""
    _require_owner(ctx)
    position = db.get(Position, position_id)
    if position is None or position.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Должность не найдена")

    require_2fa_before = position.require_2fa
    position.require_2fa = body.require_2fa
    log_action(
        db,
        business_id=ctx.business_id,
        user_id=ctx.user.id,
        action="update_require_2fa",
        resource="position",
        resource_id=str(position_id),
        meta={"require_2fa_before": require_2fa_before, "require_2fa_after": body.require_2fa}
        if require_2fa_before != body.require_2fa
        else None,
    )
    db.commit()

    counts = _employee_counts(db, ctx.business_id)
    return _position_out(db, position, counts.get(position.id, 0))


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
