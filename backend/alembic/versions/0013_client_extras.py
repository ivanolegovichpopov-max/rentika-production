"""client extras: birthday, additional contacts, document attachments

Revision ID: 0013_client_extras
Revises: 0012_client_profile_fields
Create Date: 2026-08-31

Двадцать шестой проход (обзор вкладки «Клиенты» и карточки клиента —
профессиональный взгляд + «глазами обычного пользователя», согласовано
целиком: "Согласен со всем, делаем всё"). Схемы БД касаются три пункта:

1. `clients.birthday` — дата рождения (nullable, date, без времени —
   день рождения интересен только как календарная дата, не момент времени).
   Используется для фильтра "Дни рождения на этой неделе" на фронте
   (тот же принцип "спящих" клиентов — считается на фронте из уже
   загруженного списка, отдельного эндпоинта не требует).

2. `clients.additional_contacts` — доп. контакты клиента-организации
   (имя/роль/телефон), JSON-список объектов. Сознательно НЕ отдельная
   таблица с FK (как client_notes) — в отличие от журнала, у доп. контактов
   нет своего времени/автора/истории изменений, это просто структурированный
   довесок к карточке, который целиком перезаписывается при каждом
   сохранении формы (as-is список, тот же характер данных, что и
   `tags`/тем более `contact_person`, только их несколько). JSON, а не CSV-
   строка (как tags) — потому что у каждой записи три поля, а не одно.

3. Новая таблица `client_documents` — прикреплённые сканы/фото документов
   клиента (паспорт, доверенность и т.п.). Хранится как base64 в текстовой
   колонке, а не бинарём/внешним хранилищем — в проекте нет и не было
   настроенного объектного хранилища (S3/аналоги), заводить его ради вложений
   в карточку клиента было бы непропорционально; для объёма файлов, разумного
   для скана документа (лимит 5 МБ на файл, проверяется и на фронте, и здесь
   на бэкенде — см. app/api/routes/clients.py), Postgres TEXT/SQLite TEXT
   отлично справляются. RLS — тем же способом и по тому же принципу, что и
   у client_notes в 0012 (прямая политика по business_id, своя колонка есть).
"""
from alembic import op
import sqlalchemy as sa

from app.db_types import GUID

revision = "0013_client_extras"
down_revision = "0012_client_profile_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()

    op.add_column("clients", sa.Column("birthday", sa.Date(), nullable=True))
    op.add_column("clients", sa.Column("additional_contacts", sa.JSON(), nullable=True))

    op.create_table(
        "client_documents",
        sa.Column("id", GUID(), primary_key=True),
        sa.Column("business_id", GUID(), sa.ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("client_id", GUID(), sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("employee_id", GUID(), sa.ForeignKey("employees.id", ondelete="SET NULL"), nullable=True),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=100), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("data_base64", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_client_documents_business_id", "client_documents", ["business_id"])
    op.create_index("ix_client_documents_client_id", "client_documents", ["client_id"])

    if bind.dialect.name == "postgresql":
        bind.execute(sa.text("ALTER TABLE client_documents ENABLE ROW LEVEL SECURITY"))
        bind.execute(sa.text("ALTER TABLE client_documents FORCE ROW LEVEL SECURITY"))
        bind.execute(
            sa.text(
                """
                CREATE POLICY tenant_isolation ON client_documents
                USING (business_id::text = current_setting('app.rls.business_id', true))
                WITH CHECK (business_id::text = current_setting('app.rls.business_id', true))
                """
            )
        )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        bind.execute(sa.text("DROP POLICY IF EXISTS tenant_isolation ON client_documents"))
    op.drop_index("ix_client_documents_client_id", table_name="client_documents")
    op.drop_index("ix_client_documents_business_id", table_name="client_documents")
    op.drop_table("client_documents")
    op.drop_column("clients", "additional_contacts")
    op.drop_column("clients", "birthday")
