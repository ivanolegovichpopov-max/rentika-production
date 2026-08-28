"""Личные сообщения между сотрудниками одного бизнеса — новая функция без
аналога в демо-прототипе, спроектирована по запросу пользователя ("выполни в
лучшем виде по своему мнению" для деталей, часть решений — по прямому ТЗ:
поддержка групп/каналов, право переписки зависит от роли).

Модель — Conversation (диалог 1-на-1 ИЛИ группа) + ConversationParticipant
(кто состоит в диалоге + когда последний раз читал — для счётчика
непрочитанных) + Message (сами сообщения, лента, как и DashboardNote —
никогда не перезаписываются, только добавляются).

Важное архитектурное решение о приватности: доступ к диалогу (чтение и
отправка) даётся ТОЛЬКО его участникам — ctx.full_access (владелец бизнеса,
платформенный админ) НЕ даёт автоматического доступа к чужой переписке, в
отличие от остальных ресурсов бизнеса (клиенты/аренды/финансы), которые
владелец видит целиком по определению. Личные сообщения — это личная
переписка людей, а не бизнес-данные компании, поэтому даже владелец бизнеса
должен быть явным участником диалога, чтобы его читать. full_access всё ещё
даёт право менять business.messaging_permission (кто кому может писать) —
но не читать чужие уже созданные диалоги."""
import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.db_types import GUID


class ConversationType(str, enum.Enum):
    dm = "dm"
    group = "group"


class Conversation(Base):
    """Один диалог — либо 1-на-1 (dm, ровно 2 участника, name всегда NULL —
    отображаемое имя вычисляется на бэкенде как имя ВТОРОГО участника, см.
    app/api/routes/messaging.py), либо группа (group, 2+ участников,
    name обязателен — это и есть "канал"/групповой чат)."""

    __tablename__ = "conversations"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    business_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    type: Mapped[ConversationType] = mapped_column(Enum(ConversationType, name="conversation_type"), nullable=False)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by_employee_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("employees.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ConversationParticipant(Base):
    """Членство сотрудника в диалоге. last_read_at — момент, когда участник
    последний раз открывал ленту сообщений этого диалога (проставляется при
    GET .../messages) — разница между last_read_at и created_at сообщений
    даёт счётчик непрочитанных без отдельной таблицы "прочитано/не
    прочитано" на каждое сообщение."""

    __tablename__ = "conversation_participants"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    employee_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("employees.id", ondelete="CASCADE"), nullable=False, index=True
    )
    last_read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("conversation_id", "employee_id", name="uq_conversation_participant"),
    )


class Message(Base):
    """Одно сообщение в диалоге — лента, как и DashboardNote: сообщения
    никогда не редактируются/не перезаписываются, только добавляются и
    (опционально) удаляются автором. author_name — снимок имени на момент
    отправки, тем же принципом, что и у DashboardNote.author_name."""

    __tablename__ = "messages"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    employee_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("employees.id", ondelete="CASCADE"), nullable=False
    )
    author_name: Mapped[str] = mapped_column(String(255), nullable=False)
    text: Mapped[str] = mapped_column(Text(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
