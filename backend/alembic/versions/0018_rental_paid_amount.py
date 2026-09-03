"""rentals.paid_amount — учёт оплаты аренды

Revision ID: 0018_rental_paid_amount
Revises: 0017_rental_deposit_return
Create Date: 2026-09-03

46-й проход, по итогам обзора ("чего не хватает на главной странице") —
единственный явно отсутствующий, а не косметический пробел: total
(app/services/pricing.py:compute_rental_breakdown) считается вживую и может
расти со временем (просрочка), депозит тоже не хранится суммой на аренде
(см. 0017) — но того, оплатил ли клиент саму аренду, не было нигде вообще.

paid_amount — накопительная сумма, а не единственный платёж: сотрудник
может получать деньги за одну аренду несколькими заходами (депозит при
брони, остаток при возврате), поэтому POST .../payment (см.
app/api/routes/rentals.py) ДОБАВЛЯЕТ переданную сумму к уже накопленной, тем
же принципом, что и damage_fee при частичном возврате (0016/п.6 обзора того
прохода), а не заменяет её. Остаток к оплате (total - paid_amount) нигде не
хранится — считается на лету на фронте, тем же принципом, что и
deposit_total.

default=0 (не NULL) — проще для сравнений на фронте (total > paid_amount)
без постоянных проверок на null у старых записей; NOT NULL с server_default
безопасен для уже существующих строк при апгрейде.

ВАЖНО (урок 0016-го прохода): id ревизии — НЕ то же самое, что имя файла, но
обязан помещаться в alembic_version.version_num — колонку VARCHAR(32) в БД.
Здесь "0018_rental_paid_amount" — 24 символа, укладывается с запасом.
"""
from alembic import op
import sqlalchemy as sa

revision = "0018_rental_paid_amount"
down_revision = "0017_rental_deposit_return"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "rentals",
        sa.Column("paid_amount", sa.Numeric(12, 2), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("rentals", "paid_amount")
