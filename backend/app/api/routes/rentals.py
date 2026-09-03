import base64
import uuid
from datetime import date

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.deps import BusinessContext, require_permission
from app.database import get_db
from app.models.audit import AuditLog
from app.models.business import Employee, PermissionLevel, ResourceType
from app.models.inventory import (
    Client,
    Equipment,
    EquipmentStatus,
    Rental,
    RentalItem,
    RentalPhoto,
    RentalPhotoStage,
    RentalStatus,
)
from app.schemas.inventory import (
    RentalCancel,
    RentalCreate,
    RentalDepositReturn,
    RentalEdit,
    RentalHistoryEntry,
    RentalIssue,
    RentalOut,
    RentalPayment,
    RentalPaymentCorrection,
    RentalPhotoOut,
    RentalReturn,
    RentalReturnItems,
)
from app.services.pricing import compute_rental_breakdown, item_cost_for_days, span_days

# Лимит размера файла фото аренды (41-й проход) — то же значение и то же
# обоснование, что и MAX_CLIENT_DOCUMENT_BYTES в app/api/routes/clients.py.
MAX_RENTAL_PHOTO_BYTES = 5 * 1024 * 1024

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
                # Частичный возврат по позициям (41-й проход) — своя дата
                # факт. возврата у КАЖДОЙ позиции, см. докстринг
                # compute_rental_breakdown в app/services/pricing.py.
                "returned_at": it.returned_at,
            }
            for it in items
        ],
        start_date=rental.start_date,
        end_date=rental.end_date,
        actual_return=rental.actual_return,
        today=date.today(),
        damage_fee=float(rental.damage_fee),
        discount=float(rental.discount),
        extra_fee=float(rental.extra_fee),
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
        extra_fee=float(rental.extra_fee),
        extra_fee_note=rental.extra_fee_note,
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
        deposit_returned_at=rental.deposit_returned_at,
        paid_amount=float(rental.paid_amount),
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
        # Доп. услуги (46-й проход) — необязательны при создании, можно
        # добавить и позже через "Изменить" (edit_rental ниже).
        extra_fee=body.extra_fee or 0,
        extra_fee_note=(body.extra_fee_note.strip() or None) if body.extra_fee_note else None,
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
async def cancel_rental(
    rental_id: uuid.UUID,
    body: RentalCancel | None = None,
    ctx: BusinessContext = Depends(edit_dep),
    db: Session = Depends(get_db),
):
    rental = _get_rental_or_404(db, ctx, rental_id)
    if rental.status not in (RentalStatus.booked, RentalStatus.active):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Эту аренду нельзя отменить в текущем статусе")
    rental.status = RentalStatus.cancelled
    for it in db.scalars(select(RentalItem).where(RentalItem.rental_id == rental.id)):
        equipment = db.get(Equipment, it.equipment_id)
        if equipment and equipment.status == EquipmentStatus.rented:
            equipment.status = EquipmentStatus.available
    # Причина отмены (43-й проход, п.5 обзора) — необязательна, попадает
    # ТОЛЬКО в meta записи журнала, не хранится на самой Rental (см.
    # докстринг RentalCancel): журнал уже читается сотрудниками
    # (RentalHistorySection.tsx), а причина ценна именно как контекст события,
    # а не как поле, которое нужно было бы отдельно чистить/переносить.
    reason = body.reason.strip() if body and body.reason else None
    log_action(
        db,
        business_id=ctx.business_id,
        user_id=ctx.user.id,
        action="cancel",
        resource="rental",
        resource_id=str(rental_id),
        meta={"reason": reason} if reason else None,
    )
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
    # Складывается, а не заменяет — если часть повреждений уже была
    # зафиксирована раньше через частичный возврат (POST .../return-items),
    # этот запрос закрывает ОСТАВШИЕСЯ позиции и может нести доплату за НИХ;
    # тот же принцип, что и у RentalReturnItems.damage_fee (см. схему).
    rental.damage_fee = float(rental.damage_fee) + body.damage_fee
    rental.discount = body.discount
    # Если частичный возврат раньше уже что-то записал в return_notes —
    # дописываем новый текст следом, а не затираем (та же логика, что и в
    # return_rental_items ниже).
    if body.return_notes:
        rental.return_notes = f"{rental.return_notes}\n{body.return_notes}" if rental.return_notes else body.return_notes
    elif not rental.return_notes:
        rental.return_notes = DEFAULT_RETURN_NOTES

    for it in db.scalars(select(RentalItem).where(RentalItem.rental_id == rental.id)):
        # Частичный возврат по позициям (41-й проход) — позиция могла уже
        # быть возвращена раньше отдельным запросом; у неё returned_at не
        # трогаем (сохраняем ЕЁ фактическую дату), у остальных проставляем
        # ЭТУ дату закрытия — так "Принять возврат" остаётся рабочим
        # способом закрыть аренду одним действием, даже если ей ни разу не
        # пользовались частичным возвратом.
        if it.returned_at is None:
            it.returned_at = rental.actual_return
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


@router.post("/{rental_id}/return-items", response_model=RentalOut)
async def return_rental_items(
    rental_id: uuid.UUID,
    body: RentalReturnItems,
    ctx: BusinessContext = Depends(edit_dep),
    db: Session = Depends(get_db),
):
    """Частичный возврат по позициям (41-й проход) — см. докстринг
    RentalReturnItems. В отличие от return_rental выше, закрывает аренду
    целиком, только если этим же запросом возвращаются ПОСЛЕДНИЕ ещё не
    возвращённые позиции — иначе аренда остаётся "в работе" с частью
    оборудования уже физически на складе."""
    rental = _get_rental_or_404(db, ctx, rental_id)
    if rental.status not in (RentalStatus.active, RentalStatus.overdue):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Вернуть позиции можно только для аренды в работе")

    items_by_equipment = {
        it.equipment_id: it for it in db.scalars(select(RentalItem).where(RentalItem.rental_id == rental.id)).all()
    }

    requested_ids = list(dict.fromkeys(body.equipment_ids))  # de-dup, сохраняя порядок
    for eq_id in requested_ids:
        item = items_by_equipment.get(eq_id)
        if item is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Позиция {eq_id} не относится к этой аренде")
        if item.returned_at is not None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Позиция {eq_id} уже была возвращена раньше")

    actual_return = body.actual_return or date.today()

    for eq_id in requested_ids:
        item = items_by_equipment[eq_id]
        item.returned_at = actual_return
        equipment = db.get(Equipment, eq_id)
        # Та же проверка "не занято ли ГДЕ-ТО ЕЩЁ", что и при снятии позиции
        # с редактируемой аренды в edit_rental — оборудование освобождается,
        # только если его не держит какая-то ДРУГАЯ бронь/активная аренда.
        if (
            equipment is not None
            and equipment.status == EquipmentStatus.rented
            and not _equipment_locked_elsewhere(
                db, business_id=ctx.business_id, equipment_id=eq_id, exclude_rental_id=rental.id
            )
        ):
            equipment.status = EquipmentStatus.available

    rental.damage_fee = float(rental.damage_fee) + body.damage_fee
    if body.return_notes:
        rental.return_notes = f"{rental.return_notes}\n{body.return_notes}" if rental.return_notes else body.return_notes

    still_out = any(it.returned_at is None for it in items_by_equipment.values())
    closed_now = not still_out
    if closed_now:
        # Этим запросом вернулись ПОСЛЕДНИЕ позиции — закрываем аренду
        # целиком, тем же итоговым состоянием, что и обычный return_rental.
        rental.status = RentalStatus.returned
        rental.actual_return = max(it.returned_at for it in items_by_equipment.values())
        if not rental.return_notes:
            rental.return_notes = DEFAULT_RETURN_NOTES

    log_action(
        db,
        business_id=ctx.business_id,
        user_id=ctx.user.id,
        action="return_items",
        resource="rental",
        resource_id=str(rental_id),
        meta={"equipment_ids": [str(x) for x in requested_ids], "damage_fee": body.damage_fee, "closed": closed_now},
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
    оборудование свободно на весь запрошенный диапазон.

    RentalItem.returned_at.is_(None) — 41-й проход: позиция, возвращённая
    раньше остальных через частичный возврат, освобождает СВОЁ оборудование
    сразу, даже если сама аренда формально ещё "active" (другие позиции той
    же аренды ещё не возвращены) — иначе весь смысл частичного возврата
    (пустить оборудование в новую бронь пораньше) терялся бы именно здесь."""
    query = (
        select(Rental)
        .join(RentalItem, RentalItem.rental_id == Rental.id)
        .where(
            Rental.business_id == business_id,
            RentalItem.equipment_id == equipment_id,
            RentalItem.returned_at.is_(None),
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
            RentalItem.returned_at.is_(None),
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

    # Снимок "было" ДО мутации — нужен для содержательной записи в журнале
    # изменений (42-й проход, GET .../history): "edit" сам по себе ничего не
    # говорит о том, ЧТО поменялось (даты продлили? состав? скидку?), а
    # именно это интересно посмотреть в панели деталей аренды задним числом.
    # В meta попадают ТОЛЬКО реально изменившиеся поля — не захламляем
    # журнал записями вида "discount_before == discount_after".
    history_meta: dict = {}
    if new_start_date != rental.start_date:
        history_meta["start_date_before"] = rental.start_date.isoformat()
        history_meta["start_date_after"] = new_start_date.isoformat()
    if new_end_date != rental.end_date:
        history_meta["end_date_before"] = rental.end_date.isoformat()
        history_meta["end_date_after"] = new_end_date.isoformat()
    if body.equipment_ids is not None and set(body.equipment_ids) != set(existing_items.keys()):
        history_meta["equipment_count_before"] = len(existing_items)
        history_meta["equipment_count_after"] = len(set(body.equipment_ids))
    if body.discount is not None and float(body.discount) != float(rental.discount):
        history_meta["discount_before"] = float(rental.discount)
        history_meta["discount_after"] = float(body.discount)
    # Доп. услуги (46-й проход) — та же логика, что и discount выше: body.*
    # is not None здесь means "поле реально пришло в теле запроса" (фронт
    # либо отправляет ТЕКУЩЕЕ значение целиком при правке через
    # EditRentalModal, либо не отправляет поле совсем — например
    # ExtendRentalModal/BulkExtendModal шлют только end_date, и extra_fee
    # тогда закономерно не трогается).
    if body.extra_fee is not None and float(body.extra_fee) != float(rental.extra_fee):
        history_meta["extra_fee_before"] = float(rental.extra_fee)
        history_meta["extra_fee_after"] = float(body.extra_fee)
    if body.extra_fee_note is not None and (body.extra_fee_note.strip() or None) != rental.extra_fee_note:
        history_meta["extra_fee_note_before"] = rental.extra_fee_note
        history_meta["extra_fee_note_after"] = body.extra_fee_note.strip() or None

    rental.start_date = new_start_date
    rental.end_date = new_end_date
    if body.discount is not None:
        rental.discount = body.discount
    if body.extra_fee is not None:
        rental.extra_fee = body.extra_fee
    if body.extra_fee_note is not None:
        rental.extra_fee_note = body.extra_fee_note.strip() or None

    log_action(
        db,
        business_id=ctx.business_id,
        user_id=ctx.user.id,
        action="edit",
        resource="rental",
        resource_id=str(rental_id),
        meta=history_meta or None,
    )
    db.commit()
    db.refresh(rental)
    return _to_out(db, rental)


@router.post("/{rental_id}/deposit-return", response_model=RentalOut)
async def set_deposit_returned(
    rental_id: uuid.UUID,
    body: RentalDepositReturn,
    ctx: BusinessContext = Depends(edit_dep),
    db: Session = Depends(get_db),
):
    """Отметка "депозит возвращён клиенту" (42-й проход) — см. докстринг
    Rental.deposit_returned_at. Не привязано к статусу аренды жёстко (можно
    отметить и до формального "Принять возврат", и снять отметку по ошибке
    в любой момент) — это отдельный факт бухгалтерии, не часть жизненного
    цикла самой аренды."""
    rental = _get_rental_or_404(db, ctx, rental_id)
    rental.deposit_returned_at = (body.returned_at or date.today()) if body.returned else None

    log_action(
        db,
        business_id=ctx.business_id,
        user_id=ctx.user.id,
        action="deposit_return" if body.returned else "deposit_return_undo",
        resource="rental",
        resource_id=str(rental_id),
    )
    db.commit()
    db.refresh(rental)
    return _to_out(db, rental)


@router.post("/{rental_id}/payment", response_model=RentalOut)
async def add_rental_payment(
    rental_id: uuid.UUID,
    body: RentalPayment,
    ctx: BusinessContext = Depends(edit_dep),
    db: Session = Depends(get_db),
):
    """Запись платежа (46-й проход) — см. докстринг RentalPayment и
    Rental.paid_amount. amount добавляется к уже накопленной сумме (может
    быть отрицательным — исправление ошибки), результат ограничен снизу
    нулём, чтобы накопленная сумма не уходила в минус."""
    rental = _get_rental_or_404(db, ctx, rental_id)
    new_amount = max(0.0, float(rental.paid_amount) + body.amount)
    rental.paid_amount = new_amount

    log_action(
        db,
        business_id=ctx.business_id,
        user_id=ctx.user.id,
        action="payment",
        resource="rental",
        resource_id=str(rental_id),
        meta={"amount": body.amount, "paid_amount_after": new_amount},
    )
    db.commit()
    db.refresh(rental)
    return _to_out(db, rental)


@router.post("/{rental_id}/history/{entry_id}/correct", response_model=RentalOut)
async def correct_rental_payment(
    rental_id: uuid.UUID,
    entry_id: uuid.UUID,
    body: RentalPaymentCorrection,
    ctx: BusinessContext = Depends(edit_dep),
    db: Session = Depends(get_db),
):
    """Исправление опечатки в платеже (49-й проход) — см. докстринг
    RentalPaymentCorrection про то, почему это отдельный эндпоинт, а не
    просто подсказка "введите отрицательную сумму" в /payment. entry_id —
    id ИСХОДНОЙ записи AuditLog (action="payment"); исправлять саму
    коррекцию нельзя — если платёж поправили не туда, нужно снова открыть
    "Исправить" у исходного платежа и указать верное значение (см. ниже,
    почему это не то же самое, что просто "исправить второй раз"). Сама
    исходная запись не переписывается и не удаляется — добавляется новая,
    action="payment_correction", со ссылкой correction_of на исходную,
    тем же принципом, что и весь остальной журнал: история только
    дополняется, никогда не переписывается задним числом.

    Важно: если платёж уже исправляли раньше, corrected_to нельзя сравнивать
    с исходным entry.meta["amount"] — это привело бы к неверной delta при
    повторном исправлении (пример: 5000 → поправили на 500 → хотим 700;
    сравнение с исходными 5000 дало бы delta=-4300 вместо верных +200).
    Поэтому здесь сначала считается ТЕКУЩЕЕ действующее значение платежа —
    исходная сумма плюс все более ранние коррекции именно этой записи — и
    delta берётся уже от него."""
    rental = _get_rental_or_404(db, ctx, rental_id)
    entry = db.execute(
        select(AuditLog).where(
            AuditLog.id == entry_id,
            AuditLog.business_id == ctx.business_id,
            AuditLog.resource == "rental",
            AuditLog.resource_id == str(rental_id),
            AuditLog.action == "payment",
        )
    ).scalar_one_or_none()
    if entry is None:
        raise HTTPException(status_code=404, detail="Запись платежа не найдена")

    original_amount = float((entry.meta or {}).get("amount", 0.0))
    prior_corrections = db.execute(
        select(AuditLog).where(
            AuditLog.business_id == ctx.business_id,
            AuditLog.resource == "rental",
            AuditLog.resource_id == str(rental_id),
            AuditLog.action == "payment_correction",
        )
    ).scalars().all()
    # meta — JSON-поле, сравнить correction_of на уровне SQL надёжно не для
    # каждой БД (SQLite в тестах хранит JSON как TEXT) — фильтруем в Python,
    # записей на одну аренду всегда немного.
    current_effective_amount = original_amount + sum(
        float((c.meta or {}).get("amount", 0.0))
        for c in prior_corrections
        if (c.meta or {}).get("correction_of") == str(entry_id)
    )

    delta = body.corrected_to - current_effective_amount
    new_amount = max(0.0, float(rental.paid_amount) + delta)
    rental.paid_amount = new_amount

    log_action(
        db,
        business_id=ctx.business_id,
        user_id=ctx.user.id,
        action="payment_correction",
        resource="rental",
        resource_id=str(rental_id),
        meta={
            "correction_of": str(entry_id),
            "corrected_from": current_effective_amount,
            "corrected_to": body.corrected_to,
            "amount": delta,
            "paid_amount_after": new_amount,
        },
    )
    db.commit()
    db.refresh(rental)
    return _to_out(db, rental)


# ============================================================
# Фото состояния оборудования при выдаче/возврате (41-й проход) — по образцу
# документов клиента (app/api/routes/clients.py), но привязано к Rental
# целиком и с полем stage вместо label. См. RentalPhoto в
# app/models/inventory.py.
# ============================================================


def _photo_out(photo: RentalPhoto, employee_name: str | None) -> RentalPhotoOut:
    out = RentalPhotoOut.model_validate(photo)
    out.employee_name = employee_name
    return out


@router.get("/{rental_id}/photos", response_model=list[RentalPhotoOut])
async def list_rental_photos(
    rental_id: uuid.UUID, ctx: BusinessContext = Depends(view_dep), db: Session = Depends(get_db)
):
    rental = _get_rental_or_404(db, ctx, rental_id)
    rows = db.execute(
        select(RentalPhoto, Employee.name)
        .join(Employee, Employee.id == RentalPhoto.employee_id, isouter=True)
        .where(RentalPhoto.rental_id == rental.id, RentalPhoto.business_id == ctx.business_id)
        .order_by(RentalPhoto.created_at.desc())
    ).all()
    return [_photo_out(photo, employee_name) for photo, employee_name in rows]


@router.post("/{rental_id}/photos", response_model=RentalPhotoOut, status_code=status.HTTP_201_CREATED)
async def upload_rental_photo(
    rental_id: uuid.UUID,
    file: UploadFile,
    stage: RentalPhotoStage = Form(...),
    ctx: BusinessContext = Depends(edit_dep),
    db: Session = Depends(get_db),
):
    rental = _get_rental_or_404(db, ctx, rental_id)

    raw = await file.read()
    if len(raw) == 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Пустой файл")
    if len(raw) > MAX_RENTAL_PHOTO_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Файл слишком большой (максимум 5 МБ)")

    photo = RentalPhoto(
        business_id=ctx.business_id,
        rental_id=rental.id,
        employee_id=ctx.employee.id if ctx.employee is not None else None,
        stage=stage,
        filename=file.filename or "фото",
        content_type=file.content_type or "application/octet-stream",
        size_bytes=len(raw),
        data_base64=base64.b64encode(raw).decode("ascii"),
    )
    db.add(photo)
    log_action(
        db, business_id=ctx.business_id, user_id=ctx.user.id, action="create", resource="rental_photo", resource_id=str(rental_id)
    )
    db.commit()
    db.refresh(photo)
    return _photo_out(photo, ctx.employee.name if ctx.employee is not None else None)


@router.delete("/{rental_id}/photos/{photo_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rental_photo(
    rental_id: uuid.UUID, photo_id: uuid.UUID, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)
):
    photo = db.get(RentalPhoto, photo_id)
    if photo is None or photo.business_id != ctx.business_id or photo.rental_id != rental_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Фото не найдено")
    db.delete(photo)
    log_action(
        db, business_id=ctx.business_id, user_id=ctx.user.id, action="delete", resource="rental_photo", resource_id=str(photo_id)
    )
    db.commit()


# ============================================================
# Журнал изменений аренды (42-й проход) — читает существующий AuditLog
# (app/models/audit.py): события create/issue/edit/return/return_items/
# cancel/deposit_return по этой аренде и раньше писались через log_action(...)
# по всему файлу выше, просто до этого прохода нигде не читались обратно —
# только "кто и когда удалил клиента" разбирали вручную через БД при
# инцидентах. Здесь — обычное чтение по business_id+resource+resource_id,
# без отдельной таблицы и без дублирования уже существующей записи событий.
# ============================================================


@router.get("/{rental_id}/history", response_model=list[RentalHistoryEntry])
async def rental_history(rental_id: uuid.UUID, ctx: BusinessContext = Depends(view_dep), db: Session = Depends(get_db)):
    _get_rental_or_404(db, ctx, rental_id)
    rows = db.execute(
        select(AuditLog, Employee.name)
        # Условие на business_id — ПРЯМО в самом ON, не в WHERE: один и тот
        # же пользователь может состоять в нескольких бизнесах (несколько
        # строк Employee с одним user_id) — без этого условия LEFT JOIN
        # задвоил бы строку истории на каждый такой бизнес. Так матчится
        # только Employee ИМЕННО в текущем business_id, как и было задумано.
        .join(Employee, (Employee.user_id == AuditLog.user_id) & (Employee.business_id == ctx.business_id), isouter=True)
        .where(
            AuditLog.business_id == ctx.business_id,
            AuditLog.resource == "rental",
            AuditLog.resource_id == str(rental_id),
        )
        .order_by(AuditLog.created_at.desc())
    ).all()
    entries = []
    for log, employee_name in rows:
        entries.append(
            RentalHistoryEntry(
                id=log.id,
                action=log.action,
                employee_name=employee_name,
                meta=log.meta,
                created_at=log.created_at,
            )
        )
    return entries
