"""category/warehouse manual ordering + independent tiered-pricing step length

Двадцатый проход (advisory-обзор, четыре согласованных пункта разом):

1. `equipment_categories.position` / `equipment_warehouses.position` — ручной
   порядок для перетаскивания в UI. Бэкафилл существующих записей — по
   алфавиту (тот порядок, в котором они и так показывались до этой миграции,
   см. app/api/routes/equipment.py: list_equipment_categories раньше сортировал
   по .name) — чтобы список визуально не "прыгнул" сразу после деплоя, пока
   владелец не перетащит что-то вручную в первый раз.

2. `equipment.after_period_days` / `rental_items.after_period_days_snapshot` —
   независимая длина "шага после" ступенчатого тарифа (п.4 обзора: раньше
   period_price_after всегда делился на period_days и размазывался ЛИНЕЙНО по
   дням — цену "190₽ в неделю" нельзя было ввести напрямую, приходилось
   пересчитывать в цену за сутки в уме; и даже так это была плавная, а не
   блочная надбавка). Новая механика (см. app/services/pricing.py:
   item_cost_for_days) — ПОЛНЫЙ ИЛИ НАЧАТЫЙ шаг длиной after_period_days дней
   стоит period_price_after целиком.

   Бэкафилл существующих строк (и в equipment, и в rental_items, у которых
   ступенчатый тариф уже настроен) выставляет after_period_days=1 и
   ПЕРЕСЧИТЫВАЕТ period_price_after = period_price_after / period_days —
   восстанавливая цену именно за ОДНИ сутки (тем же способом, каким её раньше
   вычисляла сама форма на фронте перед отправкой, см. EquipmentTab.tsx:
   periodPriceAfterPerDay/formToPayload ДО этого прохода). При шаге в 1 день
   "полный или начатый шаг" и "линейная надбавка по дням" дают ОДНО И ТО ЖЕ
   число (extra_days всегда целое) — то есть у уже существующих позиций и
   уже посчитанных аренд НИЧЕГО в итоговых суммах не меняется, только формат
   хранения становится однородным (после этой миграции ВСЕ строки с
   настроенным тарифом имеют явный after_period_days — см. докстринг
   Equipment.after_period_days: пропущенное значение остаётся только на
   случай сырого вызова item_cost_for_days с историческими аргументами
   напрямую, не через строку БД).
"""
from alembic import op
import sqlalchemy as sa

revision = "0011_equipment_ordering_and_tiered_pricing"
down_revision = "0010_equipment_warehouses"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("equipment_categories", sa.Column("position", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("equipment_warehouses", sa.Column("position", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("equipment", sa.Column("after_period_days", sa.Integer(), nullable=True))
    op.add_column("rental_items", sa.Column("after_period_days_snapshot", sa.Integer(), nullable=True))

    connection = op.get_bind()

    for table in ("equipment_categories", "equipment_warehouses"):
        rows = connection.execute(sa.text(f"SELECT id, business_id, name FROM {table}")).fetchall()
        by_business: dict = {}
        for row_id, business_id, name in rows:
            by_business.setdefault(business_id, []).append((row_id, name))
        for business_id, items in by_business.items():
            items.sort(key=lambda item: (item[1] or "").lower())
            for position, (row_id, _name) in enumerate(items):
                connection.execute(
                    sa.text(f"UPDATE {table} SET position = :position WHERE id = :id"),
                    {"position": position, "id": row_id},
                )

    connection.execute(
        sa.text(
            """
            UPDATE equipment
            SET period_price_after = period_price_after / period_days,
                after_period_days = 1
            WHERE period_price_after IS NOT NULL
              AND period_days IS NOT NULL
              AND period_days > 0
            """
        )
    )
    connection.execute(
        sa.text(
            """
            UPDATE rental_items
            SET period_price_after_snapshot = period_price_after_snapshot / period_days_snapshot,
                after_period_days_snapshot = 1
            WHERE period_price_after_snapshot IS NOT NULL
              AND period_days_snapshot IS NOT NULL
              AND period_days_snapshot > 0
            """
        )
    )

    # server_default только чтобы безопасно проставить существующие строки при
    # добавлении NOT NULL колонки одним махом — дальше приложение всегда шлёт
    # position явно (см. _next_category_position/_next_warehouse_position), а
    # не полагается на дефолт СУБД.
    with op.batch_alter_table("equipment_categories") as batch_op:
        batch_op.alter_column("position", server_default=None)
    with op.batch_alter_table("equipment_warehouses") as batch_op:
        batch_op.alter_column("position", server_default=None)


def downgrade() -> None:
    op.drop_column("rental_items", "after_period_days_snapshot")
    op.drop_column("equipment", "after_period_days")
    op.drop_column("equipment_warehouses", "position")
    op.drop_column("equipment_categories", "position")
