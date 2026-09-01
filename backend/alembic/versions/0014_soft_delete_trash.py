"""soft-delete (trash bin) for clients/equipment + was_blacklisted flag

Revision ID: 0014_soft_delete_trash
Revises: 0013_client_extras
Create Date: 2026-09-01

Двадцать девятый проход (разбор 20-пунктового обзора живого прода —
скриншоты + «Как считаешь ты?» по каждому пункту, согласовано целиком:
"реализовываем всё в полном объёме"). Схемы БД касаются два независимых
пункта:

1. Мягкое удаление ("Корзина") для `clients` и `equipment` — п.14 обзора:
   "все удалённые клиенты, оборудование ... должны перемещаться в корзину,
   с возможностью восстановления, например на 30 дней". Реализовано как
   `deleted_at` (nullable timestamp — NULL значит "активна") +
   `deleted_by_id` (кто удалил, SET NULL при удалении сотрудника — тот же
   принцип, что у client_documents.employee_id). Обе таблицы получают ОДНУ
   и ту же пару колонок независимо друг от друга (не общий миксин на уровне
   БД — ORM-миксин на уровне Python-моделей, см. app/models/inventory.py).

   Важный нюанс, ради которого это вообще безопасно сделать НЕ трогая
   существующие FK: и `rentals.client_id`, и `rental_items.equipment_id`
   стоят на `ondelete="RESTRICT"` (см. миграцию 0001) — то есть клиента/
   позицию оборудования, у которых ЕСТЬ история аренд, и раньше нельзя было
   физически удалить из БД (см. delete_client/delete_equipment в
   app/api/routes/*.py, уже отдельно проверяли это ДО этой миграции и
   отдавали понятную 400-ошибку вместо сырого IntegrityError). Мягкое
   удаление НЕ меняет это ограничение и не пытается его обойти — просто
   даёт более безопасный путь по умолчанию: запись прячется (deleted_at)
   без реального DELETE, что попутно снимает необходимость в том самом
   блоке "нельзя удалить клиента с историей" — теперь скрыть (в корзину)
   можно ЛЮБОГО клиента/позицию, а вот окончательная зачистка (см.
   app/services/trash.py, `purge_expired`) по-прежнему пропускает записи с
   историей аренд — они остаются в корзине бессрочно (скрытые, но не
   потерянные), а не падают на FK при попытке настоящего DELETE. Это
   сознательный компромисс: гарантия "финансовая история никогда не
   исчезнет" была и остаётся сильнее гарантии "корзина очищается ровно
   через 30 дней".

2. `clients.was_blacklisted` (boolean, default false) — п.8 обзора: "если
   рейтинг меняется с чёрного списка на любой другой, важно оставить
   пометку, чтобы сотрудники видели, кто перед ними". Простой булев флаг,
   а не отдельная таблица истории статусов — выставляется один раз (при
   переходе В чёрный список — см. update_client) и НИКОГДА не сбрасывается
   автоматически (постоянная память карточки, тем же духом, что и
   `blacklist_reason` не стирается при выходе из списка сам по себе, если
   не считать явной очистки фронтом при СМЕНЕ рейтинга — см. ClientsTab.tsx:
   applyRating).
"""
from alembic import op
import sqlalchemy as sa

from app.db_types import GUID

revision = "0014_soft_delete_trash"
down_revision = "0013_client_extras"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("clients", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "clients",
        sa.Column("deleted_by_id", GUID(), sa.ForeignKey("employees.id", ondelete="SET NULL"), nullable=True),
    )
    op.add_column(
        "clients", sa.Column("was_blacklisted", sa.Boolean(), nullable=False, server_default=sa.false())
    )
    op.create_index("ix_clients_deleted_at", "clients", ["deleted_at"])

    op.add_column("equipment", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "equipment",
        sa.Column("deleted_by_id", GUID(), sa.ForeignKey("employees.id", ondelete="SET NULL"), nullable=True),
    )
    op.create_index("ix_equipment_deleted_at", "equipment", ["deleted_at"])


def downgrade() -> None:
    op.drop_index("ix_equipment_deleted_at", table_name="equipment")
    op.drop_column("equipment", "deleted_by_id")
    op.drop_column("equipment", "deleted_at")

    op.drop_index("ix_clients_deleted_at", table_name="clients")
    op.drop_column("clients", "was_blacklisted")
    op.drop_column("clients", "deleted_by_id")
    op.drop_column("clients", "deleted_at")
