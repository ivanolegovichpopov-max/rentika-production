"""positions.sort_order + positions.require_2fa

Revision ID: 0021_position_sort_and_2fa
Revises: 0020_user_last_login
Create Date: 2026-09-05

66-й проход, по итогам обзора страницы «Сотрудники» (под-вкладка «Должности
и права»):

1. sort_order — ручной порядок карточек должностей для перетаскивания в UI,
   тот же idiom, что EquipmentCategory.position/EquipmentWarehouse.position
   (см. 0011_equipment_ordering_and_tiered_pricing.py) — НЕ уникально и НЕ
   обязательно плотное, важен только относительный порядок внутри бизнеса.
   Названо sort_order, а не "position" (как у категорий/складов), чтобы не
   путать с самим понятием "должность" на этой модели — Position.position
   читалось бы двусмысленно. Бэкафилл существующих строк — по алфавиту
   (title), тем же приёмом, что и в 0011, чтобы порядок списка не "прыгнул"
   сразу после миграции у тех, у кого уже есть несколько должностей.
2. require_2fa — владелец может пометить должность как требующую
   двухфакторную аутентификацию: сотрудник с такой должностью и без включённой
   2FA не получит доступа ни к одному business-scoped эндпоинту (см. проверку
   в app/core/deps.py::get_business_context), пока не включит 2FA в профиле.
   default False — ничего не меняется для существующих должностей, пока
   владелец явно не включит требование.
"""
from alembic import op
import sqlalchemy as sa

revision = "0021_position_sort_and_2fa"
down_revision = "0020_user_last_login"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("positions", sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"))
    op.add_column(
        "positions",
        sa.Column("require_2fa", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    # Бэкафилл по алфавиту — только для уже существующих строк (server_default
    # выше и так проставил бы всем 0, из-за чего порядок совпал бы с
    # созданием, а не с алфавитом; для новых бизнесов, заведённых уже ПОСЛЕ
    # этой миграции, порядок изначально пуст (0) и задаётся при создании
    # должности в app/api/routes/positions.py, как и у категорий/складов).
    connection = op.get_bind()
    business_ids = connection.execute(sa.text("SELECT DISTINCT business_id FROM positions")).scalars().all()
    for business_id in business_ids:
        rows = connection.execute(
            sa.text("SELECT id FROM positions WHERE business_id = :b ORDER BY title"),
            {"b": business_id},
        ).scalars().all()
        for index, position_id in enumerate(rows):
            connection.execute(
                sa.text("UPDATE positions SET sort_order = :o WHERE id = :id"),
                {"o": index, "id": position_id},
            )
    # server_default снимаем после бэкафилла — как и у остальных подобных
    # колонок в проекте, значение по умолчанию нужно только на момент миграции.
    op.alter_column("positions", "sort_order", server_default=None)
    op.alter_column("positions", "require_2fa", server_default=None)


def downgrade() -> None:
    op.drop_column("positions", "require_2fa")
    op.drop_column("positions", "sort_order")
