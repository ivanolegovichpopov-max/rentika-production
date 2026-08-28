"""Личные сообщения (профильные «личные кабинеты» сотрудников, часть 1) —
диалоги 1-на-1 и группы + настройка «кто кому может писать».

Revision ID: 0006_messaging
Revises: 0005_dashboard_notes
Create Date: 2026-08-28

Что добавляется и зачем:

1. businesses.messaging_permission — режим личных сообщений: "owner_only"
   (по умолчанию — обычный сотрудник может писать только владельцу бизнеса,
   группы создавать не может) или "everyone" (любой активный сотрудник может
   написать любому другому и создавать группы). Отдельная настройка от
   notes_mode (0005) и от ACL-права "employees" — см. app/models/messaging.py
   и app/api/routes/messaging.py про разграничение.
2. conversations — один диалог: dm (1-на-1, name всегда NULL) или group
   (name обязателен — это и есть «канал»/групповой чат).
3. conversation_participants — членство в диалоге + last_read_at (для
   счётчика непрочитанных); уникальность (conversation_id, employee_id).
4. messages — сами сообщения, лента (append-only, как dashboard_notes из
   0005), author_name — снимок имени на момент отправки.

Приватность: доступ к диалогу — только у его участников, даже владелец
бизнеса (full_access) не читает чужую переписку, в которой сам не состоит —
это соблюдается на уровне прикладного кода (app/api/routes/messaging.py),
не на уровне БД/RLS, тем же способом, что и остальные «метаданные» таблицы
бизнеса (dashboard_notes, employees, positions, permissions — вне набора
0001_initial с его RLS на equipment/clients/rentals/rental_items).
"""
from alembic import op
import sqlalchemy as sa

from app.db_types import GUID

revision = "0006_messaging"
down_revision = "0005_dashboard_notes"
branch_labels = None
depends_on = None

MESSAGING_PERMISSION_VALUES = ("owner_only", "everyone")
CONVERSATION_TYPE_VALUES = ("dm", "group")


def upgrade() -> None:
    bind = op.get_bind()

    messaging_permission_enum = sa.Enum(*MESSAGING_PERMISSION_VALUES, name="messaging_permission")
    messaging_permission_enum.create(bind, checkfirst=True)
    op.add_column(
        "businesses",
        sa.Column("messaging_permission", messaging_permission_enum, nullable=False, server_default="owner_only"),
    )
    # server_default только для проставления значения существующим строкам —
    # дальше значение всегда приходит явно из кода (см. 0005 для того же
    # паттерна с notes_mode).
    op.alter_column("businesses", "messaging_permission", server_default=None)

    conversation_type_enum = sa.Enum(*CONVERSATION_TYPE_VALUES, name="conversation_type")
    conversation_type_enum.create(bind, checkfirst=True)

    op.create_table(
        "conversations",
        sa.Column("id", GUID(), primary_key=True),
        sa.Column(
            "business_id",
            GUID(),
            sa.ForeignKey("businesses.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("type", conversation_type_enum, nullable=False),
        sa.Column("name", sa.String(length=255), nullable=True),
        sa.Column(
            "created_by_employee_id",
            GUID(),
            sa.ForeignKey("employees.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_conversations_business_id", "conversations", ["business_id"])

    op.create_table(
        "conversation_participants",
        sa.Column("id", GUID(), primary_key=True),
        sa.Column(
            "conversation_id",
            GUID(),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "employee_id",
            GUID(),
            sa.ForeignKey("employees.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("last_read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("joined_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("conversation_id", "employee_id", name="uq_conversation_participant"),
    )
    op.create_index("ix_conversation_participants_conversation_id", "conversation_participants", ["conversation_id"])
    op.create_index("ix_conversation_participants_employee_id", "conversation_participants", ["employee_id"])

    op.create_table(
        "messages",
        sa.Column("id", GUID(), primary_key=True),
        sa.Column(
            "conversation_id",
            GUID(),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "employee_id",
            GUID(),
            sa.ForeignKey("employees.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("author_name", sa.String(length=255), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_messages_conversation_id", "messages", ["conversation_id"])
    op.create_index("ix_messages_created_at", "messages", ["created_at"])


def downgrade() -> None:
    bind = op.get_bind()
    op.drop_index("ix_messages_created_at", table_name="messages")
    op.drop_index("ix_messages_conversation_id", table_name="messages")
    op.drop_table("messages")
    op.drop_index("ix_conversation_participants_employee_id", table_name="conversation_participants")
    op.drop_index("ix_conversation_participants_conversation_id", table_name="conversation_participants")
    op.drop_table("conversation_participants")
    op.drop_index("ix_conversations_business_id", table_name="conversations")
    op.drop_table("conversations")
    sa.Enum(*CONVERSATION_TYPE_VALUES, name="conversation_type").drop(bind, checkfirst=True)
    op.drop_column("businesses", "messaging_permission")
    sa.Enum(*MESSAGING_PERMISSION_VALUES, name="messaging_permission").drop(bind, checkfirst=True)
