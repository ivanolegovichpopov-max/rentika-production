"""Поля для портирования UI/аналитики демо-прототипа на clients и rentals.

Revision ID: 0002_client_rental_fields
Revises: 0001_initial
Create Date: 2026-08-27

Что добавляется и зачем:

1. clients.email — простой текст без уникальности: у одного бизнеса разные
   клиенты вполне могут указать один и тот же email (общая почта семьи/фирмы).
2. clients.doc — номер паспорта/иного документа для договора, свободный текст.
3. rentals.discount — фиксированная скидка в рублях (не процент), вручную
   вводится сотрудником при возврате, по умолчанию 0.

Все три колонки NULLABLE или со значением по умолчанию — существующие строки
не требуют бэкфилла. Типы (String/Numeric) те же, что уже используются в
0001_initial для аналогичных полей, и одинаково поддерживаются и SQLite
(тесты), и Postgres (прод).
"""
from alembic import op
import sqlalchemy as sa

revision = "0002_client_rental_fields"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("clients", sa.Column("email", sa.String(length=255), nullable=True))
    op.add_column("clients", sa.Column("doc", sa.String(length=255), nullable=True))
    op.add_column(
        "rentals",
        sa.Column("discount", sa.Numeric(12, 2), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("rentals", "discount")
    op.drop_column("clients", "doc")
    op.drop_column("clients", "email")
