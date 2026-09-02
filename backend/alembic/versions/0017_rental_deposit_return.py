"""rentals.deposit_returned_at — возврат депозита клиенту

Revision ID: 0017_rental_deposit_return
Revises: 0016_rental_return_photos
Create Date: 2026-09-02

42-й проход, по итогам обзора ("что ещё доработать на Арендах"): отдельный
факт "депозит возвращён клиенту", независимый от самого закрытия аренды —
deposit_total (RentalOut) считается вживую по текущему Equipment.deposit
позиций и никогда не хранится суммой на аренде, поэтому "возвращён" не может
быть датой на уже существующем денежном поле. NULL = ещё не возвращён.

ВАЖНО (урок 0016-го прохода этой же сессии): id ревизии — НЕ то же самое,
что имя файла, но обязан помещаться в alembic_version.version_num — колонку
VARCHAR(32) в БД. Здесь "0017_rental_deposit_return" — 26 символов,
укладывается с запасом.
"""
from alembic import op
import sqlalchemy as sa

revision = "0017_rental_deposit_return"
down_revision = "0016_rental_return_photos"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("rentals", sa.Column("deposit_returned_at", sa.Date(), nullable=True))


def downgrade() -> None:
    op.drop_column("rentals", "deposit_returned_at")
