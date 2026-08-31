import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, ApiError } from "../../api/client";
import { useData } from "../../context/DataContext";
import type { Equipment, EquipmentCategory, EquipmentImportResult, EquipmentWarehouse, Rental } from "../../api/types";
import { EQ_META, RENTAL_META, Badge, equipmentDisplayStatus, nextFreeDate, rentalDisplayStatus } from "../../lib/statusMeta";
import { money, fmtDate, isoAddDays, todayISO } from "../../lib/format";
import { IconClose, IconCopy, IconEdit, IconTrash, IconChevronDown, IconCheck, IconGrip } from "../../lib/icons";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { parseCsv, csvRowsToObjects, toCsv } from "../../lib/csv";
import { itemCostForDays } from "../../lib/financeCalc";
import { usePersistedState } from "../../lib/persist";

const FILTERS: { id: string; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "available", label: "Свободно" },
  { id: "rented", label: "В аренде" },
  { id: "overdue", label: "Просрочено" },
  { id: "maintenance", label: "Обслуживание" },
  { id: "retired", label: "Списано" },
];

/* ============================================================
   Сортировка таблицы — перенесено 1:1 из демо (EQUIPMENT_SORT_COLUMNS /
   equipmentSortValue / sortEquipmentList / setEquipmentSort).
   ============================================================ */
const EQUIPMENT_SORT_COLUMNS: { key: string; label: string }[] = [
  { key: "name", label: "Оборудование" },
  { key: "category", label: "Категория" },
  // Склад (восемнадцатый проход) — по той же механике, что и категория.
  { key: "warehouse", label: "Склад" },
  { key: "status", label: "Статус" },
  { key: "rate", label: "Ставка" },
  { key: "deposit", label: "Депозит" },
];

/* ============================================================
   Настройка столбцов таблицы — двадцатый проход, п.2 обзора ("столбцы
   таблицы оборудования: скрыть/переставить, растягивание пока не
   применяем"). Столбец "Оборудование" (name) всегда первый и всегда виден —
   это основной идентифицирующий столбец, скрывать или двигать его смысла
   нет; настраиваются только пять оставшихся из EQUIPMENT_SORT_COLUMNS.
   Хранится в localStorage, а НЕ привязано к businessId — это личное
   предпочтение отображения конкретного пользователя-браузера, не данные
   бизнеса (в отличие от equipment-sort:${businessId} выше).
   ============================================================ */
const EQUIPMENT_TOGGLEABLE_COLUMN_IDS = EQUIPMENT_SORT_COLUMNS.filter((c) => c.key !== "name").map((c) => c.key);

interface EquipmentColumnsPrefs {
  order: string[];
  hidden: string[];
}

const DEFAULT_EQUIPMENT_COLUMNS_PREFS: EquipmentColumnsPrefs = {
  order: EQUIPMENT_TOGGLEABLE_COLUMN_IDS,
  hidden: [],
};

/** Актуальный видимый порядок столбцов — сохранённый порядок, дополненный
 * в конце любыми новыми столбцами (если появятся) и без скрытых. Тот же
 * принцип "known + extra", что и orderedCategories в CalendarTab. */
function visibleEquipmentColumns(prefs: EquipmentColumnsPrefs): { key: string; label: string }[] {
  const known = prefs.order.filter((id) => EQUIPMENT_TOGGLEABLE_COLUMN_IDS.includes(id));
  const extra = EQUIPMENT_TOGGLEABLE_COLUMN_IDS.filter((id) => !known.includes(id));
  return known
    .concat(extra)
    .filter((id) => !prefs.hidden.includes(id))
    .map((id) => EQUIPMENT_SORT_COLUMNS.find((c) => c.key === id)!);
}

const EQUIPMENT_STATUS_PRIORITY: Record<string, number> = {
  overdue: 0,
  rented: 1,
  available: 2,
  maintenance: 3,
  retired: 4,
};

interface EquipmentSort {
  key: string | null;
  dir: "asc" | "desc";
}

function equipmentSortValue(e: Equipment, key: string, rentals: Rental[], today: string): string | number {
  if (key === "name") return e.name.toLowerCase();
  if (key === "category") return e.category.toLowerCase();
  if (key === "warehouse") return (e.warehouse ?? "").toLowerCase();
  if (key === "status") return EQUIPMENT_STATUS_PRIORITY[equipmentDisplayStatus(e, rentals, today)] ?? 99;
  if (key === "rate") return e.daily_rate;
  if (key === "deposit") return e.deposit;
  return 0;
}

function sortEquipmentList(list: Equipment[], sort: EquipmentSort, rentals: Rental[], today: string): Equipment[] {
  if (!sort.key) return list;
  const key = sort.key;
  const dir = sort.dir === "desc" ? -1 : 1;
  return [...list].sort((a, b) => {
    const va = equipmentSortValue(a, key, rentals, today);
    const vb = equipmentSortValue(b, key, rentals, today);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return a.name.localeCompare(b.name, "ru");
  });
}

/* ============================================================
   Группировка визуально одинаковых позиций в таблице (двадцатый проход,
   п.3 обзора: "30 пар костылей одной модели" — сценарий 1, каждая позиция
   остаётся отдельной строкой БД с собственным статусом/историей, но в
   таблице такие позиции сворачиваются в одну строку с разбивкой по
   статусам, чтобы не листать 30 одинаковых строк подряд). "Одинаковые" —
   совпадают все параметры карточки оборудования, КРОМЕ инвентарного номера,
   статуса, срока обслуживания и заметки (эти как раз то, что отличает
   конкретные единицы друг от друга).
   ============================================================ */
function equipmentGroupKey(e: Equipment): string {
  return [
    e.name.trim().toLowerCase(),
    e.category.trim().toLowerCase(),
    (e.warehouse ?? "").trim().toLowerCase(),
    e.daily_rate,
    e.deposit,
    e.period_days ?? "",
    e.period_price ?? "",
    e.period_price_after ?? "",
    e.after_period_days ?? "",
  ].join("|");
}

interface EquipmentRenderGroup {
  key: string;
  items: Equipment[];
}

/** Группирует только СОСЕДНИЕ по текущей сортировке позиции — этого
 * достаточно: по любому из сортируемых полей (название/категория/склад/
 * ставка/депозит) одинаковые позиции и так соседствуют, а сортировка по
 * статусу намеренно их не группирует (там показывать нечего — весь смысл
 * группы в разбивке ПО статусам). */
function buildEquipmentRenderRows(sorted: Equipment[]): EquipmentRenderGroup[] {
  const groups: EquipmentRenderGroup[] = [];
  for (const it of sorted) {
    const key = equipmentGroupKey(it);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(it);
    } else {
      groups.push({ key, items: [it] });
    }
  }
  return groups;
}

/** Подпись ставки с учётом ступенчатого тарифа — 1:1 из демо (rateLabel).
 *
 * period_price_after (двадцатый проход, п.4 обзора) — цена за ОДИН полный
 * или начатый шаг длиной after_period_days дней, а не линейно размазанная
 * по дням надбавка, как было раньше — печатается как есть, без деления.
 * after_period_days==1 (самый частый случай, посуточная надбавка) печатается
 * как "/сутки" для читаемости, любая другая длина шага — как "/N дн". */
function rateLabel(e: Equipment): string {
  if (e.period_days && e.period_price) {
    const afterDays = e.after_period_days || 1;
    const afterUnit = afterDays === 1 ? "сутки" : `${afterDays} дн`;
    return (
      money(e.period_price) +
      "/" +
      e.period_days +
      "дн" +
      (e.period_price_after != null ? " → " + money(e.period_price_after) + "/" + afterUnit : "")
    );
  }
  return money(e.daily_rate) + "/сутки";
}

/** Содержимое ячейки таблицы для одного из настраиваемых столбцов (см.
 * EQUIPMENT_TOGGLEABLE_COLUMN_IDS выше) — вынесено из JSX тела строки, чтобы
 * порядок/видимость столбцов управлялись данными (visibleEquipmentColumns),
 * а не жёстким списком <td>. */
function renderEquipmentCell(key: string, it: Equipment, status: string, freeFrom: string | null) {
  switch (key) {
    case "category":
      return it.category;
    case "warehouse":
      return it.warehouse ?? "—";
    case "status":
      return (
        <>
          <Badge meta={EQ_META[status as keyof typeof EQ_META]} />
          {freeFrom && <div className="cell-sub">своб. с {freeFrom}</div>}
        </>
      );
    case "rate":
      return rateLabel(it);
    case "deposit":
      return money(it.deposit);
    default:
      return null;
  }
}

/** Класс ячейки для настраиваемого столбца — "mono" для числовых столбцов,
 * как было до вынесения в data-driven рендер. */
function equipmentCellClassName(key: string): string | undefined {
  return key === "rate" || key === "deposit" ? "mono" : undefined;
}

/* ============================================================
   Показатели позиции в слайд-панели — эквиваленты демо-функций
   equipmentRevenueMap / equipmentUtilization / equipmentHasOpenRentals.
   ============================================================ */
function isUnderMaintenanceOn(eq: Equipment, dateIso: string): boolean {
  if (eq.status !== "maintenance") return false;
  if (!eq.maintenance_until) return true;
  return dateIso <= eq.maintenance_until;
}

type DayCategory = "maintenance" | "busy" | "available";

/** Статус позиции на конкретный день — та же классификация, что и
 * equipmentDisplayStatus/календарь в демо, но упрощена до трёх корзин
 * (обслуживание / занято / свободно), которых достаточно для загрузки. */
function equipmentDayCategory(e: Equipment, d: string, rentals: Rental[]): DayCategory {
  if (isUnderMaintenanceOn(e, d)) return "maintenance";
  const busy = rentals.some(
    (r) =>
      (r.status === "booked" || r.status === "active") &&
      d >= r.start_date &&
      d <= r.end_date &&
      r.items.some((it) => it.equipment_id === e.id)
  );
  return busy ? "busy" : "available";
}

/** Загрузка позиции за последние `days` дней в процентах — дни на
 * обслуживании исключены из знаменателя (простой по ремонту не
 * считается неэффективностью), как в демо. */
function equipmentUtilizationPct(e: Equipment, rentals: Rental[], days = 90): number {
  let busy = 0;
  let maint = 0;
  for (let i = 0; i < days; i++) {
    const d = isoAddDays(todayISO(), -i);
    const cat = equipmentDayCategory(e, d, rentals);
    if (cat === "maintenance") maint++;
    else if (cat === "busy") busy++;
  }
  const denom = days - maint;
  return denom > 0 ? Math.round((busy / denom) * 100) : 0;
}

/** Выручка по каждой позиции оборудования за всё время (по завершённым
 * арендам), с распределением суммы аренды/просрочки/повреждений
 * пропорционально ставке — 1:1 из демо (equipmentRevenueMap), только на
 * реальных полях backend'а (Rental.base/late_fee/damage_fee и
 * RentalItem.daily_rate_snapshot вместо пересчёта на фронте). */
function equipmentRevenueMap(rentals: Rental[]): Record<string, number> {
  const map: Record<string, number> = {};
  rentals.forEach((r) => {
    if (r.status !== "returned") return;
    const totalDaily = r.items.reduce((s, it) => s + it.daily_rate_snapshot, 0) || 1;
    r.items.forEach((it) => {
      const share = it.daily_rate_snapshot / totalDaily;
      const rev = (r.base + r.late_fee) * share + r.damage_fee / r.items.length;
      map[it.equipment_id] = (map[it.equipment_id] || 0) + rev;
    });
  });
  return map;
}

/** Есть ли у позиции незакрытая аренда (в работе или забронирована) —
 * определяется на фронте из уже загруженного списка аренд, без нового
 * эндпоинта, 1:1 с демо (equipmentHasOpenRentals). */
function equipmentHasOpenRentals(equipmentId: string, rentals: Rental[]): boolean {
  return rentals.some(
    (r) => (r.status === "active" || r.status === "booked") && r.items.some((it) => it.equipment_id === equipmentId)
  );
}

/* ============================================================
   Форма добавления/изменения оборудования
   ============================================================ */
interface EquipmentFormState {
  name: string;
  category: string;
  // Склад/точка хранения (восемнадцатый проход) — в отличие от category
  // необязательное поле, поэтому пустая строка здесь означает "не указан",
  // а не ошибку валидации (см. formToPayload — конвертируется в null).
  warehouse: string;
  code: string;
  daily_rate: string;
  deposit: string;
  period_days: string;
  period_price: string;
  period_price_after: string;
  // Длина "шага после" ступенчатого тарифа в днях (двадцатый проход, п.4
  // обзора) — см. докстринг Equipment.after_period_days. Значение по
  // умолчанию "1" (посуточно) подставляется при открытии секции тарифа
  // (см. кнопку "+ Добавить ступенчатый тариф" ниже), чтобы в самом частом
  // случае (надбавка за сутки) пользователю вообще не нужно было это поле
  // трогать.
  after_period_days: string;
  notes: string;
  // Количество одинаковых позиций для создания разом (двадцатый проход, п.3
  // обзора — "30 пар одной модели костылей"). Имеет смысл только в режиме
  // добавления/копирования (см. allowAddAnother у EquipmentFormModal); при
  // редактировании существующей позиции поле не показывается и не читается.
  quantity: string;
}

const EMPTY_FORM: EquipmentFormState = {
  name: "",
  category: "",
  warehouse: "",
  code: "",
  daily_rate: "",
  deposit: "0",
  period_days: "",
  period_price: "",
  period_price_after: "",
  after_period_days: "",
  notes: "",
  quantity: "1",
};

function formFromEquipment(e: Equipment): EquipmentFormState {
  return {
    name: e.name,
    category: e.category,
    warehouse: e.warehouse ?? "",
    code: e.code ?? "",
    daily_rate: String(e.daily_rate),
    deposit: String(e.deposit),
    period_days: e.period_days != null ? String(e.period_days) : "",
    period_price: e.period_price != null ? String(e.period_price) : "",
    // Двадцатый проход: period_price_after теперь хранится и вводится как
    // цена за один шаг напрямую (без скрытой конвертации через period_days,
    // см. историю periodPriceAfterPerDay в git — убрана вместе с
    // одновременным добавлением своей длины шага, after_period_days).
    period_price_after: e.period_price_after != null ? String(e.period_price_after) : "",
    after_period_days: e.after_period_days != null ? String(e.after_period_days) : "",
    notes: e.notes ?? "",
    quantity: "1",
  };
}

/** Форма для кнопки "Копировать" на слайдовере (см. EquipmentDetailPanel) —
 * то же, что formFromEquipment, но с очищенным инвентарным номером: копия
 * позиции с тем же № была бы источником путаницы (см. согласование с
 * пользователем в тринадцатом проходе — "Полностью согласен, делаем!" про
 * саму фичу дублирования). Название получает суффикс "(копия)", чтобы в
 * списке сразу было видно, что это новая, ещё не отредактированная позиция.
 */
function formFromEquipmentAsCopy(e: Equipment): EquipmentFormState {
  return { ...formFromEquipment(e), name: e.name + " (копия)", code: "" };
}

/** Парсинг числового поля, введённого пользователем как текст — принимает и
 * точку, и запятую как десятичный разделитель (16-й проход, п.5 обзора: на
 * русской раскладке/цифровой клавиатуре запятая — стандартный десятичный
 * знак, а нативный `<input type="number">` такой ввод просто не принимает
 * вовсе, без объяснения причины). `empty` отличает "не заполнено" (пусто —
 * нормально для необязательных полей) от `valid: false` ("заполнено
 * нечисловым мусором" — настоящая ошибка, которую раньше маскировал
 * `Number(...) || 0`, тихо превращая любой мусор в ноль). */
function parseDecimalField(raw: string): { value: number | null; empty: boolean; valid: boolean } {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null, empty: true, valid: true };
  const n = Number(trimmed.replace(",", "."));
  return { value: Number.isFinite(n) ? n : null, empty: false, valid: Number.isFinite(n) };
}

/** Тело запроса на создание/изменение позиции — БЕЗ quantity (двадцатый
 * проход): quantity читается вызывающим кодом (handleSubmitForm) отдельно,
 * чтобы решить, какой эндпоинт вызвать (обычный POST/PATCH при 1 или
 * POST .../equipment/bulk при >1) — сам объект payload одинаков для обоих
 * случаев. */
function formToPayload(form: EquipmentFormState) {
  const periodDays = form.period_days ? Number(form.period_days) : null;
  return {
    name: form.name,
    category: form.category,
    warehouse: form.warehouse.trim() || null,
    code: form.code || null,
    daily_rate: parseDecimalField(form.daily_rate).value ?? 0,
    deposit: parseDecimalField(form.deposit).value ?? 0,
    period_days: periodDays,
    period_price: parseDecimalField(form.period_price).value,
    // Цена за шаг вводится и хранится напрямую, без конвертации (двадцатый
    // проход — см. formFromEquipment выше).
    period_price_after: parseDecimalField(form.period_price_after).value,
    after_period_days: form.after_period_days ? Number(form.after_period_days) : null,
    notes: form.notes || null,
  };
}

/** Есть ли в форме заполненное значение хотя бы одного из трёх полей
 * ступенчатого тарифа — используется, чтобы при открытии формы на
 * редактирование секция сразу была раскрыта, если тариф уже настроен. */
function hasTieredValues(form: EquipmentFormState): boolean {
  return !!(form.period_days || form.period_price || form.period_price_after);
}

/** Сравнение текущей формы с исходным состоянием (16-й проход, п.6 обзора) —
 * используется, чтобы спрашивать подтверждение закрытия ТОЛЬКО если
 * пользователь реально что-то ввёл/изменил, а не при любом закрытии пустой
 * (режим добавления) или нетронутой (режим редактирования) формы. */
function isFormDirty(current: EquipmentFormState, initial: EquipmentFormState): boolean {
  return (Object.keys(current) as (keyof EquipmentFormState)[]).some((k) => current[k] !== initial[k]);
}

/** Автодополнение категории — замена нативного `<input list>` + `<datalist>`
 * (16-й проход, обзор по скриншотам, п.6): у нативного datalist нельзя
 * задать ширину выпадающего списка через CSS вообще — в Chrome он рисуется
 * уже самого поля. Панель рендерится через createPortal в document.body с
 * координатами из getBoundingClientRect() поля — только портал по-настоящему
 * выходит за пределы overflow:auto у прокручиваемых предков (сам по себе
 * position:fixed для этого недостаточен: overflow клипует потомков
 * независимо от их position), что нужно для использования внутри таблицы
 * предпросмотра CSV-импорта, а не только в обычной форме. Закрывается по
 * клику вне, скроллу и Escape. */
function CategoryAutocomplete({
  value,
  onChange,
  categories,
  placeholder,
  required,
  inputClassName,
}: {
  value: string;
  onChange: (v: string) => void;
  categories: string[];
  placeholder?: string;
  required?: boolean;
  inputClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  // Куда портировать панель — обычно document.body, НО если поле находится
  // внутри открытого <dialog> (showModal()), портал в body рисуется ПОД
  // модалкой: открытый <dialog> уходит в отдельный слой браузера ("top
  // layer"), который красится поверх ВСЕГО обычного содержимого страницы
  // независимо от z-index — портированная в body панель в этот слой не
  // попадает и оказывается визуально скрыта под диалогом, даже будучи живой
  // в DOM (баг найден и подтверждён через getComputedStyle() на реальном
  // сайте — семнадцатый проход, уточнение). Портал в САМ `<dialog>` решает
  // это: панель остаётся потомком top layer'а и красится поверх содержимого
  // формы как надо, и заодно (ради чего портал вообще делался) не обрезается
  // overflow:auto таблицы предпросмотра импорта CSV — та проверка не теряется,
  // просто целевой контейнер портала теперь не всегда document.body.
  const [portalTarget, setPortalTarget] = useState<Element | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  function openPanel() {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ top: r.bottom + 4, left: r.left, width: r.width });
    setPortalTarget(el.closest("dialog") || document.body);
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (inputRef.current?.contains(e.target as Node)) return;
      if (panelRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onScrollOrResize() {
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    // capture:true — чтобы поймать скролл ВНУТРИ таблицы предпросмотра
    // импорта (.table-wrap с overflow-y:auto), а не только скролл окна.
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  const q = value.trim().toLowerCase();
  const filtered = (q ? categories.filter((c) => c.toLowerCase().includes(q)) : categories).slice(0, 30);

  return (
    <>
      <input
        ref={inputRef}
        required={required}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          openPanel();
        }}
        onFocus={openPanel}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder={placeholder}
        className={inputClassName}
        autoComplete="off"
      />
      {open &&
        rect &&
        filtered.length > 0 &&
        createPortal(
          <div ref={panelRef} className="autocomplete-panel" style={{ top: rect.top, left: rect.left, width: rect.width }}>
            {filtered.map((name) => (
              <button
                type="button"
                key={name}
                className="autocomplete-option"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(name);
                  setOpen(false);
                }}
              >
                {name}
              </button>
            ))}
          </div>,
          portalTarget || document.body
        )}
    </>
  );
}

/** Модалка добавления/изменения оборудования — тот же идиом `<dialog>`
 * (ref + showModal()/close() в useEffect по `open`), что и DocModal в
 * ./documents.tsx, только с формой вместо предпросмотра документа. Поля и
 * подсказка ступенчатого тарифа — 1:1 из демо (tieredRateFieldsHtml), но
 * секция теперь сворачиваемая (14-й проход, пункт 3 обзора формы "Добавить"). */
function EquipmentFormModal({
  open,
  title,
  initial,
  error,
  isOwner,
  categories,
  warehouses,
  existingCodes,
  allowAddAnother,
  resetSignal,
  onClose,
  onSubmit,
  onManageCategories,
  onManageWarehouses,
}: {
  open: boolean;
  title: string;
  initial: EquipmentFormState;
  error: string | null;
  isOwner: boolean;
  categories: EquipmentCategory[];
  // Справочник складов (восемнадцатый проход) — та же механика, что и у
  // categories выше, но необязательное поле (см. EquipmentFormState.warehouse).
  warehouses: EquipmentWarehouse[];
  // Инвентарные номера уже существующих позиций (кроме редактируемой) — для
  // мягкого предупреждения о дубле, см. duplicateCode ниже.
  existingCodes: string[];
  // Кнопка "Сохранить и добавить ещё" имеет смысл только в режиме
  // добавления/копирования — при редактировании существующей позиции
  // "добавить ещё" нечего.
  allowAddAnother: boolean;
  // Счётчик от родителя: инкремент означает "форма только что успешно
  // отправлена с addAnother=true, сбрось поля, не закрывая модалку" — тот же
  // паттерн, что и createRentalSignal/highlightEmployee.signal в других
  // вкладках.
  resetSignal: number;
  onClose: () => void;
  // Возвращает Promise — модалка ждёт его, чтобы показать "Сохраняем…" и
  // заблокировать повторную отправку (16-й проход, п.2 предыдущего обзора:
  // защита от двойного клика, особенно на бесплатном плане Render с
  // "холодным" стартом backend'а после простоя).
  onSubmit: (form: EquipmentFormState, addAnother: boolean) => Promise<void> | void;
  // Ссылка "Управление категориями" рядом с полем "Категория" (16-й проход,
  // п.7 предыдущего обзора) — открывает EquipmentCategoriesModal ПОВЕРХ этой
  // формы, НЕ закрывая её (родитель не сбрасывает modalMode), чтобы, заметив
  // опечатку в справочнике прямо во время добавления позиции, не пришлось
  // отменять уже введённые данные. Необязательная — форма работает и без
  // неё, если родитель её не передал. Принимает колбэк onPicked — родитель
  // прокидывает его в EquipmentCategoriesModal как onSelect: клик по строке
  // справочника подставит имя сюда, в поле формы (19-й проход, п.2 обзора —
  // "сделать все значения кликабельными"). Открытая тем же кликом из тулбара
  // (без onManageCategories) модалка select-режим не показывает — там onSelect
  // не передаётся вовсе, см. рендер модалки у родителя.
  onManageCategories?: (onPicked: (name: string) => void) => void;
  // Ссылка "Управление складами" — тот же смысл, что и onManageCategories
  // выше (восемнадцатый проход).
  onManageWarehouses?: (onPicked: (name: string) => void) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<EquipmentFormState>(initial);
  const [showTiered, setShowTiered] = useState(hasTieredValues(initial));
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Отдельный useConfirm — для "Несохранённые изменения будут потеряны?" при
  // закрытии заполненной формы (16-й проход, п.6 предыдущего обзора).
  const { confirm: confirmDiscard, dialog: discardDialog } = useConfirm();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Сброс формы при открытии и при каждом "Сохранить и добавить ещё"
  // (resetSignal меняется) — родитель к этому моменту уже пересчитал
  // `initial` под новое пустое состояние (см. EquipmentTab.handleSubmitForm).
  // Native <dialog> остаётся смонтированным всё время (только showModal()/
  // close()), поэтому React не переинициализирует состояние сам по себе —
  // приходится это делать вручную.
  useEffect(() => {
    if (open) {
      setForm(initial);
      setShowTiered(hasTieredValues(initial));
      setLocalError(null);
      // Фокус на "Название" — autoFocus не подходит: он срабатывает только
      // при первом монтировании DOM-узла, а <dialog> здесь монтируется один
      // раз и просто переоткрывается. requestAnimationFrame — чтобы фокус
      // ставился уже после showModal() (иначе браузер может увести фокус на
      // сам <dialog>).
      const raf = requestAnimationFrame(() => nameInputRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resetSignal]);

  const trimmedCode = form.code.trim();
  const duplicateCode = trimmedCode !== "" && existingCodes.includes(trimmedCode);

  const trimmedCategory = form.category.trim();
  // 16-й проход, п.1 предыдущего обзора: подсказка "такой категории ещё нет"
  // для владельца — видна ДО сохранения, чтобы опечатка не превратилась в
  // отдельную категорию-дубль (именно так на проде когда-то расплодились
  // случайные "категории", см. заметки проекта, 15-й проход). Не показана
  // для остальных ролей — у них поле и так закрытый <select> из справочника.
  const isNewCategory =
    isOwner && trimmedCategory !== "" && !categories.some((c) => c.name.toLowerCase() === trimmedCategory.toLowerCase());

  // Тот же смысл, что и isNewCategory выше, но для склада — восемнадцатый
  // проход. Поле необязательное, так что пустое значение никогда не
  // считается "новым складом".
  const trimmedWarehouse = form.warehouse.trim();
  const isNewWarehouse =
    isOwner && trimmedWarehouse !== "" && !warehouses.some((w) => w.name.toLowerCase() === trimmedWarehouse.toLowerCase());

  // 16-й проход, п.3 предыдущего обзора: "битая" настройка ступенчатого
  // тарифа — заполнено 1-3 поля из четырёх, остальные забыты — раньше молча
  // игнорировалась (rateLabel требует и period_days, и period_price сразу).
  // Двадцатый проход добавил четвёртое поле (after_period_days) — та же
  // проверка "всё или ничего", но на четыре поля вместо трёх.
  function tieredProblem(): string | null {
    const filled = [form.period_days, form.period_price, form.period_price_after, form.after_period_days].filter(
      (v) => v.trim() !== ""
    ).length;
    if (filled > 0 && filled < 4) {
      return "Для ступенчатого тарифа нужно заполнить все поля: период, цену за период, длительность шага после и цену за шаг после (или очистить все четыре).";
    }
    return null;
  }

  function validateLocally(): string | null {
    if (!form.name.trim()) return "Название не может состоять из одних пробелов";
    if (!form.category.trim()) return "Категория не может состоять из одних пробелов";
    const rate = parseDecimalField(form.daily_rate);
    if (rate.empty || !rate.valid || (rate.value ?? -1) < 0) return "Ставка должна быть неотрицательным числом.";
    const deposit = parseDecimalField(form.deposit);
    if (deposit.empty || !deposit.valid || (deposit.value ?? -1) < 0) return "Депозит должен быть неотрицательным числом.";
    const periodPrice = parseDecimalField(form.period_price);
    if (!periodPrice.valid) return "Цена за период должна быть числом.";
    const periodPriceAfter = parseDecimalField(form.period_price_after);
    if (!periodPriceAfter.valid) return "Цена за шаг после периода должна быть числом.";
    if (form.after_period_days.trim() !== "" && (!Number.isInteger(Number(form.after_period_days)) || Number(form.after_period_days) < 1)) {
      return "Длительность шага после периода должна быть целым числом дней, не меньше 1.";
    }
    if (allowAddAnother) {
      const qty = Number(form.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > 200) return "Количество должно быть целым числом от 1 до 200.";
    }
    return tieredProblem();
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problem = validateLocally();
    if (problem) {
      setLocalError(problem);
      return;
    }
    setLocalError(null);
    // submitter отличает, какая из двух submit-кнопок нажата — оба варианта
    // ("Сохранить" и "Сохранить и добавить ещё") живут в одной <form>, чтобы
    // не дублировать всю разметку полей.
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const addAnother = submitter?.dataset.addAnother === "true";
    setSubmitting(true);
    try {
      await onSubmit(form, addAnother);
    } finally {
      setSubmitting(false);
    }
  }

  // Единая точка закрытия — X, "Отмена", Esc (см. onCancel ниже) и клик мимо
  // окна (см. onClick на <dialog> ниже) все идут через неё: спрашивает
  // подтверждение, только если форма реально отличается от исходного
  // состояния, иначе закрывает сразу (16-й проход, п.2+6 обзора).
  async function requestClose() {
    if (submitting) return;
    if (isFormDirty(form, initial)) {
      if (!(await confirmDiscard("Несохранённые изменения будут потеряны.", { confirmLabel: "Закрыть без сохранения" })))
        return;
    }
    onClose();
  }

  const previewRate = parseDecimalField(form.daily_rate).value ?? 0;
  const showCostPreview = previewRate > 0;
  // Пример стоимости при вводе ставки/тарифа (16-й проход, п.4 предыдущего
  // обзора) — переиспользует уже существующую itemCostForDays() из
  // financeCalc.ts (та же формула, что считает реальную стоимость аренды),
  // а не отдельную копию логики тарифа.
  function previewCost(days: number): number {
    const periodDays = form.period_days ? Number(form.period_days) : null;
    return itemCostForDays(
      {
        equipment_id: "",
        daily_rate_snapshot: previewRate,
        period_days_snapshot: periodDays,
        period_price_snapshot: parseDecimalField(form.period_price).value,
        period_price_after_snapshot: parseDecimalField(form.period_price_after).value,
        // Длина шага "после" — двадцатый проход, свободна от periodDays (см.
        // Equipment.after_period_days).
        after_period_days_snapshot: form.after_period_days ? Number(form.after_period_days) : null,
      },
      days
    );
  }

  return (
    <dialog
      id="modal"
      className="wide"
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        // Нативный Escape по умолчанию закрыл бы диалог мгновенно — перехватываем,
        // чтобы провести через ту же проверку "не потерять несохранённое", что и
        // остальные способы закрытия.
        e.preventDefault();
        void requestClose();
      }}
      onClick={(e) => {
        // Клик по затемнённому фону — здесь e.target это сам <dialog> (клик по
        // видимому содержимому "перехватывается" внутренними элементами формы
        // раньше); стандартный идиом click-outside-to-close для нативного
        // <dialog> (16-й проход, п.2 обзора).
        if (e.target === e.currentTarget) void requestClose();
      }}
    >
      <form onSubmit={(e) => void handleSubmit(e)}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button type="button" className="icon-btn" onClick={() => void requestClose()} disabled={submitting}>
            <IconClose />
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>Название</label>
            <input
              required
              ref={nameInputRef}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Например, перфоратор Bosch GBH 5-40"
            />
          </div>
          <div className="field">
            <label>Категория</label>
            {isOwner ? (
              // Владелец может ввести и совсем новое название — оно
              // автоматически заведётся в справочнике при сохранении (см.
              // backend: app/api/routes/equipment.py:_ensure_category).
              // CategoryAutocomplete даёт автодополнение по уже существующим,
              // но не запрещает свободный ввод — это и есть "владелец создаёт
              // категории". Поле теперь на своей строке во всю ширину (было
              // в паре с "Инв. номер") — иначе подсказка-плейсхолдер не
              // помещалась (16-й проход, п.7 предыдущего обзора). Раньше
              // здесь был нативный `<input list>`+`<datalist>` — заменён на
              // свой компонент (16-й проход, обзор по скриншотам, п.6:
              // выпадающий список datalist был уже самого поля).
              <CategoryAutocomplete
                required
                value={form.category}
                onChange={(v) => setForm({ ...form, category: v })}
                categories={categories.map((c) => c.name)}
                placeholder="Инструмент, электроника… (или новая категория)"
              />
            ) : (
              // Остальные роли — только выбор из уже существующего
              // справочника, свободный текст закрыт: он всё равно будет
              // отклонён backend'ом (400), выпадающий список честнее
              // показывает границы прав, чем текстовое поле, которое
              // потом откажется сохраняться.
              <select required value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                <option value="" disabled>
                  Выберите категорию…
                </option>
                {categories.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            {categories.length === 0 && !isOwner && (
              <div className="field-hint">Справочник категорий пуст — попросите владельца бизнеса добавить категории.</div>
            )}
            {isNewCategory && (
              <div className="field-hint">Такой категории пока нет — она будет создана автоматически при сохранении.</div>
            )}
            {isOwner && onManageCategories && (
              <div className="field-hint">
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => onManageCategories((name) => setForm((f) => ({ ...f, category: name })))}
                >
                  Управление категориями
                </button>
              </div>
            )}
          </div>
          <div className="field">
            <label>Склад</label>
            {/* Склад — необязательное поле (в отличие от категории), по той
                же механике: владелец может ввести новое название (заведётся
                в справочнике автоматически при сохранении), остальные роли
                выбирают из уже существующего списка или оставляют поле
                пустым — восемнадцатый проход, обзор по скриншотам, п.2:
                "по принципу категорий... можно пойти механике категорий и
                всё разместить тут". */}
            {isOwner ? (
              <CategoryAutocomplete
                value={form.warehouse}
                onChange={(v) => setForm({ ...form, warehouse: v })}
                categories={warehouses.map((w) => w.name)}
                placeholder="Необязательно — если несколько точек хранения"
              />
            ) : (
              <select value={form.warehouse} onChange={(e) => setForm({ ...form, warehouse: e.target.value })}>
                <option value="">Не указан</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.name}>
                    {w.name}
                  </option>
                ))}
              </select>
            )}
            {isNewWarehouse && (
              <div className="field-hint">Такого склада пока нет — он будет создан автоматически при сохранении.</div>
            )}
            {isOwner && onManageWarehouses && (
              <div className="field-hint">
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => onManageWarehouses((name) => setForm((f) => ({ ...f, warehouse: name })))}
                >
                  Управление складами
                </button>
              </div>
            )}
          </div>
          <div className="field-row">
            <div className="field" style={{ maxWidth: "220px" }}>
              <label>Инв. номер</label>
              <input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder="INV-000 (необязательно)"
              />
              {duplicateCode && (
                <div className="field-hint" style={{ color: "var(--warning-ink)" }}>
                  Такой инвентарный номер уже используется другой позицией — сохранить всё равно можно, но лучше
                  проверить, не опечатка ли это.
                </div>
              )}
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Ставка, ₽/сутки</label>
              <input
                required
                type="text"
                inputMode="decimal"
                value={form.daily_rate}
                onChange={(e) => setForm({ ...form, daily_rate: e.target.value })}
                placeholder="напр. 500"
              />
            </div>
            <div className="field">
              <label>Депозит, ₽</label>
              <input
                required
                type="text"
                inputMode="decimal"
                value={form.deposit}
                onChange={(e) => setForm({ ...form, deposit: e.target.value })}
              />
            </div>
          </div>
          {allowAddAnother && (
            <div className="field-row">
              <div className="field">
                <label>Количество одинаковых позиций</label>
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={form.quantity}
                  onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                />
                <div className="field-hint">
                  Если позиций несколько (напр. 30 пар одинаковых костылей), создастся сразу столько отдельных
                  позиций — каждая с собственным статусом и историей аренд.
                </div>
              </div>
            </div>
          )}
          {showTiered ? (
            <>
              <div className="field-row field-row-4">
                <div className="field">
                  <label>Период, дней</label>
                  <input
                    type="number"
                    min="0"
                    value={form.period_days}
                    onChange={(e) => setForm({ ...form, period_days: e.target.value })}
                    placeholder="напр. 14"
                  />
                </div>
                <div className="field">
                  <label>Цена за период, ₽</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={form.period_price}
                    onChange={(e) => setForm({ ...form, period_price: e.target.value })}
                    placeholder="напр. 690"
                  />
                </div>
                <div className="field">
                  <label>Длительность шага после, дней</label>
                  <input
                    type="number"
                    min="1"
                    value={form.after_period_days}
                    onChange={(e) => setForm({ ...form, after_period_days: e.target.value })}
                    placeholder="напр. 7"
                  />
                </div>
                <div className="field">
                  <label>Цена за шаг после периода, ₽</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={form.period_price_after}
                    onChange={(e) => setForm({ ...form, period_price_after: e.target.value })}
                    placeholder="напр. 190"
                  />
                </div>
              </div>
              <div className="field-hint">
                Заполните, если ставка снижается при длительной аренде: первые N дней — по фиксированной цене, а
                каждый полный или начатый шаг сверх этого периода — по отдельной цене за шаг своей длины. Например:
                690 ₽ за первые 14 дней, затем 190 ₽ за любую начатую неделю (шаг 7 дней) после.{" "}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setShowTiered(false);
                    setForm({ ...form, period_days: "", period_price: "", period_price_after: "", after_period_days: "" });
                  }}
                >
                  Убрать ступенчатый тариф
                </button>
              </div>
            </>
          ) : (
            <div className="field-hint">
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setShowTiered(true);
                  setForm({ ...form, after_period_days: form.after_period_days || "1" });
                }}
              >
                + Добавить ступенчатый тариф
              </button>{" "}
              (необязательно — для скидки при длительной аренде)
            </div>
          )}
          {showCostPreview && (
            <div className="field-hint">
              Пример: 7 дней ≈ {money(previewCost(7))} · 30 дней ≈ {money(previewCost(30))}
            </div>
          )}
          <div className="field">
            <label>Заметка</label>
            <textarea
              rows={3}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Состояние, комплектация, особенности — что угодно, что стоит помнить про эту позицию"
            />
          </div>
          {(localError || error) && <div className="form-error">{localError || error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={() => void requestClose()} disabled={submitting}>
            Отмена
          </button>
          {allowAddAnother && (
            <button type="submit" className="btn" data-add-another="true" disabled={submitting}>
              {submitting ? "Сохраняем…" : "Сохранить и добавить ещё"}
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </form>
      {discardDialog}
    </dialog>
  );
}

/* ============================================================
   Слайд-панель с деталями оборудования — 1:1 из демо (openEquipmentDetail):
   статус/ставка/депозит, показатели (выручка/загрузка), пикер статуса
   обслуживания (+ дата окончания), мини-история аренд, кнопки изменить/удалить.
   ============================================================ */
export function EquipmentDetailPanel({
  businessId,
  equipmentId,
  onClose,
  onEdit,
  onCopy,
  onDeleted,
}: {
  businessId: string;
  equipmentId: string;
  onClose: () => void;
  onEdit: (id: string) => void;
  // Необязательный — кнопка "Копировать" показывается, только если её
  // реализовал вызывающий компонент. С дашборда слайдовер открывается в
  // сокращённом варианте (см. Dashboard.tsx: "Изменить" там просто уводит
  // на вкладку "Оборудование", а не открывает форму на месте) — дублировать
  // ту же логику предзаполнения формы там нет смысла, полноценная кнопка
  // нужна только во вкладке "Оборудование" (EquipmentTab), где и живёт
  // сама форма/модалка.
  onCopy?: (id: string) => void;
  onDeleted: () => void;
}) {
  const { equipment, clients, rentals, reloadEquipment } = useData();
  const item = equipment.find((e) => e.id === equipmentId);
  const [maintUntil, setMaintUntil] = useState(item?.maintenance_until ?? "");
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { notify } = useToast();

  useEffect(() => {
    setMaintUntil(item?.maintenance_until ?? "");
  }, [item?.id, item?.maintenance_until]);

  if (!item) return null;

  const today = todayISO();
  const status = equipmentDisplayStatus(item, rentals, today);
  const history = rentals
    .filter((r) => r.items.some((it) => it.equipment_id === equipmentId))
    .slice()
    .sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
  const lifetimeRevenue = equipmentRevenueMap(rentals)[equipmentId] ?? 0;
  const utilPct = equipmentUtilizationPct(item, rentals, 90);

  // Статус-пикер и дата окончания обслуживания PATCH'ят `/businesses/{id}/equipment/{id}`
  // частичным телом ({status: ...} / {maintenance_until: ...}), как в демо. Бэкенд
  // валидирует тело как EquipmentUpdate (все поля необязательны, exclude_unset) —
  // партиальные запросы применяются как есть, без необходимости слать остальные поля.
  async function setStatus(next: Equipment["status"]) {
    try {
      await api.patch(`/businesses/${businessId}/equipment/${equipmentId}`, { status: next });
      await reloadEquipment();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось изменить статус");
    }
  }

  async function handleMaintUntilChange(value: string) {
    setMaintUntil(value);
    try {
      await api.patch(`/businesses/${businessId}/equipment/${equipmentId}`, { maintenance_until: value || null });
      await reloadEquipment();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось изменить дату");
    }
  }

  async function handleDelete() {
    if (equipmentHasOpenRentals(equipmentId, rentals)) {
      notify("Нельзя удалить: по этой позиции есть аренда в работе или бронь. Сначала завершите её.");
      return;
    }
    if (!(await confirm(`«${item!.name}» будет удалено безвозвратно.`, { danger: true }))) return;
    try {
      await api.delete(`/businesses/${businessId}/equipment/${equipmentId}`);
      onDeleted();
      await reloadEquipment();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось удалить");
    }
  }

  return (
    <div className="slideover">
      <div className="slideover-head">
        <div>
          <h3>{item.name}</h3>
          <div style={{ color: "var(--muted)", fontSize: "12.5px", marginTop: "2px" }}>
            № {item.code ?? "—"} · {item.category} ·{" "}
            {item.warehouse ? item.warehouse : <span style={{ opacity: 0.6 }}>склад не указан</span>}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose}>
          <IconClose />
        </button>
      </div>

      <div className="slideover-section">
        <h4>Статус</h4>
        <div style={{ marginBottom: "10px" }}>
          <Badge meta={EQ_META[status]} />
        </div>
        <div className="kv-grid">
          <span className="k">Ставка</span>
          <span className="mono">{rateLabel(item)}</span>
          <span className="k">Депозит</span>
          <span className="mono">{money(item.deposit)}</span>
        </div>
        {item.notes && (
          <div style={{ marginTop: "10px" }}>
            <div className="k" style={{ marginBottom: "4px" }}>
              Заметка
            </div>
            <div style={{ whiteSpace: "pre-wrap", fontSize: "13px" }}>{item.notes}</div>
          </div>
        )}
      </div>

      <div className="slideover-section">
        <h4>Показатели</h4>
        <div className="kv-grid">
          <span className="k">Выручка за всё время</span>
          <span className="mono">{money(lifetimeRevenue)}</span>
          <span className="k">Загрузка за 90 дней</span>
          <span className="mono">{utilPct}%</span>
        </div>
      </div>

      <div className="slideover-section">
        <h4>Изменить статус обслуживания</h4>
        <div className="rating-picker">
          <button
            className={"btn btn-sm" + (item.status === "available" ? " btn-primary" : "")}
            onClick={() => void setStatus("available")}
          >
            Свободно
          </button>
          <button
            className={"btn btn-sm" + (item.status === "maintenance" ? " btn-primary" : "")}
            onClick={() => void setStatus("maintenance")}
          >
            На обслуживании
          </button>
          <button
            className={"btn btn-sm" + (item.status === "retired" ? " btn-primary" : "")}
            onClick={() => void setStatus("retired")}
          >
            Списано
          </button>
        </div>
        {item.status === "maintenance" && (
          <div className="field" style={{ marginTop: "10px" }}>
            <label>Ожидаемая дата окончания (необязательно)</label>
            <input type="date" value={maintUntil} onChange={(e) => void handleMaintUntilChange(e.target.value)} />
            <div className="field-hint">
              {item.maintenance_until
                ? `До ${fmtDate(item.maintenance_until)} позиция недоступна для брони; с ${fmtDate(
                    isoAddDays(item.maintenance_until, 1)
                  )} её снова можно бронировать.`
                : "Без даты позиция считается недоступной, пока статус не сменят вручную."}
            </div>
          </div>
        )}
      </div>

      <div className="slideover-section">
        <h4>История аренд · {history.length}</h4>
        {history.length === 0 ? (
          <div className="empty-note">Ещё не сдавалось в аренду</div>
        ) : (
          history.map((r) => {
            const client = clients.find((c) => c.id === r.client_id);
            return (
              <div className="mini-item" key={r.id}>
                <span>
                  {client?.name ?? "—"} · {fmtDate(r.start_date)}—{fmtDate(r.end_date)}
                </span>
                <Badge meta={RENTAL_META[rentalDisplayStatus(r)]} />
              </div>
            );
          })
        )}
      </div>

      <div className="slideover-section" style={{ display: "flex", gap: "8px" }}>
        <button className="btn" onClick={() => onEdit(equipmentId)}>
          Изменить
        </button>
        {onCopy && (
          <button className="btn" onClick={() => onCopy(equipmentId)}>
            Копировать
          </button>
        )}
        <button className="btn btn-danger-ghost" onClick={() => void handleDelete()}>
          Удалить
        </button>
      </div>

      {confirmDialog}
    </div>
  );
}

/* ============================================================
   Массовый импорт оборудования из CSV — по запросу пользователя в
   тринадцатом проходе ("обязательно нужно реализовать в лучшем виде, как
   считаешь ты"): скачиваемый шаблон → выбор файла → клиентский
   предпросмотр/лёгкая валидация (не ждём сети, чтобы показать явные
   проблемы вроде пустого имени) → отправка файла целиком на backend
   (там — вторая, настоящая валидация построчно, см.
   app/api/routes/equipment.py:import_equipment) → отчёт по каждой строке.
   ============================================================ */
const IMPORT_TEMPLATE_HEADER = [
  "name",
  "category",
  // Склад — необязательная колонка (восемнадцатый проход), может быть
  // пустой в файле, тогда позиция создаётся без привязки к складу.
  "warehouse",
  "code",
  "daily_rate",
  "deposit",
  "period_days",
  "period_price",
  "period_price_after",
  // Длина шага "после" в днях (двадцатый проход) — необязательная колонка,
  // как и три соседних поля тарифа; см. Equipment.after_period_days.
  "after_period_days",
  "notes",
];

const IMPORT_TEMPLATE_EXAMPLE = [
  "Перфоратор Bosch GBH 5-40",
  "Инструмент",
  "Центральный склад",
  "INV-101",
  "500",
  "2000",
  "7",
  "2900",
  "350",
  "7",
  "Комплект полный, состояние хорошее",
];

function downloadImportTemplate() {
  const csv = toCsv(IMPORT_TEMPLATE_HEADER, [IMPORT_TEMPLATE_EXAMPLE]);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }); // BOM — чтобы Excel сразу открыл в UTF-8, не спрашивая кодировку
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "equipment-import-template.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ============================================================
   Экспорт CSV — пункт 2 обзора вкладки «Оборудование» (пятнадцатый проход,
   "Согласен со всем. давай внесем изменения"): выгрузка ТЕКУЩЕГО видимого
   списка (с учётом поиска/фильтра статуса/категории и сортировки — то, что
   пользователь видит на экране, то и выгружается) в тот же CSV-формат, что
   и шаблон импорта, плюс колонка "status" для наглядности (при обратном
   импорте лишняя колонка просто игнорируется парсером — см. csvRowsToObjects).
   Полностью на клиенте, нового backend-эндпоинта не требуется.
   ============================================================ */
const EQUIPMENT_EXPORT_HEADER = [
  "name",
  "category",
  "warehouse",
  "code",
  "daily_rate",
  "deposit",
  "period_days",
  "period_price",
  "period_price_after",
  "after_period_days",
  "status",
  "notes",
];

function exportEquipmentCsv(list: Equipment[], rentals: Rental[], today: string) {
  const rows = list.map((e) => [
    e.name,
    e.category,
    e.warehouse ?? "",
    e.code ?? "",
    e.daily_rate,
    e.deposit,
    e.period_days ?? "",
    e.period_price ?? "",
    e.period_price_after ?? "",
    e.after_period_days ?? "",
    EQ_META[equipmentDisplayStatus(e, rentals, today)].label,
    e.notes ?? "",
  ]);
  const csv = toCsv(EQUIPMENT_EXPORT_HEADER, rows);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }); // BOM — см. downloadImportTemplate выше
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Оборудование ${today}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ============================================================
   Модалка управления справочником категорий — пункт 1 обзора (владелец
   может переименовать категорию, что каскадом переименует её у всего
   оборудования на backend, или удалить неиспользуемую; занятую нельзя —
   см. app/api/routes/equipment.py: rename/delete_equipment_category). Тот же
   идиом <dialog>, что и остальные модалки файла. Список категорий и счётчики
   (equipment_count) приходят из контекста (equipmentCategories) — модалка
   их только показывает и дёргает reload после успешного изменения.
   ============================================================ */
function EquipmentCategoriesModal({
  open,
  businessId,
  categories,
  onClose,
  onChanged,
  onSelect,
}: {
  open: boolean;
  businessId: string;
  categories: EquipmentCategory[];
  onClose: () => void;
  onChanged: () => void;
  // Присутствует только когда модалка открыта из формы добавления/изменения
  // оборудования (ссылка "Управление категориями") — тогда строки становятся
  // кликабельными: клик подставляет имя в поле формы и закрывает модалку.
  // Открытая из тулбара ("Категории"), где onSelect не передан, строки не
  // кликабельны — там это чисто экран управления справочником, выбирать
  // здесь нечего (19-й проход, п.2 обзора).
  onSelect?: (name: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  // Добавление категории прямо из "Управления категориями" (16-й проход,
  // обзор по скриншотам, п.1) — раньше единственный способ завести категорию
  // был вписать новое имя в поле "Категория" формы оборудования (авто-
  // создание при сохранении); эндпоинт POST .../equipment-categories для
  // этого уже существовал на backend с 15-го прохода, просто не был вызван
  // отсюда.
  const [newCatName, setNewCatName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  // Сортировка списка (16-й проход, п.4/5 обзора) — тот же idiom
  // sortable/sort-arrow, что и в главной таблице оборудования ниже по файлу.
  // "custom" (двадцатый проход, п.1 обзора) — ручной порядок (поле position
  // на backend), в этом режиме доступно перетаскивание строк; по умолчанию
  // список открывается именно в нём, так как это порядок, который видит
  // пользователь везде в приложении (фильтры, выпадающие списки).
  const [catSort, setCatSort] = useState<{ key: "custom" | "name" | "count"; dir: "asc" | "desc" }>({
    key: "custom",
    dir: "asc",
  });
  const [dragCatId, setDragCatId] = useState<string | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { notify } = useToast();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (open) {
      setRenamingId(null);
      setRenameValue("");
      setRowError({});
      setNewCatName("");
      setAddError(null);
    }
  }, [open]);

  async function submitNewCategory() {
    const value = newCatName.trim();
    if (!value) {
      setAddError("Название не может быть пустым");
      return;
    }
    if (categories.some((c) => c.name.toLowerCase() === value.toLowerCase())) {
      setAddError("Такая категория уже есть в справочнике");
      return;
    }
    setAddBusy(true);
    setAddError(null);
    try {
      await api.post(`/businesses/${businessId}/equipment-categories`, { name: value });
      setNewCatName("");
      onChanged();
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : "Не удалось добавить категорию");
    } finally {
      setAddBusy(false);
    }
  }

  function toggleCatSort(key: "custom" | "name" | "count") {
    if (key === "custom") {
      setCatSort({ key, dir: "asc" });
      return;
    }
    setCatSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  }
  // В режиме "custom" порядок уже пришёл с backend отсортированным по
  // position (см. GET .../equipment-categories) — переупорядочивать на
  // клиенте не нужно, это и есть тот порядок, который двигает drag'n'drop.
  const sortedCategories =
    catSort.key === "custom"
      ? categories
      : [...categories].sort((a, b) => {
          const dir = catSort.dir === "desc" ? -1 : 1;
          if (catSort.key === "count") return (a.equipment_count - b.equipment_count) * dir;
          return a.name.localeCompare(b.name, "ru") * dir;
        });

  async function submitCatReorder(order: string[]) {
    setReorderBusy(true);
    try {
      await api.post(`/businesses/${businessId}/equipment-categories/reorder`, { order });
      onChanged();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось изменить порядок категорий");
    } finally {
      setReorderBusy(false);
    }
  }

  function handleCatDrop(targetId: string) {
    const dragged = dragCatId;
    setDragCatId(null);
    if (!dragged || dragged === targetId) return;
    const ids = categories.map((c) => c.id);
    const from = ids.indexOf(dragged);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragged);
    void submitCatReorder(ids);
  }

  function startRename(c: EquipmentCategory) {
    setRenamingId(c.id);
    setRenameValue(c.name);
    setRowError((prev) => ({ ...prev, [c.id]: "" }));
  }

  async function submitRename(c: EquipmentCategory) {
    const value = renameValue.trim();
    if (!value) {
      setRowError((prev) => ({ ...prev, [c.id]: "Название не может быть пустым" }));
      return;
    }
    if (value === c.name) {
      setRenamingId(null);
      return;
    }
    setBusyId(c.id);
    try {
      await api.patch(`/businesses/${businessId}/equipment-categories/${c.id}`, { name: value });
      setRenamingId(null);
      onChanged();
    } catch (err) {
      setRowError((prev) => ({ ...prev, [c.id]: err instanceof ApiError ? err.message : "Не удалось переименовать" }));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(c: EquipmentCategory) {
    if (c.equipment_count > 0) {
      notify(
        `Нельзя удалить: категорию «${c.name}» использует ${c.equipment_count} ` +
          `${c.equipment_count === 1 ? "позиция" : "позиций"} оборудования. Сначала перенесите их в другую категорию.`
      );
      return;
    }
    if (!(await confirm(`Категория «${c.name}» будет удалена безвозвратно.`, { danger: true }))) return;
    setBusyId(c.id);
    try {
      await api.delete(`/businesses/${businessId}/equipment-categories/${c.id}`);
      onChanged();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось удалить категорию");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <dialog
      id="modal"
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        // Клик по затемнённому фону закрывает модалку — тот же идиом
        // click-outside-to-close, что и у формы добавления оборудования
        // (16-й проход, п.2 обзора).
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-head">
        <h3>Категории оборудования</h3>
        <button type="button" className="icon-btn" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="modal-body">
        <div className="inline-form" style={{ marginBottom: "14px" }}>
          <input
            value={newCatName}
            onChange={(e) => {
              setNewCatName(e.target.value);
              setAddError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submitNewCategory();
              }
            }}
            placeholder="Новая категория…"
            disabled={addBusy}
            style={{ flex: 1 }}
          />
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void submitNewCategory()} disabled={addBusy}>
            {addBusy ? "Добавляем…" : "Добавить"}
          </button>
        </div>
        {addError && <div className="form-error" style={{ marginBottom: "10px" }}>{addError}</div>}
        {onSelect && categories.length > 0 && (
          <div className="field-hint" style={{ marginBottom: "10px" }}>
            Нажмите на категорию в списке, чтобы подставить её в форму.
          </div>
        )}
        {categories.length === 0 ? (
          <div className="empty-note">Справочник пуст — добавьте первую категорию выше.</div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: "360px", overflowY: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th
                    className={"sortable" + (catSort.key === "custom" ? " active" : "")}
                    title="Ручной порядок — перетащите строки за ⠿, чтобы изменить"
                    onClick={() => toggleCatSort("custom")}
                  >
                    <span className={"sort-arrow" + (catSort.key === "custom" ? "" : " sort-arrow-idle")}>
                      {catSort.key === "custom" ? "⠿" : "↕"}
                    </span>
                  </th>
                  <th className={"sortable" + (catSort.key === "name" ? " active" : "")} onClick={() => toggleCatSort("name")}>
                    Название
                    <span className={"sort-arrow" + (catSort.key === "name" ? "" : " sort-arrow-idle")}>
                      {catSort.key === "name" ? (catSort.dir === "desc" ? "▼" : "▲") : "↕"}
                    </span>
                  </th>
                  <th className={"sortable" + (catSort.key === "count" ? " active" : "")} onClick={() => toggleCatSort("count")}>
                    Позиций
                    <span className={"sort-arrow" + (catSort.key === "count" ? "" : " sort-arrow-idle")}>
                      {catSort.key === "count" ? (catSort.dir === "desc" ? "▼" : "▲") : "↕"}
                    </span>
                  </th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sortedCategories.map((c) => {
                  // Клик по строке выбирает категорию — только в select-режиме
                  // (onSelect передан) и только когда строка не в процессе
                  // переименования (иначе клик по полю ввода/кнопкам конфликтовал
                  // бы с выбором — 19-й проход, п.2 обзора).
                  const selectable = !!onSelect && renamingId !== c.id;
                  // Перетаскивание доступно только в режиме ручного порядка
                  // (иначе порядок строк на экране не совпадает с backend-
                  // позициями, и drop переставил бы не то — двадцатый проход).
                  const draggableRow = catSort.key === "custom" && !reorderBusy;
                  return (
                    <tr
                      key={c.id}
                      className={
                        (selectable ? "row-selectable " : "") + (draggableRow ? "row-draggable" : "") +
                        (dragCatId === c.id ? " dragging" : "")
                      }
                      style={selectable ? { cursor: "pointer" } : undefined}
                      title={selectable ? "Выбрать эту категорию для формы" : undefined}
                      onClick={selectable ? () => { onSelect(c.name); onClose(); } : undefined}
                      onDragOver={
                        draggableRow
                          ? (e) => {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = "move";
                            }
                          : undefined
                      }
                      onDrop={draggableRow ? (e) => { e.preventDefault(); handleCatDrop(c.id); } : undefined}
                    >
                      <td
                        className={"drag-handle-cell" + (draggableRow ? "" : " disabled")}
                        draggable={draggableRow}
                        title={draggableRow ? "Перетащите, чтобы изменить порядок" : "Переключитесь на ручной порядок (⠿), чтобы перетаскивать"}
                        onClick={(e) => e.stopPropagation()}
                        onDragStart={
                          draggableRow
                            ? (e) => {
                                e.dataTransfer.setData("text/plain", c.id);
                                e.dataTransfer.effectAllowed = "move";
                                setDragCatId(c.id);
                              }
                            : undefined
                        }
                        onDragEnd={draggableRow ? () => setDragCatId(null) : undefined}
                      >
                        <IconGrip />
                      </td>
                      <td>
                        {renamingId === c.id ? (
                          <>
                            <input
                              autoFocus
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void submitRename(c);
                                if (e.key === "Escape") setRenamingId(null);
                              }}
                              style={{ maxWidth: "220px" }}
                            />
                            {rowError[c.id] && <div className="form-error">{rowError[c.id]}</div>}
                          </>
                        ) : (
                          c.name
                        )}
                      </td>
                      <td className="mono">{c.equipment_count}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                        {renamingId === c.id ? (
                          <>
                            <button type="button" className="btn btn-sm" onClick={() => setRenamingId(null)} disabled={busyId === c.id}>
                              Отмена
                            </button>{" "}
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              onClick={() => void submitRename(c)}
                              disabled={busyId === c.id}
                            >
                              Сохранить
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="icon-btn"
                              title="Переименовать"
                              onClick={() => startRename(c)}
                              disabled={busyId !== null}
                            >
                              <IconEdit />
                            </button>{" "}
                            <button
                              type="button"
                              className="icon-btn"
                              title={c.equipment_count > 0 ? "Нельзя удалить: категория используется" : "Удалить"}
                              onClick={() => void handleDelete(c)}
                              disabled={busyId !== null}
                            >
                              <IconTrash />
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Готово
        </button>
      </div>
      {confirmDialog}
    </dialog>
  );
}

/* ============================================================
   Модалка управления справочником складов — восемнадцатый проход, точная
   копия EquipmentCategoriesModal выше (тот же идиом, тот же принцип
   переименования каскадом/запрета удаления занятого склада — см. backend
   app/api/routes/equipment.py: rename/delete_equipment_warehouse). Отдельный
   компонент, а не параметризация EquipmentCategoriesModal — тексты и
   эндпоинты в двух местах отличаются ("категория"/"склад",
   equipment-categories/equipment-warehouses), а самой логики немного, так
   что дублирование дешевле, чем обобщение через пропы-строки.
   ============================================================ */
function EquipmentWarehousesModal({
  open,
  businessId,
  warehouses,
  onClose,
  onChanged,
  onSelect,
}: {
  open: boolean;
  businessId: string;
  warehouses: EquipmentWarehouse[];
  onClose: () => void;
  onChanged: () => void;
  // См. onSelect у EquipmentCategoriesModal выше — тот же смысл.
  onSelect?: (name: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newWhName, setNewWhName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  // См. catSort у EquipmentCategoriesModal выше — тот же смысл "custom".
  const [whSort, setWhSort] = useState<{ key: "custom" | "name" | "count"; dir: "asc" | "desc" }>({
    key: "custom",
    dir: "asc",
  });
  const [dragWhId, setDragWhId] = useState<string | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { notify } = useToast();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (open) {
      setRenamingId(null);
      setRenameValue("");
      setRowError({});
      setNewWhName("");
      setAddError(null);
    }
  }, [open]);

  async function submitNewWarehouse() {
    const value = newWhName.trim();
    if (!value) {
      setAddError("Название не может быть пустым");
      return;
    }
    if (warehouses.some((w) => w.name.toLowerCase() === value.toLowerCase())) {
      setAddError("Такой склад уже есть в справочнике");
      return;
    }
    setAddBusy(true);
    setAddError(null);
    try {
      await api.post(`/businesses/${businessId}/equipment-warehouses`, { name: value });
      setNewWhName("");
      onChanged();
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : "Не удалось добавить склад");
    } finally {
      setAddBusy(false);
    }
  }

  function toggleWhSort(key: "custom" | "name" | "count") {
    if (key === "custom") {
      setWhSort({ key, dir: "asc" });
      return;
    }
    setWhSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  }
  const sortedWarehouses =
    whSort.key === "custom"
      ? warehouses
      : [...warehouses].sort((a, b) => {
          const dir = whSort.dir === "desc" ? -1 : 1;
          if (whSort.key === "count") return (a.equipment_count - b.equipment_count) * dir;
          return a.name.localeCompare(b.name, "ru") * dir;
        });

  async function submitWhReorder(order: string[]) {
    setReorderBusy(true);
    try {
      await api.post(`/businesses/${businessId}/equipment-warehouses/reorder`, { order });
      onChanged();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось изменить порядок складов");
    } finally {
      setReorderBusy(false);
    }
  }

  function handleWhDrop(targetId: string) {
    const dragged = dragWhId;
    setDragWhId(null);
    if (!dragged || dragged === targetId) return;
    const ids = warehouses.map((w) => w.id);
    const from = ids.indexOf(dragged);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragged);
    void submitWhReorder(ids);
  }

  function startRename(w: EquipmentWarehouse) {
    setRenamingId(w.id);
    setRenameValue(w.name);
    setRowError((prev) => ({ ...prev, [w.id]: "" }));
  }

  async function submitRename(w: EquipmentWarehouse) {
    const value = renameValue.trim();
    if (!value) {
      setRowError((prev) => ({ ...prev, [w.id]: "Название не может быть пустым" }));
      return;
    }
    if (value === w.name) {
      setRenamingId(null);
      return;
    }
    setBusyId(w.id);
    try {
      await api.patch(`/businesses/${businessId}/equipment-warehouses/${w.id}`, { name: value });
      setRenamingId(null);
      onChanged();
    } catch (err) {
      setRowError((prev) => ({ ...prev, [w.id]: err instanceof ApiError ? err.message : "Не удалось переименовать" }));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(w: EquipmentWarehouse) {
    if (w.equipment_count > 0) {
      notify(
        `Нельзя удалить: склад «${w.name}» использует ${w.equipment_count} ` +
          `${w.equipment_count === 1 ? "позиция" : "позиций"} оборудования. Сначала перенесите их на другой склад.`
      );
      return;
    }
    if (!(await confirm(`Склад «${w.name}» будет удалён безвозвратно.`, { danger: true }))) return;
    setBusyId(w.id);
    try {
      await api.delete(`/businesses/${businessId}/equipment-warehouses/${w.id}`);
      onChanged();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось удалить склад");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <dialog
      id="modal"
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-head">
        <h3>Склады</h3>
        <button type="button" className="icon-btn" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="modal-body">
        <div className="inline-form" style={{ marginBottom: "14px" }}>
          <input
            value={newWhName}
            onChange={(e) => {
              setNewWhName(e.target.value);
              setAddError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submitNewWarehouse();
              }
            }}
            placeholder="Новый склад…"
            disabled={addBusy}
            style={{ flex: 1 }}
          />
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void submitNewWarehouse()} disabled={addBusy}>
            {addBusy ? "Добавляем…" : "Добавить"}
          </button>
        </div>
        {addError && <div className="form-error" style={{ marginBottom: "10px" }}>{addError}</div>}
        {onSelect && warehouses.length > 0 && (
          <div className="field-hint" style={{ marginBottom: "10px" }}>
            Нажмите на склад в списке, чтобы подставить его в форму.
          </div>
        )}
        {warehouses.length === 0 ? (
          <div className="empty-note">Справочник пуст — добавьте первый склад выше (нужно только если у бизнеса несколько точек хранения).</div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: "360px", overflowY: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th
                    className={"sortable" + (whSort.key === "custom" ? " active" : "")}
                    title="Ручной порядок — перетащите строки за ⠿, чтобы изменить"
                    onClick={() => toggleWhSort("custom")}
                  >
                    <span className={"sort-arrow" + (whSort.key === "custom" ? "" : " sort-arrow-idle")}>
                      {whSort.key === "custom" ? "⠿" : "↕"}
                    </span>
                  </th>
                  <th className={"sortable" + (whSort.key === "name" ? " active" : "")} onClick={() => toggleWhSort("name")}>
                    Название
                    <span className={"sort-arrow" + (whSort.key === "name" ? "" : " sort-arrow-idle")}>
                      {whSort.key === "name" ? (whSort.dir === "desc" ? "▼" : "▲") : "↕"}
                    </span>
                  </th>
                  <th className={"sortable" + (whSort.key === "count" ? " active" : "")} onClick={() => toggleWhSort("count")}>
                    Позиций
                    <span className={"sort-arrow" + (whSort.key === "count" ? "" : " sort-arrow-idle")}>
                      {whSort.key === "count" ? (whSort.dir === "desc" ? "▼" : "▲") : "↕"}
                    </span>
                  </th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sortedWarehouses.map((w) => {
                  const selectable = !!onSelect && renamingId !== w.id;
                  const draggableRow = whSort.key === "custom" && !reorderBusy;
                  return (
                    <tr
                      key={w.id}
                      className={
                        (selectable ? "row-selectable " : "") + (draggableRow ? "row-draggable" : "") +
                        (dragWhId === w.id ? " dragging" : "")
                      }
                      style={selectable ? { cursor: "pointer" } : undefined}
                      title={selectable ? "Выбрать этот склад для формы" : undefined}
                      onClick={selectable ? () => { onSelect(w.name); onClose(); } : undefined}
                      onDragOver={
                        draggableRow
                          ? (e) => {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = "move";
                            }
                          : undefined
                      }
                      onDrop={draggableRow ? (e) => { e.preventDefault(); handleWhDrop(w.id); } : undefined}
                    >
                      <td
                        className={"drag-handle-cell" + (draggableRow ? "" : " disabled")}
                        draggable={draggableRow}
                        title={draggableRow ? "Перетащите, чтобы изменить порядок" : "Переключитесь на ручной порядок (⠿), чтобы перетаскивать"}
                        onClick={(e) => e.stopPropagation()}
                        onDragStart={
                          draggableRow
                            ? (e) => {
                                e.dataTransfer.setData("text/plain", w.id);
                                e.dataTransfer.effectAllowed = "move";
                                setDragWhId(w.id);
                              }
                            : undefined
                        }
                        onDragEnd={draggableRow ? () => setDragWhId(null) : undefined}
                      >
                        <IconGrip />
                      </td>
                      <td>
                        {renamingId === w.id ? (
                          <>
                            <input
                              autoFocus
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void submitRename(w);
                                if (e.key === "Escape") setRenamingId(null);
                              }}
                              style={{ maxWidth: "220px" }}
                            />
                            {rowError[w.id] && <div className="form-error">{rowError[w.id]}</div>}
                          </>
                        ) : (
                          w.name
                        )}
                      </td>
                      <td className="mono">{w.equipment_count}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                        {renamingId === w.id ? (
                          <>
                            <button type="button" className="btn btn-sm" onClick={() => setRenamingId(null)} disabled={busyId === w.id}>
                              Отмена
                            </button>{" "}
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              onClick={() => void submitRename(w)}
                              disabled={busyId === w.id}
                            >
                              Сохранить
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="icon-btn"
                              title="Переименовать"
                              onClick={() => startRename(w)}
                              disabled={busyId !== null}
                            >
                              <IconEdit />
                            </button>{" "}
                            <button
                              type="button"
                              className="icon-btn"
                              title={w.equipment_count > 0 ? "Нельзя удалить: склад используется" : "Удалить"}
                              onClick={() => void handleDelete(w)}
                              disabled={busyId !== null}
                            >
                              <IconTrash />
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Готово
        </button>
      </div>
      {confirmDialog}
    </dialog>
  );
}

interface ImportPreviewRow {
  row: number;
  // Все колонки шаблона (не только проблемные) — чтобы при сборке
  // исправленного CSV перед отправкой (см. handleImport) неотредактированные
  // поля не терялись, см. 16-й проход, п.6 обзора.
  values: Record<string, string>;
  problems: string[];
}

/** Лёгкая клиентская проверка — только то, что можно сказать без сети
 * (справочник категорий уже загружен в контексте, но окончательное решение
 * "существует ли категория" всё равно принимает backend, в том числе
 * потому что для владельца неизвестная категория — это не ошибка, а повод
 * завести её). Здесь ловим только совсем явный мусор — пустые обязательные
 * поля и нечисловую ставку — чтобы пользователь увидел проблему до
 * отправки файла, а не только из ответа сервера. */
function validatePreviewRow(obj: Record<string, string>): string[] {
  const problems: string[] = [];
  if (!obj.name) problems.push("нет названия");
  if (!obj.category) problems.push("нет категории");
  const rate = (obj.daily_rate || "").replace(",", ".");
  if (!rate) problems.push("нет ставки");
  else if (Number.isNaN(Number(rate))) problems.push("ставка не число");
  return problems;
}

function EquipmentImportModal({
  open,
  businessId,
  categories,
  onClose,
  onImported,
}: {
  open: boolean;
  businessId: string;
  // Для автодополнения категории при инлайн-редактировании ячейки
  // предпросмотра (16-й проход, п.6 обзора).
  categories: EquipmentCategory[];
  onClose: () => void;
  onImported: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewRow[]>([]);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<EquipmentImportResult | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function reset() {
    setFile(null);
    setPreview([]);
    setHeaderError(null);
    setSubmitError(null);
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleFileChange(f: File | null) {
    setFile(f);
    setResult(null);
    setSubmitError(null);
    setPreview([]);
    setHeaderError(null);
    if (!f) return;
    const text = await f.text();
    const parsed = parseCsv(text);
    const header = parsed.header.map((h) => h.trim().toLowerCase());
    if (!header.includes("name") || !header.includes("category") || !header.includes("daily_rate")) {
      setHeaderError("В заголовке файла должны быть как минимум колонки: name, category, daily_rate");
      return;
    }
    const objects = csvRowsToObjects(parsed);
    setPreview(
      objects.map((obj, idx) => ({
        row: idx + 2, // строка 1 — заголовок
        values: Object.fromEntries(IMPORT_TEMPLATE_HEADER.map((h) => [h, obj[h] || ""])),
        problems: validatePreviewRow(obj),
      }))
    );
  }

  /** Правка ячейки прямо в таблице предпросмотра (16-й проход, п.6 обзора:
   * "быстрая смена значений" вместо необходимости чинить сам файл и грузить
   * заново) — пересчитывает проблемы строки сразу же, чтобы было видно,
   * решена ли она. */
  function updateCell(rowIdx: number, field: string, value: string) {
    setPreview((prev) =>
      prev.map((r, i) => {
        if (i !== rowIdx) return r;
        const values = { ...r.values, [field]: value };
        return { ...r, values, problems: validatePreviewRow(values) };
      })
    );
  }

  async function handleImport() {
    if (!file || preview.length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Собираем CSV заново из (возможно отредактированных прямо в
      // предпросмотре) значений, а не отправляем исходный файл как есть —
      // иначе правки в таблице предпросмотра были бы чисто визуальными и
      // никак не влияли бы на то, что реально уходит на сервер.
      const rows = preview.map((r) => IMPORT_TEMPLATE_HEADER.map((h) => r.values[h] ?? ""));
      const csv = toCsv(IMPORT_TEMPLATE_HEADER, rows);
      const editedFile = new File(["﻿" + csv], file.name, { type: "text/csv;charset=utf-8" });
      const form = new FormData();
      form.append("file", editedFile);
      const res = await api.postForm<EquipmentImportResult>(`/businesses/${businessId}/equipment/import`, form);
      setResult(res);
      if (res.created > 0) onImported();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Не удалось загрузить файл");
    } finally {
      setSubmitting(false);
    }
  }

  const problemCount = preview.filter((r) => r.problems.length > 0).length;

  return (
    <dialog
      id="modal"
      className="wide"
      ref={ref}
      onClose={handleClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="modal-head">
        <h3>Массовый импорт оборудования из CSV</h3>
        <button type="button" className="icon-btn" onClick={handleClose}>
          <IconClose />
        </button>
      </div>
      <div className="modal-body">
        {!result && (
          <>
            <div className="field-hint" style={{ marginBottom: "10px" }}>
              Файл CSV с заголовком в первой строке. Обязательные колонки: <code>name</code>, <code>category</code>,{" "}
              <code>daily_rate</code>. Необязательные: <code>warehouse</code>, <code>code</code>, <code>deposit</code>,{" "}
              <code>period_days</code>, <code>period_price</code>, <code>period_price_after</code>,{" "}
              <code>after_period_days</code>, <code>notes</code>. Категория и склад должны либо уже быть в соответствующем справочнике, либо — если
              импорт делает владелец бизнеса — заведутся автоматически.
            </div>
            <button type="button" className="btn btn-sm" onClick={downloadImportTemplate}>
              Скачать шаблон CSV
            </button>
            <div className="field" style={{ marginTop: "14px" }}>
              <label>Файл</label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => void handleFileChange(e.target.files?.[0] ?? null)}
              />
            </div>
            {headerError && <div className="form-error">{headerError}</div>}
            {preview.length > 0 && (
              <>
                <div className="field-hint" style={{ marginTop: "10px" }}>
                  Найдено строк: {preview.length}
                  {problemCount > 0 ? `, из них с явными проблемами: ${problemCount} (не пройдут импорт)` : ""}. Значения
                  ниже можно поправить прямо здесь — при импорте уйдут именно они, а не исходный файл.
                  Окончательную проверку (включая справочник категорий) всё равно выполнит сервер.
                </div>
                <div className="table-wrap" style={{ maxHeight: "260px", overflowY: "auto", marginTop: "8px" }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Строка</th>
                        <th>Название</th>
                        <th>Категория</th>
                        <th>Ставка</th>
                        <th>Проблемы</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((r, idx) => (
                        <tr key={r.row}>
                          <td className="mono">{r.row}</td>
                          <td>
                            <input
                              className="table-input"
                              value={r.values.name}
                              onChange={(e) => updateCell(idx, "name", e.target.value)}
                            />
                          </td>
                          <td>
                            <CategoryAutocomplete
                              inputClassName="table-input"
                              value={r.values.category}
                              onChange={(v) => updateCell(idx, "category", v)}
                              categories={categories.map((c) => c.name)}
                            />
                          </td>
                          <td>
                            <input
                              className="table-input mono"
                              value={r.values.daily_rate}
                              onChange={(e) => updateCell(idx, "daily_rate", e.target.value)}
                            />
                          </td>
                          <td>{r.problems.length > 0 ? r.problems.join(", ") : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {submitError && <div className="form-error">{submitError}</div>}
          </>
        )}

        {result && (
          <>
            <div className="field-hint" style={{ marginBottom: "10px" }}>
              Готово: создано {result.created} из {result.total}
              {result.failed > 0 ? `, ошибок: ${result.failed}` : ""}.
            </div>
            <div className="table-wrap" style={{ maxHeight: "320px", overflowY: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Строка</th>
                    <th>Название</th>
                    <th>Результат</th>
                  </tr>
                </thead>
                <tbody>
                  {result.results.map((r) => (
                    <tr key={r.row}>
                      <td className="mono">{r.row}</td>
                      <td>{r.name}</td>
                      <td>
                        {r.ok ? (
                          <span style={{ color: "var(--good-ink)", fontWeight: 600 }}>Создано</span>
                        ) : (
                          <span style={{ color: "var(--critical-ink)" }}>{r.error}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      <div className="modal-foot">
        {result ? (
          <button type="button" className="btn btn-primary" onClick={handleClose}>
            Готово
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={handleClose}>
              Отмена
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!file || !!headerError || submitting}
              onClick={() => void handleImport()}
            >
              {submitting ? "Импортируем…" : "Импортировать"}
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}

/* ============================================================
   Вкладка «Оборудование»
   ============================================================ */
export function EquipmentTab({
  businessId,
  search,
  filter,
  setFilter,
  isOwner,
}: {
  businessId: string;
  search: string;
  filter: string;
  setFilter: (f: string) => void;
  isOwner: boolean;
}) {
  const { equipment, equipmentCategories, equipmentWarehouses, rentals, reloadEquipment, reloadEquipmentCategories, reloadEquipmentWarehouses } =
    useData();
  // usePersistedState вместо обычного useState — девятнадцатый проход, п.4
  // обзора: сортировка переживает обновление страницы (хранится отдельно на
  // каждый businessId).
  const [sort, setSort] = usePersistedState<EquipmentSort>(`equipment-sort:${businessId}`, { key: null, dir: "asc" });
  // Видимость/порядок столбцов таблицы (двадцатый проход, п.2 обзора) — БЕЗ
  // businessId в ключе, см. докстринг EquipmentColumnsPrefs выше.
  const [columnsPrefs, setColumnsPrefs] = usePersistedState<EquipmentColumnsPrefs>(
    "equipment-columns-v1",
    DEFAULT_EQUIPMENT_COLUMNS_PREFS
  );
  const [columnsPopoverOpen, setColumnsPopoverOpen] = useState(false);
  const [dragColumnKey, setDragColumnKey] = useState<string | null>(null);
  const columnsPopoverRef = useRef<HTMLDivElement>(null);
  const equipmentColumns = visibleEquipmentColumns(columnsPrefs);

  function toggleColumnHidden(key: string) {
    setColumnsPrefs((prev) => {
      const hidden = prev.hidden.includes(key) ? prev.hidden.filter((k) => k !== key) : [...prev.hidden, key];
      return { ...prev, hidden };
    });
  }

  function moveColumn(dragged: string, target: string) {
    if (!dragged || !target || dragged === target) return;
    setColumnsPrefs((prev) => {
      const known = prev.order.filter((id) => EQUIPMENT_TOGGLEABLE_COLUMN_IDS.includes(id));
      const extra = EQUIPMENT_TOGGLEABLE_COLUMN_IDS.filter((id) => !known.includes(id));
      const order = known.concat(extra);
      const from = order.indexOf(dragged);
      const to = order.indexOf(target);
      if (from === -1 || to === -1) return prev;
      order.splice(from, 1);
      order.splice(to, 0, dragged);
      return { ...prev, order };
    });
  }

  // Клик вне попапа настройки столбцов закрывает его — тот же idiom, что у
  // catFilterRef/whFilterRef ниже.
  useEffect(() => {
    if (!columnsPopoverOpen) return;
    function onDocClick(e: MouseEvent) {
      if (columnsPopoverRef.current && !columnsPopoverRef.current.contains(e.target as Node)) {
        setColumnsPopoverOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [columnsPopoverOpen]);

  // Массив вместо одиночного значения — 16-й проход, п.11 обзора:
  // мультивыбор категорий в фильтре. Пустой массив = "Все категории" (тот же
  // смысл, что раньше был у "all"), непустой = показывать позиции ЛЮБОЙ из
  // выбранных категорий.
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [catFilterOpen, setCatFilterOpen] = useState(false);
  const catFilterRef = useRef<HTMLDivElement>(null);
  // Фильтр по складу (восемнадцатый проход) — точная копия механики
  // categoryFilter выше, тот же смысл пустого массива ("все склады").
  const [warehouseFilter, setWarehouseFilter] = useState<string[]>([]);
  const [whFilterOpen, setWhFilterOpen] = useState(false);
  const whFilterRef = useRef<HTMLDivElement>(null);
  const [modalMode, setModalMode] = useState<"add" | "edit" | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [copySource, setCopySource] = useState<Equipment | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  // Инкрементируется при успешном "Сохранить и добавить ещё" — сигнал для
  // EquipmentFormModal сбросить внутреннее состояние формы, не закрывая
  // <dialog> (тот же паттерн, что и createRentalSignal в RentalsTab).
  const [formResetSignal, setFormResetSignal] = useState(0);
  // Пятнадцатый проход (обзор вкладки, пункты 1/3/4): справочник категорий,
  // массовые действия над выбранными строками.
  // null — закрыта; {} — открыта из тулбара (просто управление справочником);
  // {onSelect} — открыта из формы добавления/изменения оборудования (ссылка
  // "Управление категориями/складами") — тогда строки в модалке кликабельны и
  // выбор подставляется обратно в поле формы через этот колбэк (19-й проход,
  // п.2 обзора: "сделать все значения кликабельными").
  const [categoriesModal, setCategoriesModal] = useState<{ onSelect?: (name: string) => void } | null>(null);
  const [warehousesModal, setWarehousesModal] = useState<{ onSelect?: (name: string) => void } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Развёрнутые группы одинаковых позиций (двадцатый проход, п.3 обзора) —
  // по умолчанию свёрнуты (ключ группы отсутствует в множестве), чтобы 30
  // одинаковых костылей не занимали 30 строк сразу; ключ группы включает id
  // первой позиции кластера — см. buildEquipmentRenderRows.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [bulkCategory, setBulkCategory] = useState("");
  const [bulkStatus, setBulkStatus] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const { confirm: confirmBulk, dialog: bulkConfirmDialog } = useConfirm();
  const { notify } = useToast();

  const today = todayISO();
  const q = search.trim().toLowerCase();
  // Категорийный фильтр — независимый от поиска и статусного фильтра,
  // комбинируется с обоими (см. согласование с пользователем в тринадцатом
  // проходе: "Фильтр категорий обязательно нужен").
  const bySearchCategoryAndWarehouse = equipment.filter((e) => {
    const matchesCategory = categoryFilter.length === 0 || categoryFilter.includes(e.category);
    // Пустой warehouseFilter — "все склады", включая позиции вообще без
    // склада; выбор конкретных складов исключает позиции без склада (у них
    // e.warehouse === null, что никогда не совпадёт с выбранным именем) —
    // восемнадцатый проход, та же механика, что и у categoryFilter.
    const matchesWarehouse = warehouseFilter.length === 0 || (e.warehouse != null && warehouseFilter.includes(e.warehouse));
    const matchesSearch = !q || (e.name + " " + e.category + " " + (e.code ?? "")).toLowerCase().includes(q);
    return matchesCategory && matchesWarehouse && matchesSearch;
  });
  // Счётчики на кнопках статуса считаются от уже применённых поиска,
  // категории и склада, но НЕ от самого статусного фильтра — иначе,
  // переключаясь между статусами, пользователь видел бы на остальных
  // кнопках всегда "0" (см. согласование: "Счётчики - делаем").
  const statusCounts: Record<string, number> = { all: bySearchCategoryAndWarehouse.length };
  for (const f of FILTERS) {
    if (f.id === "all") continue;
    statusCounts[f.id] = bySearchCategoryAndWarehouse.filter((e) => equipmentDisplayStatus(e, rentals, today) === f.id).length;
  }
  const filtered = bySearchCategoryAndWarehouse.filter(
    (e) => filter === "all" || equipmentDisplayStatus(e, rentals, today) === filter
  );
  const list = sortEquipmentList(filtered, sort, rentals, today);
  // Группировка одинаковых позиций (двадцатый проход, п.3 обзора) — см.
  // buildEquipmentRenderRows/equipmentGroupKey выше.
  const renderGroups = buildEquipmentRenderRows(list);

  // Сброс выделения при смене фильтров/поиска — иначе можно было бы
  // применить массовое действие к строкам, которые сейчас не видны на
  // экране (список отфильтрован), что было бы неожиданно для пользователя.
  useEffect(() => {
    setSelectedIds(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, categoryFilter, warehouseFilter, search]);

  // Закрытие выпадающей панели мультивыбора категорий по клику вне неё
  // (16-й проход, п.11 обзора) — это не <dialog>, а обычный абсолютно
  // спозиционированный блок, поэтому click-outside реализован через
  // document-листенер, а не через нативный backdrop-клик, как у модалок.
  useEffect(() => {
    if (!catFilterOpen) return;
    function onDocClick(e: MouseEvent) {
      if (catFilterRef.current && !catFilterRef.current.contains(e.target as Node)) setCatFilterOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [catFilterOpen]);

  // Тот же click-outside idiom, что и у catFilterOpen выше, для панели
  // фильтра по складу (восемнадцатый проход).
  useEffect(() => {
    if (!whFilterOpen) return;
    function onDocClick(e: MouseEvent) {
      if (whFilterRef.current && !whFilterRef.current.contains(e.target as Node)) setWhFilterOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [whFilterOpen]);

  function toggleCategoryFilterValue(name: string) {
    setCategoryFilter((prev) => {
      const next = prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name];
      // Если пользователь вручную отметил буквально все категории по одной —
      // это то же самое, что вообще не фильтровать ("Все категории"), так
      // что схлопываем обратно в пустой массив-сентинел, чтобы галочка
      // "Все категории" сама подсветилась (восемнадцатый проход, обзор по
      // скриншотам, п.3). matchesCategory ниже трактует пустой массив как
      // "показать всё" — то же самое поведение, что и явный клик по "Все
      // категории".
      if (next.length > 0 && equipmentCategories.length > 0 && next.length === equipmentCategories.length) {
        return [];
      }
      return next;
    });
  }

  // Точная копия toggleCategoryFilterValue выше — та же авто-отметка "Все
  // склады" при ручном выборе всех складов по одному (восемнадцатый проход).
  function toggleWarehouseFilterValue(name: string) {
    setWarehouseFilter((prev) => {
      const next = prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name];
      if (next.length > 0 && equipmentWarehouses.length > 0 && next.length === equipmentWarehouses.length) {
        return [];
      }
      return next;
    });
  }

  function toggleSort(key: string) {
    setSort((prev) => {
      if (prev.key === key) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
      return { key, dir: "asc" };
    });
  }

  function openAddModal() {
    setEditingId(null);
    setCopySource(null);
    setFormError(null);
    setModalMode("add");
  }

  function openEditModal(id: string) {
    setEditingId(id);
    setCopySource(null);
    setFormError(null);
    setModalMode("edit");
  }

  function openCopyModal(item: Equipment) {
    setEditingId(null);
    setCopySource(item);
    setFormError(null);
    setModalMode("add");
  }

  function closeFormModal() {
    setModalMode(null);
    setEditingId(null);
    setCopySource(null);
    setFormError(null);
  }

  async function handleSubmitForm(form: EquipmentFormState, addAnother: boolean) {
    setFormError(null);
    try {
      if (modalMode === "edit" && editingId) {
        await api.patch(`/businesses/${businessId}/equipment/${editingId}`, formToPayload(form));
      } else {
        const qty = Number(form.quantity) || 1;
        if (qty > 1) {
          // Несколько одинаковых позиций сразу (двадцатый проход, п.3
          // обзора) — отдельный эндпоинт /equipment/bulk, каждая позиция
          // остаётся отдельной строкой с собственным статусом/историей (см.
          // formToPayload — quantity туда намеренно не входит).
          await api.post(`/businesses/${businessId}/equipment/bulk`, { ...formToPayload(form), quantity: qty });
        } else {
          await api.post(`/businesses/${businessId}/equipment`, formToPayload(form));
        }
      }
      await Promise.all([reloadEquipment(), reloadEquipmentCategories(), reloadEquipmentWarehouses()]);
      if (addAnother) {
        // Модалка остаётся открытой в режиме "add" с пустой формой — copySource
        // тоже сбрасывается, иначе следующее "добавить ещё" опять подставило бы
        // исходную позицию для копирования вместо чистого бланка.
        setCopySource(null);
        setFormResetSignal((n) => n + 1);
      } else {
        closeFormModal();
      }
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Не удалось сохранить оборудование");
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => (prev.size === list.length ? new Set() : new Set(list.map((e) => e.id))));
  }

  /** Чекбокс на строке-группе (двадцатый проход, п.3 обзора,
   * bulk-select-by-group) — выбирает/снимает выбор со ВСЕХ позиций группы
   * разом, чтобы массовые действия (смена категории/статуса/удаление) можно
   * было применить ко всем 30 костылям одним чекбоксом, не разворачивая
   * группу. */
  function toggleSelectedGroup(ids: string[], allSelected: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }

  function toggleGroupExpanded(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** Массовая смена категории выбранных позиций — по одному PATCH-запросу на
   * позицию (Promise.allSettled, чтобы одна ошибка не остановила остальные),
   * с итоговым отчётом об ошибках, если они были (см. согласование с
   * пользователем: "Согласен со всем" по пункту 3 обзора — массовые действия). */
  async function handleBulkCategory() {
    if (!bulkCategory || selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      const ids = [...selectedIds];
      const results = await Promise.allSettled(
        ids.map((id) => api.patch(`/businesses/${businessId}/equipment/${id}`, { category: bulkCategory }))
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      await Promise.all([reloadEquipment(), reloadEquipmentCategories()]);
      setBulkCategory("");
      setSelectedIds(new Set());
      if (failed > 0) notify(`Категория изменена у ${ids.length - failed} из ${ids.length}. Ошибок: ${failed}.`, "info");
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleBulkStatus() {
    if (!bulkStatus || selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      const ids = [...selectedIds];
      const results = await Promise.allSettled(
        ids.map((id) => api.patch(`/businesses/${businessId}/equipment/${id}`, { status: bulkStatus }))
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      await reloadEquipment();
      setBulkStatus("");
      setSelectedIds(new Set());
      if (failed > 0) notify(`Статус изменён у ${ids.length - failed} из ${ids.length}. Ошибок: ${failed}.`, "info");
    } finally {
      setBulkBusy(false);
    }
  }

  /** Массовое удаление — позиции с открытой арендой/бронью пропускаются без
   * попытки удаления (тот же принцип, что и у одиночного удаления в
   * EquipmentDetailPanel.handleDelete, только здесь заранее отфильтровано,
   * а не отклонено сервером по одной). */
  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    const blocked = ids.filter((id) => equipmentHasOpenRentals(id, rentals));
    const deletable = ids.filter((id) => !equipmentHasOpenRentals(id, rentals));
    if (deletable.length === 0) {
      notify("Ни одну из выбранных позиций нельзя удалить: по каждой есть аренда в работе или бронь.");
      return;
    }
    const message =
      blocked.length > 0
        ? `Будет безвозвратно удалено позиций: ${deletable.length} из ${ids.length}. Остальные ${blocked.length} пропущены — по ним есть аренда в работе или бронь.`
        : `Будет безвозвратно удалено позиций: ${deletable.length}.`;
    if (!(await confirmBulk(message, { danger: true }))) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(deletable.map((id) => api.delete(`/businesses/${businessId}/equipment/${id}`)));
      const failed = results.filter((r) => r.status === "rejected").length;
      await Promise.all([reloadEquipment(), reloadEquipmentCategories(), reloadEquipmentWarehouses()]);
      setSelectedIds(new Set());
      if (failed > 0 || blocked.length > 0) {
        notify(
          `Удалено: ${deletable.length - failed}.` +
            (failed > 0 ? ` Ошибок: ${failed}.` : "") +
            (blocked.length > 0 ? ` Пропущено (аренда в работе): ${blocked.length}.` : ""),
          "info"
        );
      }
    } finally {
      setBulkBusy(false);
    }
  }

  const editingItem = editingId ? equipment.find((e) => e.id === editingId) ?? null : null;
  const formTitle = modalMode === "edit" ? "Изменить оборудование" : copySource ? "Копия оборудования" : "Новое оборудование";
  const formInitial =
    modalMode === "edit" && editingItem
      ? formFromEquipment(editingItem)
      : copySource
      ? formFromEquipmentAsCopy(copySource)
      : EMPTY_FORM;

  const categoryNames = equipmentCategories.map((c) => c.name);
  const warehouseNames = equipmentWarehouses.map((w) => w.name);
  // Для мягкого предупреждения о дубле инв. номера — код самой редактируемой
  // позиции исключается, иначе форма предупреждала бы о "дубле" при
  // сохранении без изменения номера.
  const existingCodes = equipment.filter((e) => e.id !== editingId && e.code).map((e) => e.code as string);

  return (
    <div>
      <div className="tab-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <div className="segmented">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={filter === f.id ? "active" : ""}
                onClick={() => setFilter(f.id)}
              >
                {f.label} ({statusCounts[f.id] ?? 0})
              </button>
            ))}
          </div>
          {categoryNames.length > 0 && (
            // Мультивыбор категорий вместо нативного одиночного <select>
            // (16-й проход, п.10+11 обзора) — заодно решает проблему со
            // стрелочкой нативного select'а (он вообще не был кастомизирован
            // и рисовался браузером как есть) и добавляет выбор нескольких
            // категорий сразу.
            <div className="cat-filter" ref={catFilterRef}>
              <button type="button" className="btn cat-filter-btn" onClick={() => setCatFilterOpen((v) => !v)}>
                {categoryFilter.length === 0
                  ? "Все категории"
                  : categoryFilter.length === 1
                  ? categoryFilter[0]
                  : `Категорий: ${categoryFilter.length}`}
                <IconChevronDown />
              </button>
              {catFilterOpen && (
                <div className="cat-filter-panel">
                  <label className={"cat-filter-option" + (categoryFilter.length === 0 ? " checked" : "")}>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={categoryFilter.length === 0}
                      onChange={() => setCategoryFilter([])}
                    />
                    <span className="cat-filter-check">{categoryFilter.length === 0 && <IconCheck />}</span>
                    <span className="cat-filter-name">Все категории</span>
                  </label>
                  <div className="cat-filter-sep" />
                  {/* Счётчик позиций рядом с названием (16-й проход, обзор по
                      скриншотам, п.5) — equipment_count уже есть в каждой
                      категории (используется и в "Управлении категориями"),
                      просто не выводился здесь. */}
                  {equipmentCategories.map((c) => (
                    <label className={"cat-filter-option" + (categoryFilter.includes(c.name) ? " checked" : "")} key={c.id}>
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={categoryFilter.includes(c.name)}
                        onChange={() => toggleCategoryFilterValue(c.name)}
                      />
                      <span className="cat-filter-check">{categoryFilter.includes(c.name) && <IconCheck />}</span>
                      <span className="cat-filter-name">{c.name}</span>
                      <span className="cat-filter-count">{c.equipment_count}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          {warehouseNames.length > 0 && (
            // Точная копия фильтра по категории выше — восемнадцатый проход,
            // та же механика ("механике категорий и все разместить тут").
            <div className="cat-filter" ref={whFilterRef}>
              <button type="button" className="btn cat-filter-btn" onClick={() => setWhFilterOpen((v) => !v)}>
                {warehouseFilter.length === 0
                  ? "Все склады"
                  : warehouseFilter.length === 1
                  ? warehouseFilter[0]
                  : `Складов: ${warehouseFilter.length}`}
                <IconChevronDown />
              </button>
              {whFilterOpen && (
                <div className="cat-filter-panel">
                  <label className={"cat-filter-option" + (warehouseFilter.length === 0 ? " checked" : "")}>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={warehouseFilter.length === 0}
                      onChange={() => setWarehouseFilter([])}
                    />
                    <span className="cat-filter-check">{warehouseFilter.length === 0 && <IconCheck />}</span>
                    <span className="cat-filter-name">Все склады</span>
                  </label>
                  <div className="cat-filter-sep" />
                  {equipmentWarehouses.map((w) => (
                    <label className={"cat-filter-option" + (warehouseFilter.includes(w.name) ? " checked" : "")} key={w.id}>
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={warehouseFilter.includes(w.name)}
                        onChange={() => toggleWarehouseFilterValue(w.name)}
                      />
                      <span className="cat-filter-check">{warehouseFilter.includes(w.name) && <IconCheck />}</span>
                      <span className="cat-filter-name">{w.name}</span>
                      <span className="cat-filter-count">{w.equipment_count}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          {isOwner && (
            <button className="btn" onClick={() => setCategoriesModal({})}>
              Категории
            </button>
          )}
          {isOwner && (
            <button className="btn" onClick={() => setWarehousesModal({})}>
              Склады
            </button>
          )}
          {/* Настройка столбцов таблицы (двадцатый проход, п.2 обзора:
              скрыть/переставить — растягивание пока не делаем). Тот же
              контейнер .cat-filter, что у фильтров выше, но не привязан к
              businessId (personal display preference — см.
              DEFAULT_EQUIPMENT_COLUMNS_PREFS). */}
          <div className="cat-filter" ref={columnsPopoverRef}>
            <button type="button" className="btn cat-filter-btn" onClick={() => setColumnsPopoverOpen((v) => !v)}>
              Столбцы
              <IconChevronDown />
            </button>
            {columnsPopoverOpen && (
              <div className="cat-filter-panel" style={{ minWidth: "240px" }}>
                <div className="field-hint" style={{ padding: "2px 6px 6px" }}>
                  Перетащите за ⠿, чтобы изменить порядок. Столбец «Оборудование» всегда виден и всегда первый.
                </div>
                {visibleEquipmentColumns({ ...columnsPrefs, hidden: [] })
                  .map((c) => c.key)
                  .map((key) => {
                    const col = EQUIPMENT_SORT_COLUMNS.find((c) => c.key === key)!;
                    const visible = !columnsPrefs.hidden.includes(key);
                    return (
                      <div
                        key={key}
                        className={"col-settings-row row-draggable" + (dragColumnKey === key ? " dragging" : "")}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/plain", key);
                          e.dataTransfer.effectAllowed = "move";
                          setDragColumnKey(key);
                        }}
                        onDragEnd={() => setDragColumnKey(null)}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          const dragged = dragColumnKey;
                          setDragColumnKey(null);
                          if (dragged) moveColumn(dragged, key);
                        }}
                      >
                        <span className="col-settings-grip" title="Перетащите, чтобы изменить порядок">
                          <IconGrip />
                        </span>
                        <label className={"cat-filter-option" + (visible ? " checked" : "")} style={{ flex: 1, padding: "5px 6px" }}>
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={visible}
                            onChange={() => toggleColumnHidden(key)}
                          />
                          <span className="cat-filter-check">{visible && <IconCheck />}</span>
                          <span className="cat-filter-name">{col.label}</span>
                        </label>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
          <button className="btn" onClick={() => exportEquipmentCsv(list, rentals, today)} disabled={list.length === 0}>
            Экспорт CSV
          </button>
          <button className="btn" onClick={() => setImportOpen(true)}>
            Импорт CSV
          </button>
          <button className="btn btn-primary" onClick={openAddModal}>
            + Добавить
          </button>
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div className="panel" style={{ marginBottom: "10px" }}>
          <div className="panel-body" style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <strong>Выбрано: {selectedIds.size}</strong>
            <select value={bulkCategory} onChange={(e) => setBulkCategory(e.target.value)} style={{ maxWidth: "200px" }} disabled={bulkBusy}>
              <option value="">Изменить категорию…</option>
              {categoryNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <button className="btn btn-sm" disabled={!bulkCategory || bulkBusy} onClick={() => void handleBulkCategory()}>
              Применить
            </button>
            <select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)} style={{ maxWidth: "180px" }} disabled={bulkBusy}>
              <option value="">Изменить статус…</option>
              <option value="available">Свободно</option>
              <option value="maintenance">На обслуживании</option>
              <option value="retired">Списано</option>
            </select>
            <button className="btn btn-sm" disabled={!bulkStatus || bulkBusy} onClick={() => void handleBulkStatus()}>
              Применить
            </button>
            <button className="btn btn-sm btn-danger-ghost" disabled={bulkBusy} onClick={() => void handleBulkDelete()}>
              Удалить выбранные
            </button>
            <button className="btn btn-sm" disabled={bulkBusy} onClick={() => setSelectedIds(new Set())}>
              Снять выделение
            </button>
          </div>
        </div>
      )}

      {list.length === 0 ? (
        <div className="panel">
          <div className="panel-body">
            <div className="empty-note">Ничего не найдено{q ? ` по запросу «${search}»` : ""}.</div>
          </div>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: "1%" }}>
                  <input
                    type="checkbox"
                    checked={list.length > 0 && selectedIds.size === list.length}
                    onChange={toggleSelectAll}
                    title="Выбрать все"
                  />
                </th>
                {/* "Оборудование" — всегда первый и всегда виден, вне
                    настройки столбцов (см. EQUIPMENT_TOGGLEABLE_COLUMN_IDS). */}
                <th
                  className={"sortable" + (sort.key === "name" ? " active" : "")}
                  onClick={() => toggleSort("name")}
                >
                  Оборудование
                  <span className={"sort-arrow" + (sort.key === "name" ? "" : " sort-arrow-idle")}>
                    {sort.key === "name" ? (sort.dir === "desc" ? "▼" : "▲") : "↕"}
                  </span>
                </th>
                {equipmentColumns.map((col) => {
                  const active = sort.key === col.key;
                  return (
                    <th
                      key={col.key}
                      className={"sortable" + (active ? " active" : "")}
                      onClick={() => toggleSort(col.key)}
                    >
                      {col.label}
                      <span className={"sort-arrow" + (active ? "" : " sort-arrow-idle")}>
                        {active ? (sort.dir === "desc" ? "▼" : "▲") : "↕"}
                      </span>
                    </th>
                  );
                })}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {renderGroups.map((group) => {
                if (group.items.length === 1) {
                  const it = group.items[0];
                  const status = equipmentDisplayStatus(it, rentals, today);
                  let freeFrom: string | null = null;
                  if (status === "rented" || status === "overdue") {
                    const nf = nextFreeDate(it, rentals);
                    if (nf) freeFrom = fmtDate(isoAddDays(nf, 1));
                  } else if (status === "maintenance" && it.maintenance_until) {
                    freeFrom = fmtDate(isoAddDays(it.maintenance_until, 1));
                  }
                  return (
                    <tr key={it.id} data-clickable="true" onClick={() => setOpenId(it.id)}>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={selectedIds.has(it.id)} onChange={() => toggleSelected(it.id)} />
                      </td>
                      <td>
                        <div className="cell-name">
                          {it.name}
                          {it.notes && <span className="cell-note-dot" title="Есть заметка" />}
                        </div>
                        <div className="cell-sub">№ {it.code ?? "—"}</div>
                      </td>
                      {equipmentColumns.map((col) => (
                        <td key={col.key} className={equipmentCellClassName(col.key)}>
                          {renderEquipmentCell(col.key, it, status, freeFrom)}
                        </td>
                      ))}
                      <td onClick={(e) => e.stopPropagation()} style={{ textAlign: "right" }}>
                        <button type="button" className="icon-btn" title="Копировать" onClick={() => openCopyModal(it)}>
                          <IconCopy />
                        </button>
                      </td>
                    </tr>
                  );
                }

                // Группа из нескольких визуально одинаковых позиций
                // (двадцатый проход, п.3 обзора) — сворачиваемая строка с
                // разбивкой по статусам вместо N одинаковых строк подряд.
                const groupKey = group.key + "::" + group.items[0].id;
                const expanded = expandedGroups.has(groupKey);
                const ids = group.items.map((x) => x.id);
                const selectedCount = ids.filter((id) => selectedIds.has(id)).length;
                const allSelected = selectedCount === ids.length;
                const someSelected = selectedCount > 0 && !allSelected;
                const first = group.items[0];
                const firstStatus = equipmentDisplayStatus(first, rentals, today);
                const statusCounts: Record<string, number> = {};
                let anyNotes = false;
                group.items.forEach((x) => {
                  const st = equipmentDisplayStatus(x, rentals, today);
                  statusCounts[st] = (statusCounts[st] || 0) + 1;
                  if (x.notes) anyNotes = true;
                });
                return (
                  <Fragment key={groupKey}>
                    <tr
                      className="group-header-row"
                      data-clickable="true"
                      onClick={() => toggleGroupExpanded(groupKey)}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={allSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = someSelected;
                          }}
                          onChange={() => toggleSelectedGroup(ids, allSelected)}
                        />
                      </td>
                      <td>
                        <div className="cell-name">
                          <span className={"group-chevron" + (expanded ? " expanded" : "")}>
                            <IconChevronDown />
                          </span>
                          {first.name}
                          {anyNotes && <span className="cell-note-dot" title="Есть заметка у одной из позиций" />}
                        </div>
                        <div className="cell-sub">{group.items.length} одинаковых позиций — нажмите, чтобы развернуть</div>
                      </td>
                      {equipmentColumns.map((col) => (
                        <td key={col.key} className={equipmentCellClassName(col.key)}>
                          {col.key === "status" ? (
                            <div className="group-status-breakdown">
                              {Object.keys(EQ_META)
                                .filter((st) => statusCounts[st])
                                .map((st) => (
                                  <span key={st} className={`badge tone-${EQ_META[st].tone}`}>
                                    <span className="dot" />
                                    {EQ_META[st].label} × {statusCounts[st]}
                                  </span>
                                ))}
                            </div>
                          ) : (
                            renderEquipmentCell(col.key, first, firstStatus, null)
                          )}
                        </td>
                      ))}
                      <td></td>
                    </tr>
                    {expanded &&
                      group.items.map((it) => {
                        const status = equipmentDisplayStatus(it, rentals, today);
                        let freeFrom: string | null = null;
                        if (status === "rented" || status === "overdue") {
                          const nf = nextFreeDate(it, rentals);
                          if (nf) freeFrom = fmtDate(isoAddDays(nf, 1));
                        } else if (status === "maintenance" && it.maintenance_until) {
                          freeFrom = fmtDate(isoAddDays(it.maintenance_until, 1));
                        }
                        return (
                          <tr key={it.id} className="group-item-row" data-clickable="true" onClick={() => setOpenId(it.id)}>
                            <td onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={selectedIds.has(it.id)}
                                onChange={() => toggleSelected(it.id)}
                              />
                            </td>
                            <td>
                              <div className="cell-sub cell-name-indented">
                                № {it.code ?? "—"}
                                {it.notes && <span className="cell-note-dot" title="Есть заметка" />}
                              </div>
                            </td>
                            {equipmentColumns.map((col) => (
                              <td key={col.key} className={equipmentCellClassName(col.key)}>
                                {renderEquipmentCell(col.key, it, status, freeFrom)}
                              </td>
                            ))}
                            <td onClick={(e) => e.stopPropagation()} style={{ textAlign: "right" }}>
                              <button type="button" className="icon-btn" title="Копировать" onClick={() => openCopyModal(it)}>
                                <IconCopy />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <EquipmentFormModal
        open={modalMode !== null}
        title={formTitle}
        initial={formInitial}
        error={formError}
        isOwner={isOwner}
        categories={equipmentCategories}
        warehouses={equipmentWarehouses}
        existingCodes={existingCodes}
        allowAddAnother={modalMode === "add"}
        resetSignal={formResetSignal}
        onClose={closeFormModal}
        onSubmit={(form, addAnother) => handleSubmitForm(form, addAnother)}
        onManageCategories={isOwner ? (onPicked) => setCategoriesModal({ onSelect: onPicked }) : undefined}
        onManageWarehouses={isOwner ? (onPicked) => setWarehousesModal({ onSelect: onPicked }) : undefined}
      />

      <EquipmentImportModal
        open={importOpen}
        businessId={businessId}
        categories={equipmentCategories}
        onClose={() => setImportOpen(false)}
        onImported={() => void Promise.all([reloadEquipment(), reloadEquipmentCategories(), reloadEquipmentWarehouses()])}
      />

      <EquipmentCategoriesModal
        open={categoriesModal !== null}
        businessId={businessId}
        categories={equipmentCategories}
        onClose={() => setCategoriesModal(null)}
        onChanged={() => void Promise.all([reloadEquipment(), reloadEquipmentCategories()])}
        onSelect={categoriesModal?.onSelect}
      />

      <EquipmentWarehousesModal
        open={warehousesModal !== null}
        businessId={businessId}
        warehouses={equipmentWarehouses}
        onClose={() => setWarehousesModal(null)}
        onChanged={() => void Promise.all([reloadEquipment(), reloadEquipmentWarehouses()])}
        onSelect={warehousesModal?.onSelect}
      />
      {bulkConfirmDialog}

      {openId && <div className="slideover-backdrop" onClick={() => setOpenId(null)} />}
      {openId && (
        <EquipmentDetailPanel
          businessId={businessId}
          equipmentId={openId}
          onClose={() => setOpenId(null)}
          onEdit={(id) => {
            setOpenId(null);
            openEditModal(id);
          }}
          onCopy={(id) => {
            const item = equipment.find((e) => e.id === id);
            setOpenId(null);
            if (item) openCopyModal(item);
          }}
          onDeleted={() => setOpenId(null)}
        />
      )}
    </div>
  );
}
