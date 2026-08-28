import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.deps import BusinessContext, require_permission
from app.database import get_db
from app.models.business import PermissionLevel, ResourceType
from app.models.inventory import Client, Rental
from app.schemas.inventory import ClientCreate, ClientOut, ClientUpdate

router = APIRouter(prefix="/businesses/{business_id}/clients", tags=["clients"])

view_dep = require_permission(ResourceType.clients, PermissionLevel.view)
edit_dep = require_permission(ResourceType.clients, PermissionLevel.edit)


@router.get("", response_model=list[ClientOut])
async def list_clients(ctx: BusinessContext = Depends(view_dep), db: Session = Depends(get_db)):
    return db.scalars(select(Client).where(Client.business_id == ctx.business_id)).all()


@router.post("", response_model=ClientOut, status_code=status.HTTP_201_CREATED)
async def create_client(body: ClientCreate, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)):
    client = Client(business_id=ctx.business_id, **body.model_dump())
    db.add(client)
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="create", resource="client")
    db.commit()
    db.refresh(client)
    return client


@router.patch("/{client_id}", response_model=ClientOut)
async def update_client(
    client_id: uuid.UUID, body: ClientUpdate, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)
):
    client = db.get(Client, client_id)
    if client is None or client.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Клиент не найден")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(client, field, value)
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="update", resource="client", resource_id=str(client_id))
    db.commit()
    db.refresh(client)
    return client


@router.delete("/{client_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_client(client_id: uuid.UUID, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)):
    client = db.get(Client, client_id)
    if client is None or client.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Клиент не найден")

    open_rental = db.scalar(
        select(Rental).where(Rental.client_id == client_id, Rental.status.in_(["booked", "active", "overdue"]))
    )
    if open_rental is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Нельзя удалить клиента с открытой арендой")

    db.delete(client)
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="delete", resource="client", resource_id=str(client_id))
    db.commit()
