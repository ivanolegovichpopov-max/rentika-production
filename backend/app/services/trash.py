"""
Корзина ("мягкое удаление") для Client/Equipment — двадцать девятый проход,
п.14 обзора. См. докстринг alembic/versions/0014_soft_delete_and_client_flags.py
для полной картины: deleted_at/deleted_by_id, почему это безопасно относительно
существующих ondelete="RESTRICT" на rentals.client_id/rental_items.equipment_id,
и почему записи с историей аренд остаются в корзине бессрочно вместо падения
на FK при попытке настоящего DELETE.

purge_expired() вызывается "лениво" — при каждом обращении к списку корзины
(см. app/api/routes/clients.py:list_trashed_clients и аналогичный эндпоинт
оборудования), тем же принципом, что и весь остальной низко-инфраструктурный
подход проекта (polling вместо WebSocket у сообщений, "холодный старт"
вместо всегда-тёплого воркера у Render free-tier и т.п. — отдельный cron/
scheduled job ради этого заводить непропорционально). Означает: если 30
дней истекли, а никто ни разу не открыл корзину — запись просто продолжит
лежать там до следующего открытия, это осознанный компромисс, не баг.
"""
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.clock import to_aware, utcnow
from app.models.inventory import Client, Equipment, Rental, RentalItem

TRASH_RETENTION_DAYS = 30


def purge_expired(db: Session, business_id) -> None:
    """Окончательно удаляет клиентов/оборудование, которые лежат в корзине
    дольше TRASH_RETENTION_DAYS И не имеют истории аренд (см. докстринг
    модуля — история аренд не даёт физически удалить строку из-за
    ondelete="RESTRICT", поэтому такие записи здесь просто пропускаются и
    остаются в корзине). Коммитит сама, вызывающий код может продолжать
    работу с той же сессией дальше."""

    cutoff = utcnow() - timedelta(days=TRASH_RETENTION_DAYS)

    expired_clients = db.scalars(
        select(Client).where(Client.business_id == business_id, Client.deleted_at.is_not(None))
    ).all()
    for client in expired_clients:
        if to_aware(client.deleted_at) >= cutoff:
            continue
        has_history = db.scalar(select(Rental.id).where(Rental.client_id == client.id).limit(1)) is not None
        if has_history:
            continue
        db.delete(client)

    expired_equipment = db.scalars(
        select(Equipment).where(Equipment.business_id == business_id, Equipment.deleted_at.is_not(None))
    ).all()
    for item in expired_equipment:
        if to_aware(item.deleted_at) >= cutoff:
            continue
        has_history = db.scalar(select(RentalItem.id).where(RentalItem.equipment_id == item.id).limit(1)) is not None
        if has_history:
            continue
        db.delete(item)

    db.commit()
