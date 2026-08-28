import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.models.business import MessagingPermission
from app.models.messaging import ConversationType


class MessagingModeOut(BaseModel):
    mode: MessagingPermission


class MessagingModeUpdate(BaseModel):
    mode: MessagingPermission


class DirectoryEmployeeOut(BaseModel):
    """Один сотрудник в списке "кому можно написать" — минимум данных,
    специально не переиспользует EmployeeOut (там есть position_id/status,
    не нужные для выбора собеседника, и это НЕ тот же ACL-ресурс, что
    раздел «Сотрудники» — см. MessagingPermission)."""

    id: uuid.UUID
    name: str
    is_owner: bool


class ConversationCreate(BaseModel):
    type: ConversationType
    # Для dm — ровно один id (собеседник); для group — один или больше
    # (сам создатель добавляется в диалог автоматически, его не нужно
    # перечислять здесь).
    participant_ids: list[uuid.UUID] = Field(min_length=1, max_length=64)
    name: str | None = Field(default=None, max_length=255)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None


class MessageCreate(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


class MessageOut(BaseModel):
    id: uuid.UUID
    author_name: str
    text: str
    created_at: datetime
    is_mine: bool = False

    model_config = {"from_attributes": True}


class ConversationOut(BaseModel):
    id: uuid.UUID
    type: ConversationType
    # Для group — название группы; для dm — имя ВТОРОГО участника (вычислено
    # на бэкенде, см. app/api/routes/messaging.py) — фронтенду не нужно
    # самому разбираться, кто есть кто в списке участников.
    display_name: str
    participant_count: int
    last_message_preview: str | None = None
    last_message_at: datetime | None = None
    unread_count: int = 0
    created_at: datetime
