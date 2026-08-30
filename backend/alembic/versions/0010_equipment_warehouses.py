"""equipment warehouses directory + equipment.warehouse

Восемнадцатый проход: по аналогии со справочником категорий (0008) — новый
справочник складов/точек продаж (для бизнесов с несколькими физическими
местами хранения оборудования), ровно та же механика: жёсткий справочник на
business_id, создание записей — только владелец бизнеса, остальные роли
выбирают из уже существующих значений.

В отличие от equipment.category (0008), поле equipment.warehouse — НОВОЕ,
у уже существующих позиций оборудования его никогда не было, поэтому:
- колонка nullable, без backfill'а (нечего переносить — до этого прохода
  ни у одной позиции склад не был задан никаким способом);
- equipment.category на момент 0008 был NOT NULL и уже существующим полем,
  отсюда там backfill был обязателен, чтобы не оставить позиции без
  категории, указывающей на несуществующую запись справочника. Здесь этой
  проблемы нет: NULL «нет склада» — легитимное, ожидаемое исходное состояние.
"""
from alembic import op
import sqlalchemy as sa

from app.db_types import GUID

revision = "0010_equipment_warehouses"
down_revision = "0009_backfill_missing_categories"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "equipment_warehouses",
        sa.Column("id", GUID(), primary_key=True),
        sa.Column("business_id", GUID(), sa.ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("business_id", "name", name="uq_equipment_warehouse_business_name"),
    )
    op.create_index("ix_equipment_warehouses_business_id", "equipment_warehouses", ["business_id"])

    op.add_column("equipment", sa.Column("warehouse", sa.String(length=255), nullable=True))


def downgrade() -> None:
    op.drop_column("equipment", "warehouse")
    op.drop_index("ix_equipment_warehouses_business_id", table_name="equipment_warehouses")
    op.drop_table("equipment_warehouses")
