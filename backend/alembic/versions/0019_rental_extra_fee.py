"""rentals.extra_fee / extra_fee_note — доп. услуги аренды

Revision ID: 0019_rental_extra_fee
Revises: 0018_rental_paid_amount
Create Date: 2026-09-03

46-й проход, по итогам обсуждения "бывает нужно принять с клиента доп.
сумму — за доставку, за накачку SUP-борда". В ОТЛИЧИЕ от paid_amount
(0018) и damage_fee — это ОДНО значение, заменяемое целиком, а не
накопительная сумма нескольких заходов: тот же принцип, что и discount —
сотрудник вписывает сумму при создании аренды или правит её позже через
"Изменить", не добавляя платёж поверх платежа. extra_fee входит в total
наравне с damage_fee (см. app/services/pricing.py:compute_rental_breakdown).

extra_fee_note — короткая свободная подпись (например "Доставка + накачка
SUP"), чтобы в акте и в журнале изменений было видно, за что взяли деньги,
а не голая цифра. Сознательно свободный текст без отдельного справочника
услуг: стоимость каждый раз своя (разный адрес доставки), справочник тут
не помогает, только один общий label. VARCHAR(200) с запасом — это подпись
одной строкой, а не отдельное текстовое поле.

default=0 (не NULL) у extra_fee — тот же принцип, что и paid_amount:
проще для сравнений на фронте без постоянных проверок на null у старых
записей.

ВАЖНО (урок 0016-го прохода): id ревизии — НЕ то же самое, что имя файла,
но обязан помещаться в alembic_version.version_num — колонку VARCHAR(32) в
БД. Здесь "0019_rental_extra_fee" — 22 символа, укладывается с запасом.
"""
from alembic import op
import sqlalchemy as sa

revision = "0019_rental_extra_fee"
down_revision = "0018_rental_paid_amount"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "rentals",
        sa.Column("extra_fee", sa.Numeric(12, 2), nullable=False, server_default="0"),
    )
    op.add_column(
        "rentals",
        sa.Column("extra_fee_note", sa.String(length=200), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("rentals", "extra_fee_note")
    op.drop_column("rentals", "extra_fee")
