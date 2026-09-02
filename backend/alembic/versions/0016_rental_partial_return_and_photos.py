"""rental_items.returned_at + rental_photos — частичный возврат и фотофиксация

Revision ID: 0016_rental_return_photos
Revises: 0015_client_document_label
Create Date: 2026-09-02

41-й проход, по итогам обзора вкладки "Аренды" (пользователь согласился со
всем списком доработок разом): два независимых, но заведённых одной
миграцией изменения —

1. rental_items.returned_at (nullable) — позволяет вернуть часть позиций
   аренды раньше остальных, освобождая конкретную единицу оборудования для
   новой брони, не дожидаясь закрытия всей сделки целиком. NULL для всех
   существующих записей — обратная совместимость: старые аренды просто
   выглядят так, будто ни одна позиция ещё не возвращена по отдельности
   (что для уже завершённых или ещё активных аренд без частичного возврата
   и есть правда — см. app/api/routes/rentals.py:return_rental, полный
   возврат теперь тоже проставляет это поле всем позициям разом).

2. rental_photos — новая таблица, 1-в-1 по структуре с client_documents
   (см. 0015), плюс rental_id и stage (issue/return).
"""
from alembic import op
import sqlalchemy as sa

from app.db_types import GUID

# ВАЖНО: id ревизии — НЕ то же самое, что имя файла (файл может называться
# как угодно длинно ради читаемости, Alembic ссылается только на строки
# revision/down_revision). Сам id обязан помещаться в
# alembic_version.version_num — колонку VARCHAR(32) в БД. Изначальный
# длинный id "0016_rental_partial_return_and_photos" (37 символов) уронил
# деплой прямо на UPDATE alembic_version ("value too long for type
# character varying(32)") — транзакционный DDL успел откатиться сам, но
# урок на будущее: id ревизии всегда короче 32 символов, даже когда имя
# файла для читаемости длиннее.
revision = "0016_rental_return_photos"
down_revision = "0015_client_document_label"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("rental_items", sa.Column("returned_at", sa.Date(), nullable=True))

    op.create_table(
        "rental_photos",
        sa.Column("id", GUID(), primary_key=True),
        sa.Column("business_id", GUID(), sa.ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("rental_id", GUID(), sa.ForeignKey("rentals.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("employee_id", GUID(), sa.ForeignKey("employees.id", ondelete="SET NULL"), nullable=True),
        # Значения ПЕРЕЧИСЛЕНИЯ в БД — "issue"/"return" (см. values_callable
        # у RentalPhoto.stage в app/models/inventory.py: хранится .value
        # enum'а, а не .name атрибута Python, который для return —
        # зарезервированного слова — называется return_).
        sa.Column("stage", sa.Enum("issue", "return", name="rental_photo_stage"), nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=100), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("data_base64", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("rental_photos")
    sa.Enum(name="rental_photo_stage").drop(op.get_bind(), checkfirst=True)
    op.drop_column("rental_items", "returned_at")
