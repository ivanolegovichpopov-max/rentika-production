import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.deps import BusinessContext, require_permission
from app.database import get_db
from app.models.business import PermissionLevel, ResourceType
from app.models.inventory import Equipment, EquipmentStatus, RentalItem
from app.schemas.inventory import EquipmentCreate, EquipmentOut

router = APIRouter(prefix="/businesses/{business_id}/equipment", tags=["equipment"])

view_dep = require_permission(ResourceType.equipment, PermissionLevel.view)
edit_dep = require_permission(ResourceType.equipment, PermissionLevel.edit)


@router.get("", response_model=list[EquipmentOut])
async def list_equipment(ctx: BusinessContext = Depends(view_dep), db: Session = Depends(get_db)):
    # RLS уже ограничил видимые строки до ctx.business_id (см. get_business_context),
    # фильтр по business_id здесь — вторая, объектно-уровневая линия защиты,
    # а не единственная.
    return db.scalars(select(Equipment).where(Equipment.business_id == ctx.business_id)).all()


@router.post("", response_model=EquipmentOut, status_code=status.HTTP_201_CREATED)
async def create_equipment(body: EquipmentCreate, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)):
    item = Equipment(business_id=ctx.business_id, **body.model_dump())
    db.add(item)
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="create", resource="equipment")
    db.commit()
    db.refresh(item)
    return item


@router.patch("/{equipment_id}", response_model=EquipmentOut)
async def update_equipment(
    equipment_id: uuid.UUID, body: EquipmentCreate, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)
):
    item = db.get(Equipment, equipment_id)
    if item is None or item.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Оборудование не найдено")
    for field, value in body.model_dump().items():
        setattr(item, field, value)
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="update", resource="equipment", resource_id=str(equipment_id))
    db.commit()
    db.refresh(item)
    return item


@router.delete("/{equipment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_equipment(
    equipment_id: uuid.UUID, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)
):
    item = db.get(Equipment, equipment_id)
    if item is None or item.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Оборудование не найдено")

    in_use = db.scalar(select(RentalItem).where(RentalItem.equipment_id == equipment_id))
    if in_use is not None:
        # Тот же защитный принцип, что в index-supabase.html (SPEC.md 9.4):
        # нельзя списать позицию, у которой уже есть история аренд — иначе
        # rental_items.equipment_id повиснет на удалённой записи, а прошлые
        # аренды потеряют читаемое название техники.
        item.status = EquipmentStatus.retired
        log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="retire", resource="equipment", resource_id=str(equipment_id))
        db.commit()
        return

    db.delete(item)
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="delete", resource="equipment", resource_id=str(equipment_id))
    db.commit()
