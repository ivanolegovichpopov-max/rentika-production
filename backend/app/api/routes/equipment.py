import csv
import io
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.audit import log_action
from app.core.deps import BusinessContext, get_business_context, require_permission
from app.database import get_db
from app.models.business import PermissionLevel, ResourceType
from app.models.inventory import Equipment, EquipmentCategory, EquipmentStatus, Rental, RentalItem, RentalStatus
from app.schemas.inventory import (
    EquipmentCategoryCreate,
    EquipmentCategoryOut,
    EquipmentCategoryRename,
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


def _ensure_category(db: Session, ctx: BusinessContext, name: str) -> str:
    """Валидация категории при создании/редактировании позиции оборудования.
    Владелец бизнеса (ctx.full_access) может использовать любое новое
    название — оно автоматически заводится в справочнике тут же (это и есть
    "владелец создаёт категории", просто без отдельного похода на другой
    экран каждый раз). Любая другая роль обязана выбрать уже существующее
    значение — иначе 400 с понятным сообщением, что и заставляет UI
    показывать таким пользователям выпадающий список без свободного ввода.

    Сравнение регистронезависимое (пятнадцатый проход, пункт 3 обзора вкладки
    «Оборудование») — иначе «Инструмент»/«инструмент» превращались бы в две
    разные записи справочника. Возвращает КАНОНИЧЕСКОЕ имя, которое нужно
    реально сохранить в equipment.category: если категория уже существует —
    её точное сохранённое написание (а не то, что ввёл пользователь), иначе —
    имя как есть (новая запись создаётся именно с ним). Вызывающий код обязан
    использовать возвращённое значение при записи, а не свой исходный
    аргумент — иначе одна и та же категория расползлась бы по позициям в
    разных регистрах, и точное сравнение (в фильтре на фронтенде, в подсчёте
    equipment_count) переставало бы находить часть позиций.

    Регистронезависимость сравнивается В PYTHON (`str.lower()`), а не через
    `func.lower()` на уровне SQL — намеренно: встроенная `LOWER()` в SQLite
    (на которой крутятся тесты) складывает регистр ТОЛЬКО для ASCII и
    оставляет кириллицу как есть, тогда как Python `str.lower()` и `LOWER()`
    в реальном Postgres (прод) корректно работают с юникодом. При сравнении
    через SQL это означало бы, что тесты на SQLite не находят дубли/
    совпадения, которые на проде находятся — рассинхрон между тем, что
    проверено, и тем, что реально исполняется. Справочник категорий у
    бизнеса — заведомо небольшой список (десятки-сотни записей максимум),
    так что цена сравнения в Python вместо SQL пренебрежимо мала."""
    categories = db.scalars(select(EquipmentCategory).where(EquipmentCategory.business_id == ctx.business_id)).all()
    lname = name.lower()
    for c in categories:
        if c.name.lower() == lname:
            return c.name
    if not ctx.full_access:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f'Категория «{name}» не найдена в справочнике. Обратитесь к владельцу бизнеса, чтобы добавить её.',
        )
    db.add(EquipmentCategory(business_id=ctx.business_id, name=name))
    db.flush()
    return name


def _category_equipment_counts(db: Session, business_id) -> dict[str, int]:
    """Число позиций оборудования на категорию (ключ — lower(name) на
    стороне Python, см. докстринг _ensure_category про SQLite/Postgres
    расхождение в регистре юникода — та же причина здесь)."""
    values = db.scalars(
        select(Equipment.category).where(Equipment.business_id == business_id, Equipment.category.is_not(None))
    ).all()
    counts: dict[str, int] = {}
    for v in values:
        key = v.lower()
        counts[key] = counts.get(key, 0) + 1
    return counts


def _category_out(category: EquipmentCategory, counts: dict[str, int]) -> EquipmentCategoryOut:
    return EquipmentCategoryOut(
        id=category.id,
        name=category.name,
        created_at=category.created_at,
        equipment_count=counts.get(category.name.lower(), 0),
    )


# --- Справочник категорий ----------------------------------------------------


@router.get("-categories", response_model=list[EquipmentCategoryOut])
async def list_equipment_categories(ctx: BusinessContext = Depends(view_dep), db: Session = Depends(get_db)):
    categories = db.scalars(
        select(EquipmentCategory).where(EquipmentCategory.business_id == ctx.business_id).order_by(EquipmentCategory.name)
    ).all()
    counts = _category_equipment_counts(db, ctx.business_id)
    return [_category_out(c, counts) for c in categories]


@router.post("-categories", response_model=EquipmentCategoryOut, status_code=status.HTTP_201_CREATED)
async def create_equipment_category(
    body: EquipmentCategoryCreate, ctx: BusinessContext = Depends(get_business_context), db: Session = Depends(get_db)
):
    _require_owner(ctx)
    name = body.name  # уже обрезано валидатором схемы (EquipmentCategoryCreate._strip_name)
    categories = db.scalars(select(EquipmentCategory).where(EquipmentCategory.business_id == ctx.business_id)).all()
    if any(c.name.lower() == name.lower() for c in categories):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Такая категория уже есть в справочнике")
    category = EquipmentCategory(business_id=ctx.business_id, name=name)
    db.add(category)
    log_action(db, business_id=ctx.business_id, user_id=ctx.user.id, action="create", resource="equipment_category")
    db.commit()
    db.refresh(category)
    return _category_out(category, {})  # только что создана — заведомо 0 позиций


@router.patch("-categories/{category_id}", response_model=EquipmentCategoryOut)
async def rename_equipment_category(
    category_id: uuid.UUID,
    body: EquipmentCategoryRename,
    ctx: BusinessContext = Depends(get_business_context),
    db: Session = Depends(get_db),
):
    """Переименование записи справочника — пятнадцатый проход (обзор
    вкладки «Оборудование», пункт 2: у владельца не было способа навести
    порядок в уже накопившихся мусорных/дублирующих названиях категорий).
    Владелец-only, как и создание. Переименование каскадно переносит ВСЕ
    позиции оборудования, чья текущая category совпадает со старым именем
    (без учёта регистра — часть позиций могла быть создана до внедрения
    канонизации в _ensure_category и хранить категорию в другом регистре),
    иначе после переименования эти позиции указывали бы на исчезнувшее из
    справочника название."""
    _require_owner(ctx)
    category = db.get(EquipmentCategory, category_id)
    if category is None or category.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Категория не найдена")

    new_name = body.name
    others = db.scalars(
        select(EquipmentCategory).where(EquipmentCategory.business_id == ctx.business_id, EquipmentCategory.id != category_id)
    ).all()
    if any(c.name.lower() == new_name.lower() for c in others):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Такая категория уже есть в справочнике")

    old_name = category.name
    category.name = new_name
    # Регистронезависимый матчинг делаем в Python (см. докстринг
    # _ensure_category) — набираем id позиций, у которых текущая категория
    # совпадает со старым именем без учёта регистра, и одним UPDATE
    # переносим их на новое имя.
    old_lower = old_name.lower()
    equipment_items = db.scalars(select(Equipment).where(Equipment.business_id == ctx.business_id)).all()
    matched_ids = [e.id for e in equipment_items if e.category and e.category.lower() == old_lower]
    if matched_ids:
        db.execute(update(Equipment).where(Equipment.id.in_(matched_ids)).values(category=new_name))
    log_action(
        db, business_id=ctx.business_id, user_id=ctx.user.id, action="rename", resource="equipment_category", resource_id=str(category_id)
    )
    db.commit()
    db.refresh(category)
    counts = _category_equipment_counts(db, ctx.business_id)
    return _category_out(category, counts)


@router.delete("-categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_equipment_category(
    category_id: uuid.UUID, ctx: BusinessContext = Depends(get_business_context), db: Session = Depends(get_db)
):
    """Удаление записи справочника — только если её СЕЙЧАС не использует ни
    одна позиция оборудования (без учёта регистра — та же причина, что и
    выше). Умышленно НЕТ каскадного «удалить категорию вместе со всеми
    позициями» — категория как раз для того и осталась простой строкой без
    FK на equipment, чтобы удаление записи справочника не могло случайно
    задеть сами позиции; владелец сначала должен переназначить/удалить их
    сам, если действительно хочет избавиться от категории целиком."""
    _require_owner(ctx)
    category = db.get(EquipmentCategory, category_id)
    if category is None or category.business_id != ctx.business_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Категория не найдена")

    category_names = db.scalars(
        select(Equipment.category).where(Equipment.business_id == ctx.business_id, Equipment.category.is_not(None))
    ).all()
    in_use = any(c.lower() == category.name.lower() for c in category_names)
    if in_use:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Нельзя удалить: эту категорию использует хотя бы одна позиция оборудования. Сначала перенесите позиции в другую категорию.",
        )

    db.delete(category)
    log_action(
        db, business_id=ctx.business_id, user_id=ctx.user.id, action="delete", resource="equipment_category", resource_id=str(category_id)
    )
    db.commit()


# --- Оборудование -------------------------------------------------------------


@router.get("", response_model=list[EquipmentOut])
async def list_equipment(ctx: BusinessContext = Depends(view_dep), db: Session = Depends(get_db)):
    # RLS уже ограничил видимые строки до ctx.business_id (см. get_business_context),
    # фильтр по business_id здесь — вторая, объектно-уровневая линия защиты,
    # а не единственная.
    return db.scalars(select(Equipment).where(Equipment.business_id == ctx.business_id)).all()


@router.post("", response_model=EquipmentOut, status_code=status.HTTP_201_CREATED)
async def create_equipment(body: EquipmentCreate, ctx: BusinessContext = Depends(edit_dep), db: Session = Depends(get_db)):
    canonical_category = _ensure_category(db, ctx, body.category)
    data = body.model_dump()
    data["category"] = canonical_category  # каноническое написание справочника, не то, что ввёл пользователь
    item = Equipment(business_id=ctx.business_id, **data)
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
        changes["category"] = _ensure_category(db, ctx, changes["category"])

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

            canonical_category = _ensure_category(db, ctx, category)

            item = Equipment(
                business_id=ctx.business_id,
                name=name,
                category=canonical_category,
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
