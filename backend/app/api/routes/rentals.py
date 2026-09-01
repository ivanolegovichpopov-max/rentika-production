import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.deps import BusinessContext, require_permission
from app.database import get_db
from app.models.business import PermissionLevel, ResourceType
from app.models.inventory import Client, Equipment, EquipmentStatus, Rental, RentalItem, RentalStatus
from app.schemas.inventory import RentalCreate, RentalEdit, RentalIssue, RentalOut, RentalReturn
from app.services.pricing import compute_rental_breakdown, item_cost_for_days, span_days

router = APIRouter(prefix="/businesses/{business_id}/rentals", tags=["rentals"])

view_dep = require_permission(ResourceType.rentals, PermissionLevel.view)
edit_dep = require_permission(ResourceType.rentals, PermissionLevel.edit)

# Дефолтные тексты состояния — 1-в-1 из демо-прототипа: это значения по
# умолчанию соответствующих <textarea> в формах "Выдать оборудование" /
# "Принять возврат" (см. claude/oborot-crm-prototype.html:issueRentalForm/
# returnRentalForm), подставляются, когда сотрудник не поменял текст поля.
DEFAULT_ISSUE_NOTES = "Комплектация полная, состояние исправное."
DEFAULT_RETURN_NOTES = "Без повреждений, комплектация полная."


def _to_out(db: Session, rental: Rental) -> RentalOut:
    items = db.scalars(select(RentalItem).where(RentalItem.rental_id == rental.id)).all()

    breakdown = compute_rental_breakdown(
        items=[
            {
                "daily_rate": float(it.daily_rate_snapshot),
                "period_days": it.period_days_snapshot,
                "period_price": float(it.period_price_snapshot) if it.period_price_snapshot is not None else None,
                "period_price_after": float(it.period_price_after_snapshot)
                if it.period_price_after_snapshot is not None
                else None,
                "after_period_days": it.after_period_days_snapshot,
            }
            for it in items
        ],
        start_date=rental.start_date,
        end_date=rental.end_date,
        actual_return=rental.actual_return,
        today=date.today(),
        damage_fee=float(rental.damage_fee),
        discount=float(rental.discount),
    )

    # deposit_total читается "вживую" из текущего Equipment.deposit — снимка
    # залога на момент бронирования эта схема БД не хранит (см. RentalOut).
    deposit_total = 0.0
    for it in items:
        equipment = db.get(Equipment, it.equipment_id)
        if equipment is not None:
            deposit_total += float(equipment.deposit)

    return RentalOut(
        id=rental.id,
        client_id=rental.client_id,
        start_date=rental.start_date,
        end_date=rental.end_date,
        actual_return=rental.actual_return,
        status=rental.status,
        damage_fee=float(rental.damage_fee),
        discount=float(rental.discount),
        issue_notes=rental.issue_notes,
        return_notes=rental.return_notes,
        created_at=rental.created_at,
        planned_days=breakdown["planned_days"],
        actual_days=breakdown["actual_days"],
        late_days=breakdown["late_days"],
        base=breakdown["base"],
        late_fee=breakdown["late_fee"],
        total=breakdown["total"],
        amount=breakdown["total"],
        deposit_total=deposit_total,
        items=items,
    )


@router.get("", response_model=list[RentalOut])
async def list_rentals(ctx: BusinessContext = Depends(view_dep), db: Session = Depends(get_db)):
    rentals = db.scalars(select(Rental).where(Rental.business_id == ctx.business_id)).all()
    return [_to_out(db, r) for r in rentals]


@router.post("", response_model=RentalOut, status_code=status.HTTP_201_CREATED)
async def create_rental(body: RentalCreate, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)):
    if body.end_date < body.start_date:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Дата окончания раньше даты начала")

    # deleted_at is not None — клиент/позиция в корзине (29-й проход, см.
    # app/services/trash.py): для НОВОЙ аренды это тот же случай, что и
    # "не найден" — трогать спрятанные записи можно только через
    # POST .../restore, не заводя на них новые обязательства.
    client = db.get(Client, body.client_id)
    if client is None or client.business_id != ctx.business_id or client.deleted_at is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Клиент не найден в этом бизнесе")

    items_data = []
    for eq_id in body.equipment_ids:
        equipment = db.get(Equipment, eq_id)
        if equipment is None or equipment.business_id != ctx.business_id or equipment.deleted_at is not None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Оборудование {eq_id} не найдено в этом бизнесе")
        if equipment.status not in (EquipmentStatus.available,):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"«{equipment.name}» сейчас недоступно (статус: {equipment.status.value})")
        items_data.append(equipment)

    # 25-й проход, п.7: если скидка не передана явно телом запроса — подставляем
    # её сами из клиентской умолчательной default_discount_percent (ПОДСКАЗКА,
    # не жёсткая привязка — дальше это обычная Rental.discount в рублях,
    # которую можно менять как любую другую, скидка клиента при этом не
    # трогается). Явно переданное значение (в том числе 0) всегда в приоритете.
    if body.discount is not None:
        discount = body.discount
    elif client.default_discount_percent:
        planned_days = span_days(body.start_date, body.end_date)
        base_cost = sum(
            item_cost_for_days(
                daily_rate=float(eq.daily_rate),
                days=planned_days,
                period_days=eq.period_days,
                period_price=float(eq.period_price) if eq.period_price is not None else None,
                period_price_after=float(eq.period_price_after) if eq.period_price_after is not None else None,
                after_period_days=eq.after_period_days,
            )
            for eq in items_data
        )
        discount = round(base_cost * float(client.default_discount_percent) / 100)
    else:
        discount = 0

    rental = Rental(
        business_id=ctx.business_id,
        client_id=body.client_id,
        start_date=body.start_date,
        end_date=body.end_date,
        status=RentalStatus.booked if body.start_date > date.today() else RentalStatus.active,
        created_by_employee_id=ctx.employee.id if ctx.employee else None,
        discount=discount,
    )
    db.add(rental)
    db.flush()

    for equipment in items_data:
        db.add(
            RentalItem(
                rental_id=rental.id,
                equipment_id=equipment.id,
                daily_rate_snapshot=equipment.daily_rate,
                period_days_snapshot=equipment.period_days,
                period_price_snapshot=equipment.period_price,
                period_price_after_snapshot=equipment.period_price_after,
                after_period_days_snapshot=equipment.after_period_days,
            )
        )
        if rental.status == RentalStatus.active:
            equipment.status = EquipmentStatus.rented

    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="create", resource="rental", resource_id=str(rental.id))
    db.commit()
    db.refresh(rental)
    return _to_out(db, rental)


def _get_rental_or_404(db: Session, ctx: BusinessContext, rental_id: uuid.UUID) -> Rental:
    rental = db.get(Rental, rental_id)
    if rental is None or rental.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Аренда не найдена")
    return rental


@router.post("/{rental_id}/issue", response_model=RentalOut)
async def issue_rental(
    rental_id: uuid.UUID,
    body: RentalIssue | None = None,
    ctx: BusinessContext = Depends(edit_dep),
    db: Session = Depends(get_db),
):
    """Забронировано → выдано (в работе)."""
    rental = _get_rental_or_404(db, ctx, rental_id)
    if rental.status != RentalStatus.booked:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Выдать можно только бронь")
    rental.status = RentalStatus.active
    rental.issue_notes = (body.issue_notes if body and body.issue_notes else None) or DEFAULT_ISSUE_NOTES
    for it in db.scalars(select(RentalItem).where(RentalItem.rental_id == rental.id)):
        equipment = db.get(Equipment, it.equipment_id)
        if equipment:
            equipment.status = EquipmentStatus.rented
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="issue", resource="rental", resource_id=str(rental_id))
    db.commit()
    db.refresh(rental)
    return _to_out(db, rental)


@router.post("/{rental_id}/cancel", response_model=RentalOut)
async def cancel_rental(rental_id: uuid.UUID, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)):
    rental = _get_rental_or_404(db, ctx, rental_id)
    if rental.status not in (RentalStatus.booked, RentalStatus.active):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Эту аренду нельзя отменить в текущем статусе")
    rental.status = RentalStatus.cancelled
    for it in db.scalars(select(RentalItem).where(RentalItem.rental_id == rental.id)):
        equipment = db.get(Equipment, it.equipment_id)
        if equipment and equipment.status == EquipmentStatus.rented:
            equipment.status = EquipmentStatus.available
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="cancel", resource="rental", resource_id=str(rental_id))
    db.commit()
    db.refresh(rental)
    return _to_out(db, rental)


@router.post("/{rental_id}/return", response_model=RentalOut)
async def return_rental(
    rental_id: uuid.UUID, body: RentalReturn, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)
):
    rental = _get_rental_or_404(db, ctx, rental_id)
    if rental.status not in (RentalStatus.active, RentalStatus.overdue):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Принять возврат можно только для аренды в работе")

    rental.status = RentalStatus.returned
    rental.actual_return = body.actual_return or date.today()
    rental.damage_fee = body.damage_fee
    rental.discount = body.discount
    rental.return_notes = body.return_notes or DEFAULT_RETURN_NOTES

    for it in db.scalars(select(RentalItem).where(RentalItem.rental_id == rental.id)):
        equipment = db.get(Equipment, it.equipment_id)
        if equipment and equipment.status == EquipmentStatus.rented:
            equipment.status = EquipmentStatus.available

    log_action(
        db,
        business_id=ctx.business_id,
        user_id=ctx.user.id,
        action="return",
        resource="rental",
        resource_id=str(rental_id),
        meta={"damage_fee": body.damage_fee, "discount": body.discount},
    )
    db.commit()
    db.refresh(rental)
    return _to_out(db, rental)


def _find_blocking_rental(
    db: Session,
    *,
    business_id: uuid.UUID,
    equipment_id: uuid.UUID,
    start_date: date,
    end_date: date,
    exclude_rental_id: uuid.UUID | None = None,
) -> Rental | None:
    """Портирование isEquipmentFree/nextFreeDate из демо-прототипа: занятым
    оборудование считается, если пересекается по датам с любой ЧУЖОЙ бронью
    или активной арендой (отменённые/возвращённые не блокируют). Возвращает
    саму блокирующую аренду (для сообщения "занято до …"), либо None, если
    оборудование свободно на весь запрошенный диапазон."""
    query = (
        select(Rental)
        .join(RentalItem, RentalItem.rental_id == Rental.id)
        .where(
            Rental.business_id == business_id,
            RentalItem.equipment_id == equipment_id,
            Rental.status.in_((RentalStatus.booked, RentalStatus.active)),
            Rental.start_date <= end_date,
            Rental.end_date >= start_date,
        )
    )
    if exclude_rental_id is not None:
        query = query.where(Rental.id != exclude_rental_id)
    return db.scalars(query.order_by(Rental.end_date.desc())).first()


def _equipment_locked_elsewhere(
    db: Session, *, business_id: uuid.UUID, equipment_id: uuid.UUID, exclude_rental_id: uuid.UUID
) -> bool:
    """При снятии позиции с изменяемой аренды оборудование возвращается в
    "свободно" — но только если оно не занято какой-то ДРУГОЙ бронью/активной
    арендой (например, если по ошибке оказалось сразу в двух арендах)."""
    query = (
        select(Rental.id)
        .join(RentalItem, RentalItem.rental_id == Rental.id)
        .where(
            Rental.business_id == business_id,
            RentalItem.equipment_id == equipment_id,
            Rental.status.in_((RentalStatus.booked, RentalStatus.active)),
            Rental.id != exclude_rental_id,
        )
        .limit(1)
    )
    return db.scalars(query).first() is not None


@router.patch("/{rental_id}", response_model=RentalOut)
async def edit_rental(
    rental_id: uuid.UUID,
    body: RentalEdit,
    ctx: BusinessContext = Depends(edit_dep),
    db: Session = Depends(get_db),
):
    """Правка брони/активной аренды — 1-в-1 портирование editRentalForm из
    демо-прототипа (см. claude/oborot-crm-prototype.html)."""
    rental = _get_rental_or_404(db, ctx, rental_id)
    if rental.status not in (RentalStatus.booked, RentalStatus.active):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Эту аренду нельзя изменить в текущем статусе")

    # Дата начала зафиксирована, если оборудование уже выдано клиенту — поле
    # неактивно в форме демо-прототипа, поэтому переданное значение тихо
    # игнорируется, а не отклоняется как ошибка.
    new_start_date = rental.start_date if rental.status == RentalStatus.active else (body.start_date or rental.start_date)
    new_end_date = body.end_date if body.end_date is not None else rental.end_date

    if new_end_date < new_start_date:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Дата окончания раньше начала")

    existing_items = {
        it.equipment_id: it for it in db.scalars(select(RentalItem).where(RentalItem.rental_id == rental.id)).all()
    }

    if body.equipment_ids is not None:
        if not body.equipment_ids:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Выберите хотя бы одно оборудование")

        new_ids = list(dict.fromkeys(body.equipment_ids))  # de-dup, сохраняя порядок
        equipment_by_id: dict[uuid.UUID, Equipment] = {}
        for eq_id in new_ids:
            equipment = db.get(Equipment, eq_id)
            if equipment is None or equipment.business_id != ctx.business_id or equipment.deleted_at is not None:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Оборудование {eq_id} не найдено в этом бизнесе")
            equipment_by_id[eq_id] = equipment

            # Уже входящие в эту же аренду позиции не проверяются на конфликт
            # сами с собой — только вновь добавляемые.
            if eq_id not in existing_items:
                blocking = _find_blocking_rental(
                    db,
                    business_id=ctx.business_id,
                    equipment_id=eq_id,
                    start_date=new_start_date,
                    end_date=new_end_date,
                    exclude_rental_id=rental.id,
                )
                if blocking is not None:
                    raise HTTPException(
                        status.HTTP_400_BAD_REQUEST,
                        f"«{equipment.name}» занято до {blocking.end_date.isoformat()}",
                    )

        new_id_set = set(new_ids)

        # Снятые позиции — удаляются, снимок цены не нужен. Если аренда уже
        # активна, снятое оборудование возвращается в "свободно" — если оно
        # при этом не занято какой-то другой бронью/активной арендой.
        for eq_id, item in list(existing_items.items()):
            if eq_id in new_id_set:
                continue
            db.delete(item)
            if rental.status == RentalStatus.active:
                equipment = db.get(Equipment, eq_id)
                if (
                    equipment is not None
                    and equipment.status == EquipmentStatus.rented
                    and not _equipment_locked_elsewhere(
                        db, business_id=ctx.business_id, equipment_id=eq_id, exclude_rental_id=rental.id
                    )
                ):
                    equipment.status = EquipmentStatus.available

        # Добавленные позиции получают СВЕЖИЙ снимок текущих тарифов каталога
        # (демо: snapshotItem вызывается только для вновь выбранных позиций).
        # Уже существующие позиции сознательно не трогаются ниже — их снимок
        # цены (зафиксированный на момент брони) остаётся как есть.
        for eq_id in new_ids:
            if eq_id in existing_items:
                continue
            equipment = equipment_by_id[eq_id]
            db.add(
                RentalItem(
                    rental_id=rental.id,
                    equipment_id=equipment.id,
                    daily_rate_snapshot=equipment.daily_rate,
                    period_days_snapshot=equipment.period_days,
                    period_price_snapshot=equipment.period_price,
                    period_price_after_snapshot=equipment.period_price_after,
                    after_period_days_snapshot=equipment.after_period_days,
                )
            )
            if rental.status == RentalStatus.active:
                equipment.status = EquipmentStatus.rented

    rental.start_date = new_start_date
    rental.end_date = new_end_date
    if body.discount is not None:
        rental.discount = body.discount

    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="edit", resource="rental", resource_id=str(rental_id))
    db.commit()
    db.refresh(rental)
    return _to_out(db, rental)
