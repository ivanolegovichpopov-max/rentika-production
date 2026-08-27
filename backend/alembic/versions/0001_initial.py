"""Начальная схема: таблицы + прикладная роль БД + Row Level Security.

Revision ID: 0001_initial
Revises:
Create Date: 2026-08-26

Что делает эта миграция и зачем каждая часть:

1. Создаёт все таблицы (через Base.metadata.create_all — модели уже
   полностью описывают схему в app/models/*, дублировать её здесь ручными
   op.create_table было бы источником рассинхрона).
2. Создаёт ограниченную роль `rentika_app`, под которой работает backend
   в обычном режиме (НЕ суперпользователь) — без этого RLS ниже была бы
   бесполезной декорацией: владелец таблицы и суперпользователь Postgres
   обходят RLS по умолчанию.
3. Включает RLS на четырёх "арендных" таблицах (equipment/clients/rentals/
   rental_items) и создаёт политики, читающие сессионную переменную
   `app.rls.business_id` — её выставляет FastAPI-приложение в начале каждого
   business-scoped запроса (см. app/database.py:set_tenant_context).
   Это тот же принцип defense-in-depth, что был в Supabase-версии проекта:
   даже баг в проверке business_id на уровне Python-кода не даст утечь
   данным одного тенанта в ответ другому.
"""
from alembic import op
import sqlalchemy as sa

from app.database import Base
from app import models  # noqa: F401

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None

TENANT_TABLES = ["equipment", "clients", "rentals", "rental_items"]

APP_ROLE = "rentika_app"


def upgrade() -> None:
    bind = op.get_bind()

    Base.metadata.create_all(bind=bind)

    # --- Ограниченная роль для приложения (если подключение это позволяет) ---
    # На своём сервере миграция подключается суперпользователем (см.
    # DATABASE_ADMIN_URL) и может создать отдельную роль rentika_app без
    # CREATEROLE/SUPERUSER — под ней и работает backend. На управляемых
    # Postgres некоторых облачных провайдеров (например Render) выданная
    # роль сама не суперпользователь и не может создавать другие роли —
    # в этом случае используем ту же роль напрямую: FORCE ROW LEVEL SECURITY
    # ниже применяется к ЛЮБОЙ роли без атрибута BYPASSRLS, включая владельца
    # таблицы, так что изоляция тенантов работает и без отдельной роли.
    can_create_role = bool(
        bind.execute(
            sa.text("SELECT rolcreaterole OR rolsuper FROM pg_roles WHERE rolname = current_user")
        ).scalar()
    )

    if can_create_role:
        bind.execute(
            sa.text(
                f"""
                DO $$
                BEGIN
                    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '{APP_ROLE}') THEN
                        CREATE ROLE {APP_ROLE} LOGIN PASSWORD 'changeme' NOSUPERUSER NOBYPASSRLS;
                    END IF;
                END
                $$;
                """
            )
        )
        bind.execute(sa.text(f"GRANT USAGE ON SCHEMA public TO {APP_ROLE}"))
        bind.execute(sa.text(f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {APP_ROLE}"))
        bind.execute(sa.text(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {APP_ROLE}"))
        bind.execute(
            sa.text(
                f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {APP_ROLE}"
            )
        )

    # --- RLS ---
    # rental_items не хранит business_id напрямую (он есть у родительской
    # rentals) — политика идёт через подзапрос к rentals.business_id.
    for table in ["equipment", "clients", "rentals"]:
        bind.execute(sa.text(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY"))
        bind.execute(sa.text(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY"))
        bind.execute(
            sa.text(
                f"""
                CREATE POLICY tenant_isolation ON {table}
                USING (business_id::text = current_setting('app.rls.business_id', true))
                WITH CHECK (business_id::text = current_setting('app.rls.business_id', true))
                """
            )
        )

    bind.execute(sa.text("ALTER TABLE rental_items ENABLE ROW LEVEL SECURITY"))
    bind.execute(sa.text("ALTER TABLE rental_items FORCE ROW LEVEL SECURITY"))
    bind.execute(
        sa.text(
            """
            CREATE POLICY tenant_isolation ON rental_items
            USING (
                rental_id IN (
                    SELECT id FROM rentals
                    WHERE business_id::text = current_setting('app.rls.business_id', true)
                )
            )
            """
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    for table in TENANT_TABLES:
        bind.execute(sa.text(f"DROP POLICY IF EXISTS tenant_isolation ON {table}"))
        bind.execute(sa.text(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY"))
    Base.metadata.drop_all(bind=bind)
    bind.execute(sa.text(f"DROP ROLE IF EXISTS {APP_ROLE}"))
