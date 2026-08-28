"""Доска «Заметки/новости» на дашборде + смена формата DashboardPrefs.

Revision ID: 0005_dashboard_notes
Revises: 0004_employee_dashboard_prefs
Create Date: 2026-08-28

Что добавляется и зачем:

1. businesses.notes_mode — режим доски заметок дашборда: "owner_only" (пишет
   только владелец, остальные читают — сценарий "новости для сотрудников")
   или "everyone" (пишет любой активный сотрудник — сценарий "общие быстрые
   заметки команды"). По умолчанию owner_only — более консервативный вариант,
   существующие бизнесы получают его без явного действия владельца.
2. Новая таблица dashboard_notes — лента отдельных записей (не одно
   перезаписываемое поле: несколько человек могут писать одновременно без
   риска затереть чужую запись). employee_id — автор; author_name — снимок
   имени на момент публикации, чтобы запись оставалась читаемой даже после
   переименования/отключения сотрудника.

RLS на dashboard_notes сознательно не заводится — как и businesses/employees/
positions/permissions, эта таблица не входит в набор из 0001_initial
(equipment/clients/rentals/rental_items), изоляция по business_id — на уровне
прикладного кода (app/api/routes/notes.py), тем же способом, что и остальные
"метаданные" таблицы бизнеса.

Формат employees.dashboard_prefs (JSON-строка в существующей TEXT-колонке,
см. 0004) меняется на уровне Pydantic-схемы (app/schemas/business.py) без
миграции колонки: поле "labels" (переименование) убрано, добавлены
"stat_order"/"panel_rows" (перетаскивание). Старые сохранённые значения с
"labels" читаются без ошибки (pydantic по умолчанию игнорирует лишние поля),
просто больше не показывают custom-подписи — это осознанный компромисс ради
избежания двойной миграции данных ради ещё не пожившей фичи.
"""
from alembic import op
import sqlalchemy as sa

from app.db_types import GUID

revision = "0005_dashboard_notes"
down_revision = "0004_employee_dashboard_prefs"
branch_labels = None
depends_on = None

NOTES_MODE_VALUES = ("owner_only", "everyone")


def upgrade() -> None:
    bind = op.get_bind()

    notes_mode_enum = sa.Enum(*NOTES_MODE_VALUES, name="notes_mode")
    notes_mode_enum.create(bind, checkfirst=True)
    op.add_column(
        "businesses",
        sa.Column("notes_mode", notes_mode_enum, nullable=False, server_default="owner_only"),
    )
    # server_default нужен только чтобы проставить значение существующим
    # строкам при добавлении NOT NULL колонки; дальше значение всегда
    # приходит явно из кода (Business(...) / NotesModeUpdate), поэтому
    # снимаем default, чтобы не маскировать будущие баги пропуском поля.
    op.alter_column("businesses", "notes_mode", server_default=None)

    op.create_table(
        "dashboard_notes",
        sa.Column("id", GUID(), primary_key=True),
        sa.Column(
            "business_id",
            GUID(),
            sa.ForeignKey("businesses.id", ondelete="CASCADE"),
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
    op.create_index("ix_dashboard_notes_business_id", "dashboard_notes", ["business_id"])


def downgrade() -> None:
    bind = op.get_bind()
    op.drop_index("ix_dashboard_notes_business_id", table_name="dashboard_notes")
    op.drop_table("dashboard_notes")
    op.drop_column("businesses", "notes_mode")
    sa.Enum(*NOTES_MODE_VALUES, name="notes_mode").drop(bind, checkfirst=True)
