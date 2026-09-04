"""users.last_login_at — момент последнего успешного входа

Revision ID: 0020_user_last_login
Revises: 0019_rental_extra_fee
Create Date: 2026-09-05

65-й проход, по итогам обзора страницы «Сотрудники» — "нигде не видно, кто
из команды давно не заходил". Раньше на User фиксировались только
created_at (когда завели аккаунт) и failed_login_attempts/locked_until
(защита от подбора), а самого факта успешного входа и его времени нигде не
было — ни при первом входе приглашённого сотрудника, ни при обычных
последующих. Проставляется в /auth/login при успешной проверке пароля (см.
app/api/routes/auth.py), читается на странице «Сотрудники» через тот же
join с User, что и email (app/api/routes/employees.py), только владельцу
бизнеса — как и email.

NULL по умолчанию (не server_default) — это не "давно, в незапамятные
времена", а "ни разу не входил" — на фронте эти два состояния должны
различаться текстом ("ни разу не входил" vs дата), а не выглядеть
одинаково нулевой датой.
"""
from alembic import op
import sqlalchemy as sa

revision = "0020_user_last_login"
down_revision = "0019_rental_extra_fee"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "last_login_at")
