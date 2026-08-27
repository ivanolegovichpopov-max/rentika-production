"""Заметки о состоянии оборудования при выдаче/возврате аренды.

Revision ID: 0003_rental_notes
Revises: 0002_client_rental_fields
Create Date: 2026-08-27

Что добавляется и зачем:

1. rentals.issue_notes — свободный текст состояния на момент выдачи (демо:
   r.issueNotes), печатается на акте приёма-передачи.
2. rentals.return_notes — свободный текст состояния на момент возврата (демо:
   r.returnNotes), печатается на акте возврата.

Обе колонки NULLABLE — существующие строки не требуют бэкфилла; дефолтный
текст ("Комплектация полная, состояние исправное." / "Без повреждений,
комплектация полная.") подставляется в коде эндпоинта, а не на уровне БД,
ровно как в демо-прототипе (значение по умолчанию в textarea формы, а не
в данных). Тип VARCHAR(1000) одинаково поддерживается SQLite (тесты) и
Postgres (прод).
"""
from alembic import op
import sqlalchemy as sa

revision = "0003_rental_notes"
down_revision = "0002_client_rental_fields"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("rentals", sa.Column("issue_notes", sa.String(length=1000), nullable=True))
    op.add_column("rentals", sa.Column("return_notes", sa.String(length=1000), nullable=True))


def downgrade() -> None:
    op.drop_column("rentals", "return_notes")
    op.drop_column("rentals", "issue_notes")
