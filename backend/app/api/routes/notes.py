"""Доска «Заметки/новости» на дашборде — см. модель DashboardNote и NotesMode
(app/models/business.py). Два сценария, которые попросил пользователь,
реализованы одним переключателем режима на бизнесе:

- owner_only (по умолчанию): пишет и удаляет чужие записи только владелец —
  «новости для сотрудников», остальные только читают.
- everyone: писать может любой активный сотрудник — «общие быстрые заметки
  команды»; удалить свою запись может её автор, любую — всегда владелец
  (модерация).

Читать доску может любой сотрудник бизнеса в обоих режимах — это не
чувствительные бизнес-данные уровня ACL (finance/clients и т.п.), а внутренняя
доска объявлений, поэтому используется get_business_context без require_permission,
как и dashboard-prefs."""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.deps import BusinessContext, get_business_context
from app.database import get_db
from app.models.business import Business, DashboardNote, NotesMode
from app.schemas.business import NoteCreate, NoteOut, NotesModeOut, NotesModeUpdate

router = APIRouter(prefix="/businesses/{business_id}/notes", tags=["notes"])


def _to_out(note: DashboardNote, ctx: BusinessContext) -> NoteOut:
    can_delete = ctx.full_access or (ctx.employee is not None and note.employee_id == ctx.employee.id)
    return NoteOut(
        id=note.id,
        author_name=note.author_name,
        text=note.text,
        created_at=note.created_at,
        can_delete=can_delete,
    )


@router.get("", response_model=list[NoteOut])
async def list_notes(ctx: BusinessContext = Depends(get_business_context), db: Session = Depends(get_db)):
    notes = db.scalars(
        select(DashboardNote)
        .where(DashboardNote.business_id == ctx.business_id)
        .order_by(DashboardNote.created_at.desc())
    ).all()
    return [_to_out(n, ctx) for n in notes]


@router.post("", response_model=NoteOut, status_code=status.HTTP_201_CREATED)
async def create_note(
    request: Request,
    body: NoteCreate,
    ctx: BusinessContext = Depends(get_business_context),
    db: Session = Depends(get_db),
):
    if ctx.employee is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "У вас нет собственного профиля сотрудника в этом бизнесе")

    business = db.get(Business, ctx.business_id)
    if business.notes_mode == NotesMode.owner_only and not ctx.full_access:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "В этом бизнесе публиковать записи может только владелец — остальным доступно только чтение",
        )

    note = DashboardNote(
        business_id=ctx.business_id,
        employee_id=ctx.employee.id,
        author_name=ctx.employee.name,
        text=body.text,
    )
    db.add(note)
    log_action(
        db,
        business_id=ctx.business_id,
        user_id=ctx.user.id,
        action="create",
        resource="dashboard_note",
        ip_address=request.client.host if request.client else None,
    )
    db.commit()
    db.refresh(note)
    return _to_out(note, ctx)


@router.delete("/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_note(
    note_id: uuid.UUID,
    ctx: BusinessContext = Depends(get_business_context),
    db: Session = Depends(get_db),
):
    note = db.get(DashboardNote, note_id)
    if note is None or note.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Запись не найдена")

    is_author = ctx.employee is not None and note.employee_id == ctx.employee.id
    if not ctx.full_access and not is_author:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Удалить можно только свою запись")

    db.delete(note)
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="delete", resource="dashboard_note", resource_id=str(note_id))
    db.commit()


@router.put("/mode", response_model=NotesModeOut)
async def set_notes_mode(
    body: NotesModeUpdate,
    ctx: BusinessContext = Depends(get_business_context),
    db: Session = Depends(get_db),
):
    if not ctx.full_access:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Менять режим доски заметок может только владелец бизнеса")
    business = db.get(Business, ctx.business_id)
    business.notes_mode = body.mode
    db.commit()
    return NotesModeOut(mode=business.notes_mode)
