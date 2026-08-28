"""Личные настройки дашборда сотрудника (скрытые блоки, переименованные подписи).

Revision ID: 0004_employee_dashboard_prefs
Revises: 0003_rental_notes
Create Date: 2026-08-28

Что добавляется и зачем:

employees.dashboard_prefs — TEXT-колонка с JSON-строкой вида
{"hidden": ["stat-active", ...], "labels": {"stat-active": "Своя подпись"}}.
Пользователь попросил возможность скрывать отдельные плашки/панели дашборда
и переименовывать их лично для себя, не влияя на остальных сотрудников
бизнеса — поэтому настройка живёт на Employee (человек+конкретный бизнес),
а не на User (один человек может состоять в нескольких бизнесах и настраивать
дашборд каждого независимо) и не в общих настройках бизнеса (иначе
переименование одним сотрудником поменяло бы подписи всем).
NULLABLE, без бэкфилла — NULL трактуется кодом как "настроек ещё нет,
показывать всё по умолчанию".
"""
from alembic import op
import sqlalchemy as sa

revision = "0004_employee_dashboard_prefs"
down_revision = "0003_rental_notes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("employees", sa.Column("dashboard_prefs", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("employees", "dashboard_prefs")
