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
from app.schemas.inventory import RentalCreate, RentalOut, RentalReturn
from app.services.pricing import compute_rental_amount, item_cost_for_days, span_days

router = APIRouter(prefix="/businesses/{business_id}/rentals", tags=["rentals"])

view_dep = require_permission(ResourceType.rentals, PermissionLevel.view)
edit_dep = require_permission(ResourceType.rentals, PermissionLevel.edit)


def _rental_amount(rental: Rental, items: list[RentalItem]) -> float:
    end_for_calc = rental.actual_return or rental.end_date
    days = span_days(rental.start_date, end_for_calc)
    costs = [
        item_cost_for_days(
            daily_rate=float(it.daily_rate_snapshot),
            days=days,
            period_days=it.period_days_snapshot,
            period_price=float(it.period_price_snapshot) if it.period_price_snapshot is not None else None,
            period_price_after=float(it.period_price_after_snapshot) if it.period_price_after_snapshot is not None else None,
        )
        for it in items
    ]
    return compute_rental_amount(costs, damage_fee=float(rental.damage_fee))


def _to_out(db: Session, rental: Rental) -> RentalOut:
    items = db.scalars(select(RentalItem).where(RentalItem.rental_id == rental.id)).all()
    return RentalOut(
        id=rental.id,
        client_id=rental.client_id,
        start_date=rental.start_date,
        end_date=rental.end_date,
        actual_return=rental.actual_return,
        status=rental.status,
        damage_fee=float(rental.damage_fee),
        created_at=rental.created_at,
        amount=_rental_amount(rental, items),
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

    client = db.get(Client, body.client_id)
    if client is None or client.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Клиент не найден в этом бизнесе")

    items_data = []
    for eq_id in body.equipment_ids:
        equipment = db.get(Equipment, eq_id)
        if equipment is None or equipment.business_id != ctx.business_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Оборудование {eq_id} не найдено в этом бизнесе")
        if equipment.status not in (EquipmentStatus.available,):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"«{equipment.name}» сейчас недоступно (статус: {equipment.status.value})")
        items_data.append(equipment)

    rental = Rental(
        business_id=ctx.business_id,
        client_id=body.client_id,
        start_date=body.start_date,
        end_date=body.end_date,
        status=RentalStatus.booked if body.start_date > date.today() else RentalStatus.active,
        created_by_employee_id=ctx.employee.id if ctx.employee else None,
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
async def issue_rental(rental_id: uuid.UUID, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)):
    """Забронировано → выдано (в работе)."""
    rental = _get_rental_or_404(db, ctx, rental_id)
    if rental.status != RentalStatus.booked:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Выдать можно только бронь")
    rental.status = RentalStatus.active
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
        meta={"damage_fee": body.damage_fee},
    )
    db.commit()
    db.refresh(rental)
    return _to_out(db, rental)
