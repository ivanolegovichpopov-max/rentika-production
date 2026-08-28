"""Логотип бизнеса + отметка «выполнено» на записях доски заметок — оба
поля из одного раунда UX-доработок дашборда (2026-08-28), объединены в одну
миграцию, т.к. это два независимых, не связанных друг с другом простых
ALTER TABLE ADD COLUMN без каких-либо ENUM-типов (см. urgent-фикс 0006 и
заметки проекта про особенности sa.Enum в этом проекте — здесь просто не
применимо, оба новых поля не ENUM).

Revision ID: 0007_logo_and_note_done
Revises: 0006_messaging
Create Date: 2026-08-28

Что добавляется и зачем:

1. businesses.logo_url — логотип бизнеса, который видно в сайдбаре вместо
   дефолтной геометрической марки. Хранится как ссылка ИЛИ как data: URL
   (см. AccountSettings.tsx — загрузка файла читается через FileReader на
   фронте и шлётся уже готовой строкой; отдельного файлового хранилища у
   проекта нет, деплой на Render с эфемерным диском для этого не подходит).
   TEXT, а не String(255) — data: URL для небольшой картинки легко превышает
   255 символов; ограничение по размеру — на уровне Pydantic-схемы
   (BusinessLogoUpdate), не в БД.
2. dashboard_notes.done — простая отметка "выполнено" на отдельной записи
   доски "Заметки/новости" (см. NoteOut/NoteUpdate, app/api/routes/notes.py).
   Сознательно НЕ полноценный чек-лист/трекер задач — просто boolean,
   default false, NOT NULL.
"""
from alembic import op
import sqlalchemy as sa

revision = "0007_logo_and_note_done"
down_revision = "0006_messaging"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("businesses", sa.Column("logo_url", sa.Text(), nullable=True))

    op.add_column(
        "dashboard_notes",
        sa.Column("done", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    # server_default только для проставления значения существующим строкам —
    # дальше значение всегда приходит явно из кода (тот же паттерн, что и
    # notes_mode/messaging_permission в 0005/0006).
    op.alter_column("dashboard_notes", "done", server_default=None)


def downgrade() -> None:
    op.drop_column("dashboard_notes", "done")
    op.drop_column("businesses", "logo_url")
