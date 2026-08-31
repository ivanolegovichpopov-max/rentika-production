import csv
import io
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.deps import BusinessContext, require_permission
from app.database import get_db
from app.models.business import PermissionLevel, ResourceType
from app.models.inventory import Client, ClientRating, Rental
from app.schemas.inventory import (
    ClientCreate,
    ClientImportResult,
    ClientImportRowResult,
    ClientMerge,
    ClientOut,
    ClientUpdate,
)

router = APIRouter(prefix="/businesses/{business_id}/clients", tags=["clients"])

view_dep = require_permission(ResourceType.clients, PermissionLevel.view)
edit_dep = require_permission(ResourceType.clients, PermissionLevel.edit)

# Алиасы значений рейтинга для CSV-импорта — принимаем и «сырые» ключи enum
# (normal/watch/blacklist — то, что ожидает шаблон импорта), и русские
# подписи, которые реально пишет exportClientsCsv на фронте
# (RATING_META[c.rating].label — "Надёжный"/"На контроле"/"Чёрный список"):
# иначе файл, полученный через "Экспорт CSV" этого же приложения, не прошёл
# бы обратно через "Импорт CSV" без ручной правки колонки rating.
_RATING_ALIASES: dict[str, ClientRating] = {
    "normal": ClientRating.normal,
    "надёжный": ClientRating.normal,
    "надежный": ClientRating.normal,
    "watch": ClientRating.watch,
    "на контроле": ClientRating.watch,
    "blacklist": ClientRating.blacklist,
    "чёрный список": ClientRating.blacklist,
    "черный список": ClientRating.blacklist,
}


def _parse_rating(raw: str) -> ClientRating:
    value = (raw or "").strip().lower()
    if not value:
        return ClientRating.normal
    if value in _RATING_ALIASES:
        return _RATING_ALIASES[value]
    raise ValueError(
        f'Поле «rating»: неизвестное значение «{raw}» (допустимо: normal/watch/blacklist '
        f'или «Надёжный»/«На контроле»/«Чёрный список»)'
    )


def _normalize_phone(phone: str | None) -> str:
    return "".join(ch for ch in (phone or "") if ch.isdigit())


@router.get("", response_model=list[ClientOut])
async def list_clients(ctx: BusinessContext = Depends(view_dep), db: Session = Depends(get_db)):
    return db.scalars(select(Client).where(Client.business_id == ctx.business_id)).all()


@router.post("", response_model=ClientOut, status_code=status.HTTP_201_CREATED)
async def create_client(body: ClientCreate, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)):
    client = Client(business_id=ctx.business_id, **body.model_dump())
    db.add(client)
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="create", resource="client")
    db.commit()
    db.refresh(client)
    return client


@router.patch("/{client_id}", response_model=ClientOut)
async def update_client(
    client_id: uuid.UUID, body: ClientUpdate, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)
):
    client = db.get(Client, client_id)
    if client is None or client.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Клиент не найден")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(client, field, value)
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="update", resource="client", resource_id=str(client_id))
    db.commit()
    db.refresh(client)
    return client


@router.delete("/{client_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_client(client_id: uuid.UUID, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)):
    client = db.get(Client, client_id)
    if client is None or client.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Клиент не найден")

    open_rental = db.scalar(
        select(Rental).where(Rental.client_id == client_id, Rental.status.in_(["booked", "active", "overdue"]))
    )
    if open_rental is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Нельзя удалить клиента с открытой арендой")

    # Клиента с ЛЮБОЙ историей аренд (даже полностью завершённой/отменённой)
    # тоже нельзя удалить — Rental.client_id стоит на ondelete="RESTRICT"
    # (см. models/inventory.py:Rental), это финансовая история, которую
    # нельзя молча терять вместе с карточкой клиента. Раньше эта проверка
    # смотрела только на открытые аренды — попытка удалить клиента с уже
    # ЗАКРЫТОЙ историей проходила её и падала прямо на ограничении внешнего
    # ключа необработанным IntegrityError (голый 500 вместо понятной
    # причины). Найдено при обзоре вкладки «Клиенты» (24-й проход, п.1):
    # здесь тот же случай ловится заранее и отдаётся понятным сообщением.
    # Если карточка — дубль другой, для этого есть перенос истории через
    # merge_client ниже, а не потеря данных через удаление.
    any_rental = db.scalar(select(Rental.id).where(Rental.client_id == client_id).limit(1))
    if any_rental is not None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Нельзя удалить клиента с историей аренд (даже завершённых) — это финансовая история. "
            "Если карточка дублирует другую, объедините их через «Объединить с другим клиентом».",
        )

    db.delete(client)
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="delete", resource="client", resource_id=str(client_id))
    try:
        db.commit()
    except IntegrityError:
        # Защита от гонки/непредвиденной ссылки, не пойманной проверками
        # выше (например, если позже появится ещё одна таблица со ссылкой
        # на clients.id) — тот же принцип, что и явная проверка выше, только
        # на случай, если сама проверка что-то не учла.
        db.rollback()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Не удалось удалить клиента — на него ссылаются другие записи")


@router.post("/import", response_model=ClientImportResult)
async def import_clients(file: UploadFile, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)):
    """Массовый импорт клиентов из CSV — по образцу import_equipment
    (app/api/routes/equipment.py), найдено как пробел при обзоре вкладки
    «Клиенты» (24-й проход, п.2): экспорт уже был, импорта не было, хотя у
    Оборудования есть оба. Построчный отчёт, а не all-or-nothing — валидные
    строки создаются, даже если часть файла с мусором."""
    raw_bytes = await file.read()
    try:
        text = raw_bytes.decode("utf-8-sig")  # -sig съедает BOM, который Excel любит дописывать
    except UnicodeDecodeError:
        try:
            text = raw_bytes.decode("cp1251")  # частый экспорт из старого Excel на Windows
        except UnicodeDecodeError:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Не удалось прочитать файл — ожидается CSV в UTF-8 или Windows-1251")

    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Пустой файл или отсутствует строка заголовка")
    fieldnames = {(f or "").strip().lower() for f in reader.fieldnames}
    if "name" not in fieldnames:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "В заголовке файла должна быть как минимум колонка: name")

    # Существующие клиенты бизнеса — для мягкого предупреждения о дублях по
    # телефону в отчёте (ClientImportRowResult.duplicate_warning). Само по
    # себе НЕ блокирует создание строки — совпадающий телефон не всегда один
    # и тот же человек (например, у членов семьи) — просто сигнал сотруднику,
    # что стоит проверить и, возможно, объединить карточки вручную (merge).
    existing_by_phone: dict[str, uuid.UUID] = {}
    for c in db.scalars(select(Client).where(Client.business_id == ctx.business_id)):
        if c.phone:
            existing_by_phone.setdefault(_normalize_phone(c.phone), c.id)

    results: list[ClientImportRowResult] = []
    created_count = 0

    for row_num, raw_row in enumerate(reader, start=2):  # строка 1 — заголовок
        row = {(k or "").strip().lower(): (v or "").strip() for k, v in raw_row.items() if k}
        name = row.get("name", "")
        try:
            if not name:
                raise ValueError("Пустое имя/название")
            rating = _parse_rating(row.get("rating", ""))
            phone = row.get("phone") or None
            normalized_phone = _normalize_phone(phone) if phone else None
            duplicate_warning = normalized_phone is not None and normalized_phone in existing_by_phone

            client = Client(
                business_id=ctx.business_id,
                name=name,
                phone=phone,
                email=row.get("email") or None,
                doc=row.get("doc") or None,
                rating=rating,
                notes=row.get("notes") or None,
            )
            db.add(client)
            db.flush()
            db.refresh(client)
            if normalized_phone is not None:
                existing_by_phone.setdefault(normalized_phone, client.id)
            results.append(
                ClientImportRowResult(
                    row=row_num,
                    ok=True,
                    name=name,
                    client=ClientOut.model_validate(client),
                    duplicate_warning=duplicate_warning,
                )
            )
            created_count += 1
        except ValueError as exc:
            results.append(ClientImportRowResult(row=row_num, ok=False, name=name or f"строка {row_num}", error=str(exc)))

    if created_count:
        log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="import", resource="client", meta={"created": created_count})
    db.commit()

    return ClientImportResult(total=len(results), created=created_count, failed=len(results) - created_count, results=results)


@router.post("/{client_id}/merge", response_model=ClientOut)
async def merge_client(
    client_id: uuid.UUID, body: ClientMerge, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)
):
    """Слияние дублей (24-й проход, п.7 обзора «Клиенты», найдено при
    обсуждении бага с удалением клиента с историей аренд): переносит ВСЮ
    историю аренд с client_id (источник, будет удалён) на body.into_client_id
    (цель, остаётся), затем удаляет карточку-источник. Поля самой карточки
    (телефон/email/заметка и т.д.) НЕ объединяются автоматически — остаются
    только у цели; предполагается, что сотрудник перед слиянием открывает
    обе карточки и сам решает, в какую сторону сливать (в какой из двух —
    более полные/актуальные данные), а не что это решает алгоритм."""
    if client_id == body.into_client_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Нельзя объединить клиента с самим собой")

    source = db.get(Client, client_id)
    if source is None or source.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Клиент не найден")

    target = db.get(Client, body.into_client_id)
    if target is None or target.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Целевой клиент не найден в этом бизнесе")

    moved_rentals = db.scalars(select(Rental).where(Rental.client_id == client_id)).all()
    for rental in moved_rentals:
        rental.client_id = body.into_client_id

    db.delete(source)
    log_action(
        db,
        business_id=ctx.business_id,
        user_id=ctx.user.id,
        action="merge",
        resource="client",
        resource_id=str(client_id),
        meta={"into_client_id": str(body.into_client_id), "rentals_moved": len(moved_rentals)},
    )
    db.commit()
    db.refresh(target)
    return target
