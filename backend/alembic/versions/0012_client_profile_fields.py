"""client profile fields (type/reisites/discount/tags/blacklist reason) + journal

Revision ID: 0012_client_profile_fields
Revises: 0011_ordering_tiered_pricing
Create Date: 2026-08-31

Двадцать пятый проход (обзор «глазами обычного пользователя вкладки
«Клиенты»» — 10 согласованных пунктов разом, из которых схема БД касается:

1. `clients.client_type` (individual/company) + `contact_person`/`inn` —
   реквизиты для клиентов-организаций (юрлицо арендует, а не физлицо).
2. `clients.default_discount_percent` — умолчательная скидка клиента В
   ПРОЦЕНТАХ (0-100), подсказка при создании новой аренды (см.
   app/api/routes/rentals.py:create_rental) — переводится в фиксированную
   рублёвую Rental.discount один раз в момент создания.
3. `clients.tags` — свободные метки через запятую.
4. `clients.blacklist_reason` — причина занесения в чёрный список.
5. Новая таблица `client_notes` — журнал датированных записей по клиенту
   (в отличие от уже существующего `clients.notes`, который остаётся как
   есть — одно "текущее" поле-памятка, журнал — история отдельных заметок).

Все новые колонки clients NULLABLE, кроме client_type (backfill через
server_default, который сразу снимается — см. комментарий у notes_mode в
0005_dashboard_notes.py, тот же приём и по той же причине: default дальше
всегда приходит явно из кода, server_default был нужен только для бэкафилла
существующих строк при добавлении NOT NULL колонки).

sa.Enum на Postgres — ОТДЕЛЬНЫЙ именованный тип, который `op.add_column`
(в отличие от `Base.metadata.create_all`, использованного в 0001_initial для
СОЗДАНИЯ таблицы) сам не создаёт — тот же нюанс, что уже задокументирован и
решён в 0005_dashboard_notes.py (notes_mode): тип нужно явно
`.create(bind, checkfirst=True)` ДО op.add_column. Без этого шага миграция
падает на реальном Postgres с `UndefinedObject: type "client_type" does not
exist` — поймано локальным прогоном `alembic upgrade head` на реальном
Postgres 16 (SQLite в тестах эту ошибку не ловит: conftest.py строит схему
через Base.metadata.create_all с моделями напрямую, а не через alembic).

client_notes — RLS включена тем же способом и по тому же принципу, что и у
equipment/clients/rentals в 0001_initial (прямая политика по business_id,
своя колонка есть, в отличие от rental_items, где нужен подзапрос).
"""
from alembic import op
import sqlalchemy as sa

from app.db_types import GUID

revision = "0012_client_profile_fields"
down_revision = "0011_ordering_tiered_pricing"
branch_labels = None
depends_on = None

CLIENT_TYPE_VALUES = ("individual", "company")


def upgrade() -> None:
    bind = op.get_bind()

    client_type_enum = sa.Enum(*CLIENT_TYPE_VALUES, name="client_type")
    client_type_enum.create(bind, checkfirst=True)
    op.add_column(
        "clients",
        sa.Column("client_type", client_type_enum, nullable=False, server_default="individual"),
    )
    op.alter_column("clients", "client_type", server_default=None)

    op.add_column("clients", sa.Column("contact_person", sa.String(length=255), nullable=True))
    op.add_column("clients", sa.Column("inn", sa.String(length=32), nullable=True))
    op.add_column("clients", sa.Column("default_discount_percent", sa.Numeric(5, 2), nullable=True))
    op.add_column("clients", sa.Column("tags", sa.String(length=500), nullable=True))
    op.add_column("clients", sa.Column("blacklist_reason", sa.String(length=500), nullable=True))

    op.create_table(
        "client_notes",
        sa.Column("id", GUID(), primary_key=True),
        sa.Column("business_id", GUID(), sa.ForeignKey("businesses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("client_id", GUID(), sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("employee_id", GUID(), sa.ForeignKey("employees.id", ondelete="SET NULL"), nullable=True),
        sa.Column("text", sa.String(length=2000), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_client_notes_business_id", "client_notes", ["business_id"])
    op.create_index("ix_client_notes_client_id", "client_notes", ["client_id"])

    # RLS — только на реальном Postgres (специфика диалекта, SQLite в тестах
    # эти вызовы не проходит, см. conftest.py и комментарий в 0001_initial.py).
    if bind.dialect.name == "postgresql":
        bind.execute(sa.text("ALTER TABLE client_notes ENABLE ROW LEVEL SECURITY"))
        bind.execute(sa.text("ALTER TABLE client_notes FORCE ROW LEVEL SECURITY"))
        bind.execute(
            sa.text(
                """
                CREATE POLICY tenant_isolation ON client_notes
                USING (business_id::text = current_setting('app.rls.business_id', true))
                WITH CHECK (business_id::text = current_setting('app.rls.business_id', true))
                """
            )
        )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        bind.execute(sa.text("DROP POLICY IF EXISTS tenant_isolation ON client_notes"))
    op.drop_index("ix_client_notes_client_id", table_name="client_notes")
    op.drop_index("ix_client_notes_business_id", table_name="client_notes")
    op.drop_table("client_notes")
    op.drop_column("clients", "blacklist_reason")
    op.drop_column("clients", "tags")
    op.drop_column("clients", "default_discount_percent")
    op.drop_column("clients", "inn")
    op.drop_column("clients", "contact_person")
    op.drop_column("clients", "client_type")
    sa.Enum(*CLIENT_TYPE_VALUES, name="client_type").drop(bind, checkfirst=True)
