"""employees.phone/notes/photo_url, positions.color/description

Revision ID: 0022_employee_position_extras
Revises: 0021_position_sort_and_2fa
Create Date: 2026-09-05

67-й проход, по итогам обзора страницы «Сотрудники»:
- у сотрудника не было ни телефона, ни заметок владельца о нём, ни фото
  (только инициалы) — карточка сотрудника была заметно беднее карточки
  клиента (ClientNote, phone там давно есть);
- у должности не было ни цвета, ни описания обязанностей — все карточки
  на вкладке «Должности и права» выглядели одинаково, кроме названия.

Все пять колонок NULL по умолчанию — существующие сотрудники/должности
ничего не теряют и не требуют бэкфилла.
"""
from alembic import op
import sqlalchemy as sa

revision = "0022_employee_position_extras"
down_revision = "0021_position_sort_and_2fa"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("employees", sa.Column("phone", sa.String(length=64), nullable=True))
    op.add_column("employees", sa.Column("notes", sa.Text(), nullable=True))
    op.add_column("employees", sa.Column("photo_url", sa.Text(), nullable=True))
    op.add_column("positions", sa.Column("color", sa.String(length=20), nullable=True))
    op.add_column("positions", sa.Column("description", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("positions", "description")
    op.drop_column("positions", "color")
    op.drop_column("employees", "photo_url")
    op.drop_column("employees", "notes")
    op.drop_column("employees", "phone")
