/**
 * Вкладка «Оборудование» — двадцать второй проход разнёс этот файл (было
 * 3300+ строк) по отдельным модулям в папке ./equipment/ (форма, детали,
 * категории/склады, импорт, CSV, мелкие хелперы) — здесь остались только
 * сортировка/фильтрация/группировка списка и сам компонент EquipmentTab.
 * EquipmentDetailPanel ре-экспортируется из ./equipment/EquipmentDetailPanel
 * НИЖЕ по файлу без изменений — единственный внешний потребитель,
 * Dashboard.tsx, импортирует его именно отсюда и не требует правок.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import { useData } from "../../context/DataContext";
import type { Equipment, Rental, TrashedEquipment } from "../../api/types";
import { EQ_META, Badge, equipmentDisplayStatus, nextFreeDate } from "../../lib/statusMeta";
import { money, fmtDate, isoAddDays, todayISO } from "../../lib/format";
import {
  IconCopy,
  IconChevronDown,
  IconCheck,
  IconGrip,
  IconSliders,
  IconEye,
  IconEyeOff,
  IconTrash,
  IconRestore,
  IconClose,
} from "../../lib/icons";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { usePersistedState } from "../../lib/persist";
import { EMPTY_FORM, formFromEquipment, formFromEquipmentAsCopy, formToPayload, type EquipmentFormState } from "./equipment/formHelpers";
import { rateLabel, equipmentHasOpenRentals } from "./equipment/helpers";
import { exportEquipmentCsv } from "./equipment/csv";
import { EquipmentFormModal } from "./equipment/EquipmentFormModal";
import { EquipmentImportModal } from "./equipment/EquipmentImportModal";
import { EquipmentCategoriesModal } from "./equipment/EquipmentCategoriesModal";
import { EquipmentWarehousesModal } from "./equipment/EquipmentWarehousesModal";
import { EquipmentDetailPanel } from "./equipment/EquipmentDetailPanel";
import { Dropdown } from "../../components/Dropdown";
import { MoreActionsMenu } from "../../components/MoreActionsMenu";

export { EquipmentDetailPanel };

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
   Корзина оборудования (29-й проход, п.14 обзора) — точная копия
   ClientTrashModal из ClientsTab.tsx, только для позиций оборудования. См.
   докстринг там же: список удалённых за последние 30 дней (см.
   TRASH_RETENTION_DAYS в app/services/trash.py), восстановление в один клик.
   ============================================================ */
function EquipmentTrashModal({
  open,
  businessId,
  onClose,
  onRestored,
}: {
  open: boolean;
  businessId: string;
  onClose: () => void;
  onRestored: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<TrashedEquipment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setItems(null);
    setError(null);
    api
      .get<TrashedEquipment[]>(`/businesses/${businessId}/equipment/trash`)
      .then((res) => {
        if (!cancelled) setItems(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Не удалось загрузить корзину");
      });
    return () => {
      cancelled = true;
    };
  }, [open, businessId]);

  async function handleRestore(id: string) {
    setRestoringId(id);
    try {
      await api.post(`/businesses/${businessId}/equipment/${id}/restore`, {});
      setItems((prev) => (prev ?? []).filter((e) => e.id !== id));
      onRestored();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось восстановить позицию");
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <dialog
      id="modal"
      className="wide"
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-head">
        <h3>Корзина оборудования</h3>
        <button type="button" className="icon-btn" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="modal-body">
        <div className="field-hint" style={{ marginBottom: "10px" }}>
          Удалённые позиции хранятся здесь 30 дней и восстанавливаются в один клик. Позиции с историей аренд остаются в
          корзине бессрочно — это финансовая история, физически она не удаляется.
        </div>
        {error && <div className="form-error">{error}</div>}
        {items === null ? (
          <div className="empty-note">Загрузка…</div>
        ) : items.length === 0 ? (
          <div className="empty-note">Корзина пуста</div>
        ) : (
          items.map((it) => (
            <div className="mini-item" key={it.id}>
              <span>
                {it.name} · № {it.code ?? "—"} · {it.category}
                <span style={{ color: "var(--muted)", fontSize: "11.5px", marginLeft: "8px" }}>
                  удалена {fmtDate(it.deleted_at.slice(0, 10))}
                  {it.deleted_by_name ? ` · ${it.deleted_by_name}` : ""}
                </span>
              </span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={restoringId === it.id}
                onClick={() => void handleRestore(it.id)}
              >
                <IconRestore /> {restoringId === it.id ? "Восстанавливаем…" : "Восстановить"}
              </button>
            </div>
          ))
        )}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Готово
        </button>
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
  // Режим редактирования столбцов — двадцать первый проход, п.4 обзора:
  // раньше это был выпадающий список-чекбокс (в духе .cat-filter-panel), не
  // похожий по стилю ни на что другое в приложении; теперь — та же механика
  // "режим настройки" (кнопка со IconSliders, "Готово" вместо неё, грип+глаз
  // на каждой карточке, подсветка места вставки через classList), что уже
  // есть на Дашборде (см. DashboardTab.tsx: editMode/DraggableBlock). Ряд
  // карточек-столбцов появляется прямо над таблицей, а не в попапе.
  const [columnsEditMode, setColumnsEditMode] = useState(false);
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
  // Корзина (29-й проход, п.14 обзора) — тот же idiom, что и importOpen выше.
  const [trashOpen, setTrashOpen] = useState(false);
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
    // 29-й проход, п.14 обзора: удаление теперь мягкое (см. EquipmentTrashModal
    // выше) — формулировка обновлена вместе с backend'ом.
    const message =
      blocked.length > 0
        ? `Будет перемещено в корзину позиций: ${deletable.length} из ${ids.length}. Остальные ${blocked.length} пропущены — по ним есть аренда в работе или бронь. Восстановить можно в течение 30 дней.`
        : `Будет перемещено в корзину позиций: ${deletable.length}. Восстановить можно в течение 30 дней.`;
    if (!(await confirmBulk(message, { danger: true, confirmLabel: "В корзину" }))) return;
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
      <div className="tab-toolbar-grid">
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
        {/* Колонка кнопок в .tab-toolbar-grid — та же правка и по той же
            причине, что и в ClientsTab.tsx (30-й проход, "прибить Ещё/
            +Добавить к верхнему правому углу"): здесь фильтров слева
            больше (статусы + категории + склады), поэтому перенос на
            вторую строку случается заметно чаще — Grid-родитель держит
            эту колонку у верхнего правого угла независимо от того, во
            сколько строк перенеслись фильтры (см. styles.css). */}
        <div style={{ display: "flex", gap: "8px" }}>
          {/* Редкие служебные действия спрятаны за одной кнопкой "⋯ Ещё"
              (29-й проход, ещё один повторный обзор — "верхняя часть
              страницы перегружена кнопками", та же правка, что и в
              ClientsTab.tsx): управление категориями/складами, настройку
              столбцов, импорт/экспорт CSV и корзину открывают не каждый
              день, в отличие от "+ Добавить". См.
              components/MoreActionsMenu.tsx. */}
          <MoreActionsMenu
            actions={[
              ...(isOwner
                ? [
                    { key: "categories", label: "Категории", onClick: () => setCategoriesModal({}) },
                    { key: "warehouses", label: "Склады", onClick: () => setWarehousesModal({}) },
                  ]
                : []),
              // "Настроить столбцы" — только точка ВХОДА в режим редактирования,
              // пока он выключен. Пока включён, кнопка выхода ("Готово")
              // намеренно вынесена из меню в открытую (см. ниже) — спрятанный
              // выход из активного режима неочевиден (замечено пользователем
              // на живом скриншоте после первой версии меню "Ещё"), а не
              // рядовое редкое действие вроде экспорта.
              ...(columnsEditMode
                ? []
                : [
                    {
                      key: "columns",
                      icon: <IconSliders />,
                      label: "Настроить столбцы",
                      onClick: () => setColumnsEditMode(true),
                    },
                  ]),
              {
                key: "export",
                label: "Экспорт CSV",
                onClick: () => exportEquipmentCsv(list, rentals, today),
                disabled: list.length === 0,
              },
              { key: "import", label: "Импорт CSV", onClick: () => setImportOpen(true) },
              { key: "trash", icon: <IconTrash />, label: "Корзина", onClick: () => setTrashOpen(true) },
            ]}
          />
          {columnsEditMode && (
            <button type="button" className="btn btn-primary" onClick={() => setColumnsEditMode(false)}>
              <IconSliders /> Готово
            </button>
          )}
          <button className="btn btn-primary" onClick={openAddModal}>
            + Добавить
          </button>
        </div>
      </div>

      {columnsEditMode && (
        <div className="panel" style={{ marginBottom: "10px" }}>
          <div className="panel-body">
            <div className="field-hint" style={{ marginBottom: "8px" }}>
              Перетащите карточку, чтобы изменить порядок столбцов, или нажмите на глаз, чтобы скрыть/показать. Столбец «Оборудование» всегда виден и всегда первый.
            </div>
            <div className="col-edit-row">
              {visibleEquipmentColumns({ ...columnsPrefs, hidden: [] }).map((col) => {
                const hiddenCol = columnsPrefs.hidden.includes(col.key);
                return (
                  <div
                    key={col.key}
                    className={"dash-block-cell col-edit-chip" + (hiddenCol ? " dash-block-hidden" : "")}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", col.key);
                      e.dataTransfer.effectAllowed = "move";
                      e.currentTarget.classList.add("dragging");
                    }}
                    onDragEnd={(e) => e.currentTarget.classList.remove("dragging")}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      e.currentTarget.classList.add("drag-over");
                    }}
                    onDragLeave={(e) => e.currentTarget.classList.remove("drag-over")}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.currentTarget.classList.remove("drag-over");
                      const dragged = e.dataTransfer.getData("text/plain");
                      if (dragged) moveColumn(dragged, col.key);
                    }}
                  >
                    <div className="dash-handle">
                      <span className="dash-grip" title="Перетащите, чтобы изменить порядок">
                        <IconGrip />
                      </span>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => toggleColumnHidden(col.key)}
                        title={hiddenCol ? "Показать столбец" : "Скрыть столбец"}
                      >
                        {hiddenCol ? <IconEyeOff /> : <IconEye />}
                      </button>
                    </div>
                    <span className="col-edit-chip-label">{col.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="panel" style={{ marginBottom: "10px" }}>
          <div className="panel-body" style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <strong>Выбрано: {selectedIds.size}</strong>
            <Dropdown
              value={bulkCategory}
              onChange={setBulkCategory}
              placeholder="Изменить категорию…"
              disabled={bulkBusy}
              style={{ maxWidth: "200px" }}
              options={categoryNames.map((name) => ({ value: name, label: name }))}
            />
            <button className="btn btn-sm" disabled={!bulkCategory || bulkBusy} onClick={() => void handleBulkCategory()}>
              Применить
            </button>
            <Dropdown
              value={bulkStatus}
              onChange={setBulkStatus}
              placeholder="Изменить статус…"
              disabled={bulkBusy}
              style={{ maxWidth: "180px" }}
              options={[
                { value: "available", label: "Свободно" },
                { value: "maintenance", label: "На обслуживании" },
                { value: "retired", label: "Списано" },
              ]}
            />
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

      <EquipmentTrashModal
        open={trashOpen}
        businessId={businessId}
        onClose={() => setTrashOpen(false)}
        onRestored={() => void Promise.all([reloadEquipment(), reloadEquipmentCategories(), reloadEquipmentWarehouses()])}
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
