"""equipment categories directory + equipment.notes

Тринадцатый проход: жёсткий справочник категорий оборудования +
свободная заметка на позиции (по итогам разбора вкладки «Оборудование»
с пользователем, см. claude/notes.md).

Что добавляется и зачем:

1. equipment_categories — новая таблица-справочник (business_id, name,
   unique по паре). Создание записей в справочнике — привилегия
   исключительно владельца бизнеса (см. app/api/routes/equipment.py:
   create_equipment_category использует ctx.full_access), обычные роли с
   доступом на «Оборудование» только выбирают из уже существующих значений
   при заведении/редактировании позиции.
2. equipment.notes — свободный текст по позиции (Text, nullable).
3. Backfill: заполняем equipment_categories из уже существующих СЕЙЧАС
   различных значений equipment.category по каждому business_id — иначе
   уже занесённое оборудование указывало бы на несуществующие в справочнике
   категории сразу после миграции, и владелец бизнеса не смог бы
   отредактировать ни одну такую позицию (валидация на уровне API отклонила
   бы «неизвестную» категорию).

   ВАЖНО, явно проговорено пользователю отдельно: бэкафилл переносит ВСЕ
   различные строковые значения category как есть, включая заведомо
   «мусорные» (опечатки, дубли с разным регистром, случайные значения
   вроде «1»/«1111»/нецензурные слова, обнаруженные в демо-данных на момент
   проверки живого сайта в двенадцатом проходе) — это осознанный компромисс
   ради безопасности миграции (никаких упавших constraint'ов, никаких
   потерянных данных), а не эвристика «очистки» данных. После миграции
   такие записи в справочнике нужно будет вручную удалить/переименовать —
   это ручная работа владельца бизнеса, не то, что можно безопасно
   автоматизировать в миграции (нет способа программно отличить «хуйня» от
   легитимного короткого названия категории).
"""
import uuid

from alembic import op
import sqlalchemy as sa

from app.db_types import GUID

revision = "0008_equipment_categories"
down_revision = "0007_logo_and_note_done"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "equipment_categories",
        sa.Column("id", GUID(), primary_key=True),
        sa.Column("business_id", GUID(), sa.ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("business_id", "name", name="uq_equipment_category_business_name"),
    )
    op.create_index("ix_equipment_categories_business_id", "equipment_categories", ["business_id"])

    op.add_column("equipment", sa.Column("notes", sa.Text(), nullable=True))

    # Бэкафилл — по одной новой строке справочника на каждую уникальную пару
    # (business_id, category), уже встречающуюся в equipment. GUID —
    # приложенческий TypeDecorator (см. app/db_types.py), а не «сырой» тип
    # колонки, поэтому bindparam'ы ниже проходят через тот же
    # process_bind_param, что и обычные ORM-запросы — значение из
    # DISTINCT-выборки (уже нативный uuid.UUID на Postgres, единственном
    # диалекте, на котором эта миграция реально исполняется) передаётся как
    # есть, приводить вручную не нужно.
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
    existing = set()
    for business_id, category in rows:
        key = (business_id, category)
        if key in existing:
            continue
        existing.add(key)
        connection.execute(
            equipment_categories.insert().values(id=uuid.uuid4(), business_id=business_id, name=category)
        )


def downgrade() -> None:
    op.drop_column("equipment", "notes")
    op.drop_index("ix_equipment_categories_business_id", table_name="equipment_categories")
    op.drop_table("equipment_categories")
