"""client_documents.label — короткая подпись к документу

Revision ID: 0015_client_document_label
Revises: 0014_soft_delete_trash
Create Date: 2026-09-01

Двадцать девятый проход, ПОВТОРНЫЙ обзор (пользователь прислал построчный
разбор своего же исходного 20-пунктного списка и указал, что часть пунктов
осталась нереализованной несмотря на предыдущий отчёт "всё готово") — п.12:
"можно загрузить несколько документов, но нечем подписать, что есть что —
не гадать по имени файла с телефона (IMG_20260901_112233.jpg)".

Простая nullable-колонка, без обратной несовместимости: старые документы
(загруженные до этого прохода) просто остаются без подписи — на фронте это
трактуется как "без подписи", filename по-прежнему виден как раньше.
"""
from alembic import op
import sqlalchemy as sa

revision = "0015_client_document_label"
down_revision = "0014_soft_delete_trash"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("client_documents", sa.Column("label", sa.String(length=255), nullable=True))


def downgrade() -> None:
    op.drop_column("client_documents", "label")
