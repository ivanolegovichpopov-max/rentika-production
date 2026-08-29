"""idempotent catch-up backfill for equipment_categories

Пятнадцатый проход (advisory-обзор вкладки «Оборудование», пункт 1): при
живой проверке production-сайта обнаружено, что справочник категорий
(`equipment_categories`, заведённый миграцией 0008) не содержит записи для
части реально используемых значений `equipment.category` — конкретно, у
бизнеса пользователя в справочнике была только одна запись («хуйня»,
созданная уже ПОСЛЕ деплоя через обычное создание оборудования), хотя в
`equipment` на тот момент уже присутствовали позиции с категориями «1»,
«1111» и «222», созданными ДО того, как бэкафилл миграции 0008 фактически
выполнился на проде (подтверждено по логам: `Running upgrade
0007_logo_and_note_done -> 0008_equipment_categories` — 2026-08-28
22:50:42Z, тогда как эти позиции оборудования созданы раньше).

Точная причина, почему бэкафилл 0008 не подхватил их, не установлена —
прямой SQL-доступ к production-базе недоступен из этой среды (сам код
бэкафилла идентичен по логике и был отдельно проверен на реальном локальном
Postgres при разработке 0008, и там отработал корректно). Эта миграция —
защитный, идемпотентный «догоняющий» проход той же логики, а не точечный
фикс конкретной причины: безопасно выполнять её и на базе, где 0008 отработал
полностью верно (тогда она просто ничего не вставит), и на любой базе,
где по каким-то причинам справочник разошёлся с реальными данными.

Отличие от бэкафилла 0008: сравнение при проверке "уже есть ли такая
категория" — БЕЗ учёта регистра (см. app/api/routes/equipment.py:
_ensure_category, тоже переведённый на регистронезависимое сравнение в этом
же проходе), чтобы не создать вторую запись для категории, отличающейся
только регистром от уже существующей.
"""
import uuid

from alembic import op
import sqlalchemy as sa

from app.db_types import GUID

revision = "0009_backfill_missing_categories"
down_revision = "0008_equipment_categories"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    equipment_categories = sa.table(
        "equipment_categories",
        sa.column("id", GUID()),
        sa.column("business_id", GUID()),
        sa.column("name", sa.String()),
    )

    rows = connection.execute(
        sa.text("SELECT DISTINCT business_id, category FROM equipment WHERE category IS NOT NULL")
    ).fetchall()

    inserted = 0
    for business_id, category in rows:
        exists = connection.execute(
            sa.text(
                "SELECT 1 FROM equipment_categories WHERE business_id = :bid AND lower(name) = lower(:name) LIMIT 1"
            ),
            {"bid": business_id, "name": category},
        ).first()
        if exists is not None:
            continue
        connection.execute(
            equipment_categories.insert().values(id=uuid.uuid4(), business_id=business_id, name=category)
        )
        inserted += 1
    print(f"0009_backfill_missing_categories: добавлено недостающих записей справочника: {inserted}")


def downgrade() -> None:
    # Намеренно no-op: у этой миграции нет надёжного способа отличить
    # «строки, вставленные именно этим проходом» от тех, что уже были в
    # справочнике (в т.ч. от бэкафилла 0008) — удалять эти записи на
    # downgrade небезопасно, так как часть из них могла быть создана
    # обычным пользовательским сценарием (auto-create категории владельцем)
    # уже ПОСЛЕ применения этой миграции. Полная отмена справочника
    # (включая эти строки) по-прежнему доступна через downgrade 0008.
    pass
