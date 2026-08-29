import csv
import io
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.deps import BusinessContext, get_business_context, require_permission
from app.database import get_db
from app.models.business import PermissionLevel, ResourceType
from app.models.inventory import Equipment, EquipmentCategory, EquipmentStatus, Rental, RentalItem, RentalStatus
from app.schemas.inventory import (
    EquipmentCategoryCreate,
    EquipmentCategoryOut,
    EquipmentCreate,
    EquipmentImportResult,
    EquipmentImportRowResult,
    EquipmentOut,
    EquipmentUpdate,
)

router = APIRouter(prefix="/businesses/{business_id}/equipment", tags=["equipment"])

view_dep = require_permission(ResourceType.equipment, PermissionLevel.view)
edit_dep = require_permission(ResourceType.equipment, PermissionLevel.edit)


def _require_owner(ctx: BusinessContext) -> None:
    # Тот же принцип, что и в positions.py:_require_owner — управление
    # справочником категорий (создание новых значений) не должно
    # разблокироваться через edit-право на «Оборудование», иначе весь смысл
    # "жёсткого" справочника (только владелец решает, какие категории
    # вообще существуют) теряется — рядовой edit-сотрудник смог бы плодить
    # те же дубли/мусор, от которых справочник и должен защищать.
    if not ctx.full_access:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Управление справочником категорий доступно только владельцу бизнеса")


def _ensure_category(db: Session, ctx: BusinessContext, name: str) -> None:
    """Валидация категории при создании/редактировании позиции оборудования.
    Владелец бизнеса (ctx.full_access) может использовать любое новое
    название — оно автоматически заводится в справочнике тут же (это и есть
    "владелец создаёт категории", просто без отдельного похода на другой
    экран каждый раз). Любая другая роль обязана выбрать уже существующее
    значение — иначе 400 с понятным сообщением, что и заставляет UI
    показывать таким пользователям выпадающий список без свободного ввода."""
    existing = db.scalar(
        select(EquipmentCategory).where(EquipmentCategory.business_id == ctx.business_id, EquipmentCategory.name == name)
    )
    if existing is not None:
        return
    if not ctx.full_access:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f'Категория «{name}» не найдена в справочнике. Обратитесь к владельцу бизнеса, чтобы добавить её.',
        )
    db.add(EquipmentCategory(business_id=ctx.business_id, name=name))
    db.flush()


# --- Справочник категорий ----------------------------------------------------


@router.get("-categories", response_model=list[EquipmentCategoryOut])
async def list_equipment_categories(ctx: BusinessContext = Depends(view_dep), db: Session = Depends(get_db)):
    categories = db.scalars(
        select(EquipmentCategory).where(EquipmentCategory.business_id == ctx.business_id).order_by(EquipmentCategory.name)
    ).all()
    return categories


@router.post("-categories", response_model=EquipmentCategoryOut, status_code=status.HTTP_201_CREATED)
async def create_equipment_category(
    body: EquipmentCategoryCreate, ctx: BusinessContext = Depends(get_business_context), db: Session = Depends(get_db)
):
    _require_owner(ctx)
    name = body.name  # уже обрезано валидатором схемы (EquipmentCategoryCreate._strip_name)
    existing = db.scalar(
        select(EquipmentCategory).where(EquipmentCategory.business_id == ctx.business_id, EquipmentCategory.name == name)
    )
    if existing is not None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Такая категория уже есть в справочнике")
    category = EquipmentCategory(business_id=ctx.business_id, name=name)
    db.add(category)
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="create", resource="equipment_category")
    db.commit()
    db.refresh(category)
    return category


# --- Оборудование -------------------------------------------------------------


@router.get("", response_model=list[EquipmentOut])
async def list_equipment(ctx: BusinessContext = Depends(view_dep), db: Session = Depends(get_db)):
    # RLS уже ограничил видимые строки до ctx.business_id (см. get_business_context),
    # фильтр по business_id здесь — вторая, объектно-уровневая линия защиты,
    # а не единственная.
    return db.scalars(select(Equipment).where(Equipment.business_id == ctx.business_id)).all()


@router.post("", response_model=EquipmentOut, status_code=status.HTTP_201_CREATED)
async def create_equipment(body: EquipmentCreate, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)):
    _ensure_category(db, ctx, body.category)
    item = Equipment(business_id=ctx.business_id, **body.model_dump())
    db.add(item)
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="create", resource="equipment")
    db.commit()
    db.refresh(item)
    return item


@router.patch("/{equipment_id}", response_model=EquipmentOut)
async def update_equipment(
    equipment_id: uuid.UUID, body: EquipmentUpdate, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)
):
    """Частичное обновление — только переданные поля меняются
    (exclude_unset), в отличие от старой версии, которая требовала
    EquipmentCreate целиком и потому 422-ила на точечных PATCH-запросах
    слайдовера (смена статуса, дата окончания обслуживания)."""
    item = db.get(Equipment, equipment_id)
    if item is None or item.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Оборудование не найдено")

    changes = body.model_dump(exclude_unset=True)

    if "category" in changes:
        _ensure_category(db, ctx, changes["category"])

    if changes.get("status") == EquipmentStatus.retired:
        # Тот же принцип, что и при удалении: нельзя списать позицию, по
        # которой есть аренда в работе или бронь (см. demo's
        # equipmentHasOpenRentals) — иначе статус "Списано" маскирует
        # фактическое "В аренде".
        open_rental = db.scalar(
            select(RentalItem)
            .join(Rental, Rental.id == RentalItem.rental_id)
            .where(
                RentalItem.equipment_id == equipment_id,
                Rental.status.in_([RentalStatus.booked, RentalStatus.active]),
            )
        )
        if open_rental is not None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Нельзя списать: по этой позиции есть аренда в работе или бронь. Сначала завершите её.",
            )

    for field, value in changes.items():
        setattr(item, field, value)
    if changes.get("status") is not None and changes["status"] != EquipmentStatus.maintenance and "maintenance_until" not in changes:
        # Как и в демо: при смене статуса на что-то, кроме "на обслуживании",
        # дата окончания обслуживания сбрасывается, если она не была
        # одновременно переустановлена этим же запросом.
        item.maintenance_until = None
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="update", resource="equipment", resource_id=str(equipment_id))
    db.commit()
    db.refresh(item)
    return item


@router.delete("/{equipment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_equipment(
    equipment_id: uuid.UUID, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)
):
    item = db.get(Equipment, equipment_id)
    if item is None or item.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Оборудование не найдено")

    in_use = db.scalar(select(RentalItem).where(RentalItem.equipment_id == equipment_id))
    if in_use is not None:
        # Тот же защитный принцип, что в index-supabase.html (SPEC.md 9.4):
        # нельзя списать позицию, у которой уже есть история аренд — иначе
        # rental_items.equipment_id повиснет на удалённой записи, а прошлые
        # аренды потеряют читаемое название техники.
        item.status = EquipmentStatus.retired
        log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="retire", resource="equipment", resource_id=str(equipment_id))
        db.commit()
        return

    db.delete(item)
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="delete", resource="equipment", resource_id=str(equipment_id))
    db.commit()


# --- Массовый импорт (CSV) ----------------------------------------------------
#
# Формат — заголовок первой строкой, порядок столбцов не важен (читаем по
# именам): name,category,code,daily_rate,deposit,period_days,period_price,
# period_price_after,notes. Обязательны только name/category/daily_rate —
# остальное можно оставлять пустым. Один файл — одна транзакция: все строки
# валидируются, накопленные объекты добавляются в сессию, и только если
# импорт не пуст — один общий db.commit() в самом конце (не построчные
# коммиты — если процесс прервётся на середине файла, в базе не должно
# остаться "половины" импорта). Отчёт по каждой строке возвращается всегда,
# включая построчные ошибки — это НЕ all-or-nothing по валидации: валидные
# строки создаются, даже если часть файла содержит мусор (ошибки в разделе
# результатов позволяют пользователю поправить именно проблемные строки и
# перезалить только их).


def _parse_number(raw: str, field: str) -> float | None:
    raw = (raw or "").strip().replace(",", ".").replace(" ", "")
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError as exc:
        raise ValueError(f'Поле «{field}»: «{raw}» не похоже на число') from exc


def _parse_int(raw: str, field: str) -> int | None:
    value = _parse_number(raw, field)
    if value is None:
        return None
    return int(value)


@router.post("/import", response_model=EquipmentImportResult)
async def import_equipment(
    file: UploadFile, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)
):
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
    if "name" not in fieldnames or "category" not in fieldnames or "daily_rate" not in fieldnames:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "В заголовке файла должны быть как минимум колонки: name, category, daily_rate",
        )

    results: list[EquipmentImportRowResult] = []
    created_count = 0

    for row_num, raw_row in enumerate(reader, start=2):  # строка 1 — заголовок
        row = {(k or "").strip().lower(): (v or "").strip() for k, v in raw_row.items() if k}
        name = row.get("name", "")
        category = row.get("category", "")
        try:
            if not name:
                raise ValueError("Пустое название")
            if not category:
                raise ValueError("Пустая категория")
            daily_rate = _parse_number(row.get("daily_rate", ""), "daily_rate")
            if daily_rate is None:
                raise ValueError("Не указана суточная ставка")
            deposit = _parse_number(row.get("deposit", ""), "deposit") or 0
            period_days = _parse_int(row.get("period_days", ""), "period_days")
            period_price = _parse_number(row.get("period_price", ""), "period_price")
            period_price_after = _parse_number(row.get("period_price_after", ""), "period_price_after")

            _ensure_category(db, ctx, category)

            item = Equipment(
                business_id=ctx.business_id,
                name=name,
                category=category,
                code=row.get("code") or None,
                daily_rate=daily_rate,
                deposit=deposit,
                period_days=period_days,
                period_price=period_price,
                period_price_after=period_price_after,
                notes=row.get("notes") or None,
            )
            db.add(item)
            db.flush()
            db.refresh(item)  # подтянуть server_default (created_at) для отчёта, не коммитя транзакцию целиком
            results.append(EquipmentImportRowResult(row=row_num, ok=True, name=name, equipment=EquipmentOut.model_validate(item)))
            created_count += 1
        except HTTPException as exc:
            results.append(EquipmentImportRowResult(row=row_num, ok=False, name=name or f"строка {row_num}", error=exc.detail))
        except ValueError as exc:
            results.append(EquipmentImportRowResult(row=row_num, ok=False, name=name or f"строка {row_num}", error=str(exc)))

    if created_count:
        log_action(
            db,
            business_id=ctx.business_id,
            user_id=ctx.user.id,
            action="import",
            resource="equipment",
            resource_id=f"{created_count} позиций",
        )
        db.commit()
    else:
        db.rollback()

    return EquipmentImportResult(total=len(results), created=created_count, failed=len(results) - created_count, results=results)
