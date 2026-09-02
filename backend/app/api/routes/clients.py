import base64
import csv
import io
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.clock import to_aware, utcnow
from app.core.deps import BusinessContext, require_permission
from app.database import get_db
from app.models.business import Employee, PermissionLevel, ResourceType
from app.models.inventory import Client, ClientDocument, ClientNote, ClientRating, ClientType, Rental
from app.schemas.inventory import (
    ClientCreate,
    ClientDocumentOut,
    ClientDocumentUpdate,
    ClientImportResult,
    ClientImportRowResult,
    ClientMerge,
    ClientNoteCreate,
    ClientNoteOut,
    ClientOut,
    ClientRestoreOut,
    ClientTrashedOut,
    ClientUpdate,
)
from app.schemas.inventory import _validate_phone_format
from app.services.trash import purge_expired

# Лимит размера файла документа клиента (26-й проход) — 5 МБ ДО base64,
# проверяется и здесь (истина), и на фронте (чтобы не тратить время
# пользователя на загрузку/кодирование заведомо слишком большого файла).
# В базе base64 занимает ~33% больше — учтено в комментарии к data_base64
# в app/models/inventory.py, но лимит считается от исходного размера файла,
# который пользователю понятнее любых пересчётов.
MAX_CLIENT_DOCUMENT_BYTES = 5 * 1024 * 1024

# Окно на удаление СВОЕЙ записи в журнале клиента (37-й проход — см.
# docstring ClientNote в app/models/inventory.py). Достаточно, чтобы
# исправить опечатку/случайную запись сразу после добавления, но не
# позволяет задним числом почистить историю — владелец бизнеса
# (ctx.full_access) от этого окна не зависит, см. _note_out ниже.
CLIENT_NOTE_DELETE_WINDOW_MINUTES = 15

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


def _get_active_client(db: Session, ctx: BusinessContext, client_id: uuid.UUID) -> Client:
    """Клиент, который считается "существующим" для обычных маршрутов —
    активный (не в корзине), из этого бизнеса. Клиент в корзине для этих
    маршрутов ведёт себя как несуществующий (404) — единственный путь
    что-то с ним сделать — POST .../restore (29-й проход, см. докстринг
    alembic/versions/0014_soft_delete_and_client_flags.py)."""

    client = db.get(Client, client_id)
    if client is None or client.business_id != ctx.business_id or client.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Клиент не найден")
    return client


def _require_company_fields(client_type: ClientType, contact_person: str | None, inn: str | None) -> None:
    """Контактное лицо и ИНН обязательны для клиента-организации (29-й
    проход, п.19 обзора: раньше можно было стереть контактное лицо
    организации, сохранить — и оно молча пропадало насовсем без единого
    предупреждения). Проверяется на уровне маршрута, а не схемы Pydantic —
    у PATCH тело может не содержать вообще ни contact_person, ни client_type
    (точечное обновление другого поля), поэтому валидировать нужно уже
    ОКОНЧАТЕЛЬНОЕ, слитое с базой состояние клиента, а не сырой payload
    запроса."""

    if client_type != ClientType.company:
        return
    missing = []
    if not (contact_person or "").strip():
        missing.append("контактное лицо")
    if not (inn or "").strip():
        missing.append("ИНН")
    if missing:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Для организации обязательно укажите: {', '.join(missing)}")


@router.get("", response_model=list[ClientOut])
async def list_clients(ctx: BusinessContext = Depends(view_dep), db: Session = Depends(get_db)):
    return db.scalars(
        select(Client).where(Client.business_id == ctx.business_id, Client.deleted_at.is_(None))
    ).all()


@router.get("/trash", response_model=list[ClientTrashedOut])
async def list_trashed_clients(ctx: BusinessContext = Depends(view_dep), db: Session = Depends(get_db)):
    """Корзина клиентов (29-й проход, п.14 обзора) — см.
    app/services/trash.py. Зачистка просроченных (>30 дней, без истории
    аренд) записей выполняется здесь же, лениво, перед самим запросом."""

    purge_expired(db, ctx.business_id)
    rows = db.execute(
        select(Client, Employee.name)
        .join(Employee, Employee.id == Client.deleted_by_id, isouter=True)
        .where(Client.business_id == ctx.business_id, Client.deleted_at.is_not(None))
        .order_by(Client.deleted_at.desc())
    ).all()
    out = []
    for client, deleted_by_name in rows:
        item = ClientTrashedOut.model_validate(client)
        item.deleted_by_name = deleted_by_name
        out.append(item)
    return out


@router.post("/{client_id}/restore", response_model=ClientRestoreOut)
async def restore_client(client_id: uuid.UUID, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)):
    client = db.get(Client, client_id)
    if client is None or client.business_id != ctx.business_id or client.deleted_at is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Клиент не найден в корзине")
    client.deleted_at = None
    client.deleted_by_id = None
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="restore", resource="client", resource_id=str(client_id))
    db.commit()
    return ClientRestoreOut(id=client_id)


@router.post("", response_model=ClientOut, status_code=status.HTTP_201_CREATED)
async def create_client(body: ClientCreate, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)):
    data = body.model_dump()
    _require_company_fields(data["client_type"], data.get("contact_person"), data.get("inn"))
    client = Client(business_id=ctx.business_id, **data)
    if client.rating == ClientRating.blacklist:
        client.was_blacklisted = True
    db.add(client)
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="create", resource="client")
    db.commit()
    db.refresh(client)
    return client


@router.patch("/{client_id}", response_model=ClientOut)
async def update_client(
    client_id: uuid.UUID, body: ClientUpdate, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)
):
    client = _get_active_client(db, ctx, client_id)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(client, field, value)

    _require_company_fields(client.client_type, client.contact_person, client.inn)
    # Постоянная пометка "был в чёрном списке" (29-й проход, п.8 обзора) —
    # выставляется один раз при переходе В чёрный список, никогда не
    # сбрасывается автоматически при выходе из него (см. Client.was_blacklisted).
    if client.rating == ClientRating.blacklist:
        client.was_blacklisted = True

    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="update", resource="client", resource_id=str(client_id))
    db.commit()
    db.refresh(client)
    return client


@router.delete("/{client_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_client(client_id: uuid.UUID, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)):
    """Перемещает клиента в корзину (29-й проход, п.14 обзора) — НЕ
    физическое удаление строки (см. app/services/trash.py и докстринг
    миграции 0014). Поэтому в отличие от старой версии этого эндпоинта
    клиента с закрытой историей аренд теперь тоже можно "удалить" (спрятать)
    — история никуда не денется и восстановится вместе с карточкой."""

    client = _get_active_client(db, ctx, client_id)

    open_rental = db.scalar(
        select(Rental).where(Rental.client_id == client_id, Rental.status.in_(["booked", "active", "overdue"]))
    )
    if open_rental is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Нельзя удалить клиента с открытой арендой")

    client.deleted_at = utcnow()
    client.deleted_by_id = ctx.employee.id if ctx.employee is not None else None
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="delete", resource="client", resource_id=str(client_id))
    db.commit()


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
    for c in db.scalars(select(Client).where(Client.business_id == ctx.business_id, Client.deleted_at.is_(None))):
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
            phone = _validate_phone_format(row.get("phone") or None)
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
                # tags — единственное новое поле 25-го прохода, добавленное в
                # CSV (см. docstring миграции 0012): реквизиты организации и
                # умолчательная скидка сознательно НЕ включены в импорт — B2B
                # заводится вручную по карточке, без риска раздувания парсера.
                tags=row.get("tags") or None,
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

    source = _get_active_client(db, ctx, client_id)
    target = db.get(Client, body.into_client_id)
    if target is None or target.business_id != ctx.business_id or target.deleted_at is not None:
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


def _note_can_delete(note: ClientNote, ctx: BusinessContext) -> bool:
    """Владелец бизнеса — всегда (модерация, без ограничения по времени, та
    же логика, что и у DashboardNote в app/api/routes/notes.py). Обычный
    сотрудник — только свою запись и только внутри
    CLIENT_NOTE_DELETE_WINDOW_MINUTES с момента добавления (см. docstring
    ClientNote и константу выше)."""
    if ctx.full_access:
        return True
    if ctx.employee is None or note.employee_id != ctx.employee.id:
        return False
    age = utcnow() - to_aware(note.created_at)
    return age <= timedelta(minutes=CLIENT_NOTE_DELETE_WINDOW_MINUTES)


def _note_out(note: ClientNote, employee_name: str | None, ctx: BusinessContext) -> ClientNoteOut:
    out = ClientNoteOut.model_validate(note)
    out.employee_name = employee_name
    out.can_delete = _note_can_delete(note, ctx)
    return out


@router.get("/{client_id}/notes", response_model=list[ClientNoteOut])
async def list_client_notes(client_id: uuid.UUID, ctx: BusinessContext = Depends(view_dep), db: Session = Depends(get_db)):
    """Журнал датированных записей по клиенту (25-й проход, п.4; про
    удаление своей записи в коротком окне — см. docstring ClientNote в
    app/models/inventory.py). Порядок — от новых к старым, тем же
    принципом, что и история аренд в ClientDetailPanel."""
    client = _get_active_client(db, ctx, client_id)

    rows = db.execute(
        select(ClientNote, Employee.name)
        .join(Employee, Employee.id == ClientNote.employee_id, isouter=True)
        .where(ClientNote.client_id == client_id, ClientNote.business_id == ctx.business_id)
        .order_by(ClientNote.created_at.desc())
    ).all()
    return [_note_out(note, employee_name, ctx) for note, employee_name in rows]


@router.post("/{client_id}/notes", response_model=ClientNoteOut, status_code=status.HTTP_201_CREATED)
async def create_client_note(
    client_id: uuid.UUID, body: ClientNoteCreate, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)
):
    client = _get_active_client(db, ctx, client_id)

    note = ClientNote(
        business_id=ctx.business_id,
        client_id=client_id,
        employee_id=ctx.employee.id if ctx.employee is not None else None,
        text=body.text,
    )
    db.add(note)
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="create", resource="client_note", resource_id=str(client_id))
    db.commit()
    db.refresh(note)
    return _note_out(note, ctx.employee.name if ctx.employee is not None else None, ctx)


@router.delete("/{client_id}/notes/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_client_note(
    client_id: uuid.UUID, note_id: uuid.UUID, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)
):
    """Удаление СВОЕЙ записи в коротком окне после добавления, либо любой —
    владельцем бизнеса (см. _note_can_delete выше и docstring ClientNote).
    Тот же принцип проверки прав и тот же 403 при отказе, что и у
    delete_note в app/api/routes/notes.py (доска "Заметки" на дашборде)."""
    note = db.get(ClientNote, note_id)
    if note is None or note.business_id != ctx.business_id or note.client_id != client_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Запись не найдена")
    if not _note_can_delete(note, ctx):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"Удалить можно только свою запись, и не позже {CLIENT_NOTE_DELETE_WINDOW_MINUTES} минут после добавления",
        )
    db.delete(note)
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="delete", resource="client_note", resource_id=str(note_id))
    db.commit()


def _document_out(doc: ClientDocument, employee_name: str | None) -> ClientDocumentOut:
    out = ClientDocumentOut.model_validate(doc)
    out.employee_name = employee_name
    return out


@router.get("/{client_id}/documents", response_model=list[ClientDocumentOut])
async def list_client_documents(
    client_id: uuid.UUID, ctx: BusinessContext = Depends(view_dep), db: Session = Depends(get_db)
):
    """Сканы/фото документов клиента (26-й проход) — см. ClientDocument в
    app/models/inventory.py. Порядок — от новых к старым, тем же принципом,
    что и журнал заметок (list_client_notes выше)."""
    client = _get_active_client(db, ctx, client_id)

    rows = db.execute(
        select(ClientDocument, Employee.name)
        .join(Employee, Employee.id == ClientDocument.employee_id, isouter=True)
        .where(ClientDocument.client_id == client_id, ClientDocument.business_id == ctx.business_id)
        .order_by(ClientDocument.created_at.desc())
    ).all()
    return [_document_out(doc, employee_name) for doc, employee_name in rows]


@router.post("/{client_id}/documents", response_model=ClientDocumentOut, status_code=status.HTTP_201_CREATED)
async def upload_client_document(
    client_id: uuid.UUID,
    file: UploadFile,
    # 29-й проход, повторный обзор, п.12 — необязательная короткая подпись
    # ("Разворот паспорта" и т.п.), задаётся сразу при загрузке; multipart-
    # форма, поэтому Form(...), а не тело JSON (файл и так уже multipart).
    label: str | None = Form(None),
    ctx: BusinessContext = Depends(edit_dep),
    db: Session = Depends(get_db),
):
    client = _get_active_client(db, ctx, client_id)

    raw = await file.read()
    if len(raw) == 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Пустой файл")
    if len(raw) > MAX_CLIENT_DOCUMENT_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Файл слишком большой (максимум 5 МБ)")

    clean_label = (label or "").strip() or None

    doc = ClientDocument(
        business_id=ctx.business_id,
        client_id=client_id,
        employee_id=ctx.employee.id if ctx.employee is not None else None,
        filename=file.filename or "документ",
        content_type=file.content_type or "application/octet-stream",
        size_bytes=len(raw),
        data_base64=base64.b64encode(raw).decode("ascii"),
        label=clean_label,
    )
    db.add(doc)
    log_action(
        db, business_id=ctx.business_id, user_id=ctx.user.id, action="create", resource="client_document", resource_id=str(client_id)
    )
    db.commit()
    db.refresh(doc)
    return _document_out(doc, ctx.employee.name if ctx.employee is not None else None)


@router.patch("/{client_id}/documents/{document_id}", response_model=ClientDocumentOut)
async def update_client_document(
    client_id: uuid.UUID,
    document_id: uuid.UUID,
    body: ClientDocumentUpdate,
    ctx: BusinessContext = Depends(edit_dep),
    db: Session = Depends(get_db),
):
    """Изменить подпись уже загруженного документа (29-й проход, повторный
    обзор, п.12) — например, добавить её задним числом к файлам, загруженным
    ещё до появления этого поля."""
    doc = db.get(ClientDocument, document_id)
    if doc is None or doc.business_id != ctx.business_id or doc.client_id != client_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Документ не найден")
    doc.label = (body.label or "").strip() or None
    db.commit()
    db.refresh(doc)
    employee_name = None
    if doc.employee_id is not None:
        employee_name = db.scalar(select(Employee.name).where(Employee.id == doc.employee_id))
    return _document_out(doc, employee_name)


@router.delete("/{client_id}/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_client_document(
    client_id: uuid.UUID, document_id: uuid.UUID, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)
):
    doc = db.get(ClientDocument, document_id)
    if doc is None or doc.business_id != ctx.business_id or doc.client_id != client_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Документ не найден")
    db.delete(doc)
    log_action(
        db, business_id=ctx.business_id, user_id=ctx.user.id, action="delete", resource="client_document", resource_id=str(document_id)
    )
    db.commit()
