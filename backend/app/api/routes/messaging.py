"""Личные сообщения — см. модели в app/models/messaging.py для архитектурных
решений (лента сообщений, приватность диалогов даже от владельца бизнеса).

Право переписки регулируется MessagingPermission на бизнесе (см.
app/models/business.py):
- owner_only (по умолчанию): обычный сотрудник может открыть диалог только
  с владельцем бизнеса, групповые чаты создавать не может. Владелец может
  писать всем и создавать группы.
- everyone: любой активный сотрудник может написать любому другому и
  создавать группы.

Это ОТДЕЛЬНАЯ настройка от ACL-права "employees" (доступ к разделу
«Сотрудники») — сознательно не переиспользуется тот же механизм, потому что
это разные вопросы («кто может администрировать список сотрудников» vs
«кто кому может написать»)."""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.clock import utcnow
from app.core.deps import BusinessContext, get_business_context
from app.database import get_db
from app.models.business import Business, Employee, EmployeeStatus, MessagingPermission
from app.models.messaging import Conversation, ConversationParticipant, ConversationType, Message
from app.schemas.messaging import (
    ConversationCreate,
    ConversationOut,
    DirectoryEmployeeOut,
    MessageCreate,
    MessageOut,
    MessagingModeOut,
    MessagingModeUpdate,
)

router = APIRouter(prefix="/businesses/{business_id}/conversations", tags=["messaging"])
mode_router = APIRouter(prefix="/businesses/{business_id}/messaging-mode", tags=["messaging"])
directory_router = APIRouter(prefix="/businesses/{business_id}/messaging-directory", tags=["messaging"])

PREVIEW_LEN = 80


def _require_employee(ctx: BusinessContext) -> Employee:
    if ctx.employee is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "У вас нет собственного профиля сотрудника в этом бизнесе")
    return ctx.employee


def _get_participant(db: Session, conversation_id: uuid.UUID, employee_id: uuid.UUID) -> ConversationParticipant | None:
    return db.scalar(
        select(ConversationParticipant).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.employee_id == employee_id,
        )
    )


def _to_conversation_out(db: Session, conv: Conversation, me: Employee) -> ConversationOut:
    participants = db.scalars(
        select(ConversationParticipant).where(ConversationParticipant.conversation_id == conv.id)
    ).all()
    participant_count = len(participants)

    if conv.type == ConversationType.group:
        display_name = conv.name or "Группа"
    else:
        other = next((p for p in participants if p.employee_id != me.id), None)
        other_employee = db.get(Employee, other.employee_id) if other else None
        display_name = other_employee.name if other_employee else "Диалог"

    last_message = db.scalar(
        select(Message).where(Message.conversation_id == conv.id).order_by(Message.created_at.desc()).limit(1)
    )
    last_message_preview = None
    last_message_at = None
    if last_message is not None:
        text = last_message.text
        last_message_preview = text if len(text) <= PREVIEW_LEN else text[:PREVIEW_LEN] + "…"
        last_message_at = last_message.created_at

    my_participant = next((p for p in participants if p.employee_id == me.id), None)
    if my_participant is None or my_participant.last_read_at is None:
        unread_count = db.scalar(
            select(func.count(Message.id)).where(
                Message.conversation_id == conv.id, Message.employee_id != me.id
            )
        ) or 0
    else:
        unread_count = db.scalar(
            select(func.count(Message.id)).where(
                Message.conversation_id == conv.id,
                Message.employee_id != me.id,
                Message.created_at > my_participant.last_read_at,
            )
        ) or 0

    return ConversationOut(
        id=conv.id,
        type=conv.type,
        display_name=display_name,
        participant_count=participant_count,
        last_message_preview=last_message_preview,
        last_message_at=last_message_at,
        unread_count=unread_count,
        created_at=conv.created_at,
    )


@directory_router.get("", response_model=list[DirectoryEmployeeOut])
async def messaging_directory(ctx: BusinessContext = Depends(get_business_context), db: Session = Depends(get_db)):
    """Список сотрудников, которым ТЕКУЩИЙ сотрудник может написать — с
    учётом MessagingPermission. Не путать со списком всех сотрудников
    (раздел «Сотрудники», отдельное ACL-право)."""
    me = _require_employee(ctx)
    business = db.get(Business, ctx.business_id)
    active = select(Employee).where(
        Employee.business_id == ctx.business_id, Employee.status == EmployeeStatus.active, Employee.id != me.id
    )
    if ctx.full_access or business.messaging_permission == MessagingPermission.everyone:
        employees = db.scalars(active).all()
    else:
        employees = db.scalars(active.where(Employee.is_owner.is_(True))).all()
    return [DirectoryEmployeeOut(id=e.id, name=e.name, is_owner=e.is_owner) for e in employees]


@mode_router.put("", response_model=MessagingModeOut)
async def set_messaging_mode(
    body: MessagingModeUpdate, ctx: BusinessContext = Depends(get_business_context), db: Session = Depends(get_db)
):
    if not ctx.full_access:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Менять режим переписки может только владелец бизнеса")
    business = db.get(Business, ctx.business_id)
    business.messaging_permission = body.mode
    db.commit()
    return MessagingModeOut(mode=business.messaging_permission)


@router.get("", response_model=list[ConversationOut])
async def list_conversations(ctx: BusinessContext = Depends(get_business_context), db: Session = Depends(get_db)):
    me = _require_employee(ctx)
    conv_ids = db.scalars(
        select(ConversationParticipant.conversation_id).where(ConversationParticipant.employee_id == me.id)
    ).all()
    if not conv_ids:
        return []
    conversations = db.scalars(select(Conversation).where(Conversation.id.in_(conv_ids))).all()
    out = [_to_conversation_out(db, c, me) for c in conversations]
    # Сверху — диалоги с последней активностью; без сообщений вообще — по
    # дате создания диалога, в самый низ (это только что созданные пустые
    # диалоги/группы).
    out.sort(key=lambda c: c.last_message_at or c.created_at, reverse=True)
    return out


@router.post("", response_model=ConversationOut)
async def create_conversation(
    request: Request,
    body: ConversationCreate,
    ctx: BusinessContext = Depends(get_business_context),
    db: Session = Depends(get_db),
):
    me = _require_employee(ctx)
    business = db.get(Business, ctx.business_id)

    participant_ids = [pid for pid in dict.fromkeys(body.participant_ids) if pid != me.id]
    if not participant_ids:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Нужен хотя бы один собеседник, кроме вас самих")

    others = db.scalars(
        select(Employee).where(
            Employee.business_id == ctx.business_id,
            Employee.id.in_(participant_ids),
            Employee.status == EmployeeStatus.active,
        )
    ).all()
    if len(others) != len(participant_ids):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Один или несколько сотрудников не найдены")

    restricted = not ctx.full_access and business.messaging_permission == MessagingPermission.owner_only
    if restricted:
        if body.type == ConversationType.group:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "В этом бизнесе групповые чаты может создавать только владелец",
            )
        if len(others) != 1 or not others[0].is_owner:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "В этом бизнесе можно написать личное сообщение только владельцу",
            )

    if body.type == ConversationType.dm:
        if len(others) != 1:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Личное сообщение — ровно один собеседник")
        other_id = others[0].id
        my_dm_ids = select(ConversationParticipant.conversation_id).join(
            Conversation, Conversation.id == ConversationParticipant.conversation_id
        ).where(
            ConversationParticipant.employee_id == me.id,
            Conversation.business_id == ctx.business_id,
            Conversation.type == ConversationType.dm,
        )
        existing = db.scalar(
            select(Conversation).join(
                ConversationParticipant, ConversationParticipant.conversation_id == Conversation.id
            ).where(Conversation.id.in_(my_dm_ids), ConversationParticipant.employee_id == other_id)
        )
        if existing is not None:
            return _to_conversation_out(db, existing, me)

        conv = Conversation(
            business_id=ctx.business_id, type=ConversationType.dm, name=None, created_by_employee_id=me.id
        )
        db.add(conv)
        db.flush()
        db.add(ConversationParticipant(conversation_id=conv.id, employee_id=me.id))
        db.add(ConversationParticipant(conversation_id=conv.id, employee_id=other_id))
    else:
        if not body.name:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "У группового чата должно быть название")
        conv = Conversation(
            business_id=ctx.business_id, type=ConversationType.group, name=body.name, created_by_employee_id=me.id
        )
        db.add(conv)
        db.flush()
        db.add(ConversationParticipant(conversation_id=conv.id, employee_id=me.id))
        for other in others:
            db.add(ConversationParticipant(conversation_id=conv.id, employee_id=other.id))

    log_action(
        db,
        business_id=ctx.business_id,
        user_id=ctx.user.id,
        action="create",
        resource="conversation",
        resource_id=str(conv.id),
        ip_address=request.client.host if request.client else None,
    )
    db.commit()
    db.refresh(conv)
    return _to_conversation_out(db, conv, me)


@router.get("/{conversation_id}/messages", response_model=list[MessageOut])
async def list_messages(
    conversation_id: uuid.UUID, ctx: BusinessContext = Depends(get_business_context), db: Session = Depends(get_db)
):
    me = _require_employee(ctx)
    conv = db.get(Conversation, conversation_id)
    if conv is None or conv.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Диалог не найден")

    participant = _get_participant(db, conversation_id, me.id)
    if participant is None:
        # Даже владелец бизнеса (full_access) не имеет доступа к чужой личной
        # переписке, в которой не состоит сам — см. app/models/messaging.py.
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Вы не участник этого диалога")

    messages = db.scalars(
        select(Message).where(Message.conversation_id == conversation_id).order_by(Message.created_at.asc())
    ).all()

    participant.last_read_at = utcnow()
    db.commit()

    return [
        MessageOut(
            id=m.id, author_name=m.author_name, text=m.text, created_at=m.created_at, is_mine=m.employee_id == me.id
        )
        for m in messages
    ]


@router.post("/{conversation_id}/messages", response_model=MessageOut, status_code=status.HTTP_201_CREATED)
async def send_message(
    conversation_id: uuid.UUID,
    request: Request,
    body: MessageCreate,
    ctx: BusinessContext = Depends(get_business_context),
    db: Session = Depends(get_db),
):
    me = _require_employee(ctx)
    conv = db.get(Conversation, conversation_id)
    if conv is None or conv.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Диалог не найден")

    participant = _get_participant(db, conversation_id, me.id)
    if participant is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Вы не участник этого диалога")

    # created_at выставляем явно в Python (микросекундная точность), а не
    # полагаемся на server_default=func.now() колонки: у SQLite CURRENT_TIMESTAMP
    # — точность до секунды, из-за чего два сообщения, отправленные в течение
    # одной секунды, было бы невозможно правильно упорядочить (last_message_preview
    # мог показать более старое сообщение как последнее). datetime.now() в
    # Python — микросекундная точность на любой БД, включая Postgres в проде.
    message = Message(
        conversation_id=conversation_id, employee_id=me.id, author_name=me.name, text=body.text, created_at=utcnow()
    )
    db.add(message)
    participant.last_read_at = utcnow()
    log_action(
        db,
        business_id=ctx.business_id,
        user_id=ctx.user.id,
        action="create",
        resource="message",
        ip_address=request.client.host if request.client else None,
    )
    db.commit()
    db.refresh(message)
    return MessageOut(id=message.id, author_name=message.author_name, text=message.text, created_at=message.created_at, is_mine=True)
