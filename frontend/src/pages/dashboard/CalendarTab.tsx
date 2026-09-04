/**
 * Календарь занятости оборудования — перенесено из демо-прототипа
 * (renderCalendar() + equipmentDayStatus() + orderedEquipmentCategories()/
 * moveCalCategory() + isCalCategoryCollapsed()/toggleCalCategoryCollapsed() +
 * overlapDays() + обработчики протяжки мышью calDrag/calHighlightRange и
 * calColDrag/calColPreview). В демо всё это — глобальные функции и
 * делегированные обработчики на document; здесь — один React-компонент,
 * протяжка мышью реализована через нативные document-level mousedown/
 * mouseover/mouseup (как в демо) с прямым толканием CSS-классов в DOM во
 * время движения мыши — так подсветка диапазона не требует ре-рендера
 * компонента на каждый mouseover, как и в оригинале.
 *
 * ОСОЗНАННОЕ УПРОЩЕНИЕ ОТНОСИТЕЛЬНО ДЕМО (см. также комментарии ниже по
 * месту): всплывающее уведомление "диапазон занят" раньше шло через browser
 * alert() (соответствовало остальному приложению — см. 16-й проход, обзор
 * по скриншотам). Теперь — через общий useToast() (Toast.tsx), системную
 * замену alert() на всё приложение.
 *
 * 53-й проход, по итогам всестороннего обзора вкладки (дизайн/удобство/
 * функционал) — четыре правки, приводящие календарь к тем же паттернам,
 * что уже есть на "Оборудовании"/"Клиентах"/"Арендах":
 *  1. Порядок категорий (drag-and-drop) и свёрнутые категории теперь
 *     персистентны через usePersistedState (тот же общий хук, что и
 *     сортировка на других вкладках) — раньше сбрасывались при уходе со
 *     вкладки/перезагрузке страницы (было осознанным упрощением, но
 *     оказалось неудобным при реальном использовании).
 *  2. Занятая ячейка теперь кликабельна и открывает RentalDetailPanel той
 *     же аренды — раньше клик работал только по свободным ячейкам
 *     (бронирование), а по занятым не делал ничего, хотя курсор-указатель
 *     намекал на кликабельность. Полный набор действий (выдать/принять
 *     возврат/изменить/продлить/отменить/повторить) подключён так же, как
 *     на вкладке "Аренды" — RentalsTab.tsx.
 *  3. Категории теперь выбираются через общий Dropdown (components/
 *     Dropdown.tsx), а не плоским рядом кнопок на каждую категорию сразу —
 *     тот ряд неограниченно рос вширь при добавлении категорий.
 *  4. Тулбар переведён на общий .tab-toolbar-grid (фильтры слева, кнопки
 *     действий прибиты к правому верхнему углу — как везде); добавлена
 *     кнопка "+ Новая аренда" на привычном месте (переиспользует
 *     CreateRentalModal), а "Свернуть/развернуть все" и раздвоенная кнопка
 *     "Сегодня" убраны под общий "Ещё" — тот же принцип разгрузки шапки,
 *     что и на "Оборудовании"/"Клиентах".
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useData } from "../../context/DataContext";
import { api, ApiError } from "../../api/client";
import type { Client, Equipment, Rental } from "../../api/types";
import { todayISO, isoAddDays, dayDiff, ymd, fmtDate, money, spanDays } from "../../lib/format";
import { toCsv } from "../../lib/csv";
import { IconChevronDown, IconGrip, IconClose, IconAlert } from "../../lib/icons";
import { useToast } from "../../components/Toast";
import { useConfirm } from "../../components/ConfirmDialog";
import { Dropdown } from "../../components/Dropdown";
import { MoreActionsMenu } from "../../components/MoreActionsMenu";
import { usePersistedState } from "../../lib/persist";
import { isUnpaid } from "./rentals/helpers";
import { DocModal, buildIssueDoc, buildReturnDoc } from "./documents";
import { RentalDetailPanel, PaymentModal } from "./rentals/RentalDetailPanel";
import { CreateRentalModal } from "./rentals/CreateRentalModal";
import { EditRentalModal } from "./rentals/EditRentalModal";
import { ExtendRentalModal } from "./rentals/ExtendRentalModal";
import { CancelRentalModal } from "./rentals/CancelRentalModal";
import { IssueRentalModal } from "./rentals/IssueRentalModal";
import { ReturnRentalModal } from "./rentals/ReturnRentalModal";

const CAL_RANGE_OPTIONS: (number | "month")[] = [7, 14, 30, "month"];

/** Русское склонение числительных: pluralRu(2,"раз","раза","раз") -> "раза" — 1:1 из демо. */
function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod100 > 10 && mod100 < 20) return many;
  if (mod10 === 1) return one;
  if (mod10 > 1 && mod10 < 5) return few;
  return many;
}

function clientInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const s = parts.slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join("");
  return s || "?";
}

/**
 * Стоимость оборудования за N дней с учётом ступенчатого тарифа — локальный
 * аналог itemCostForDays() демо. В отличие от демо (где расчёт велся по
 * снимку цены ПОЗИЦИИ АРЕНДЫ, зафиксированному на момент брони), здесь для
 * ещё не существующей брони (сводка выделенных столбцов, предпросмотр в
 * форме быстрой брони) считаем по ТЕКУЩИМ ставкам каталога оборудования
 * (Equipment.daily_rate/period_days/period_price/period_price_after) — это
 * приближённая оценка, а не точная финансовая сумма (её после создания
 * аренды посчитает backend, как и везде в проде).
 */
// Формула приведена в соответствие с app/services/pricing.py:item_cost_for_days
// и financeCalc.ts:itemCostForDays (16-й проход — здесь раньше была другая,
// расходящаяся с реальным биллингом формула "полных периодов", см. подробный
// комментарий в financeCalc.ts).
function itemCostForDays(eq: Equipment, days: number): number {
  if (days <= 0) return 0;
  if (!eq.period_days || !eq.period_price) return eq.daily_rate * days;
  const P = eq.period_days;
  if (days <= P) return eq.daily_rate * days;
  const extraDays = days - P;
  // Блочная надбавка (двадцатый проход) — см. financeCalc.ts:itemCostForDays,
  // та же формула, продублированная здесь по тому же принципу, что и раньше.
  if (eq.after_period_days) {
    const blocks = Math.ceil(extraDays / eq.after_period_days);
    return eq.period_price + blocks * (eq.period_price_after || 0);
  }
  const perDayAfter = (eq.period_price_after || 0) / P;
  return eq.period_price + extraDays * perDayAfter;
}

function isUnderMaintenanceOn(eq: Equipment, d: string): boolean {
  if (eq.status !== "maintenance") return false;
  if (!eq.maintenance_until) return true;
  return d <= eq.maintenance_until;
}

interface DayStatus {
  cls: "st-available" | "st-booked" | "st-active" | "st-overdue" | "st-maintenance";
  title: string;
  hit: Rental | null;
}

/** Статус конкретной единицы оборудования на конкретный день — 1:1 с equipmentDayStatus() демо. */
function equipmentDayStatus(e: Equipment, d: string, rentals: Rental[], clients: Client[]): DayStatus {
  if (isUnderMaintenanceOn(e, d)) {
    return {
      cls: "st-maintenance",
      title: "На обслуживании" + (e.maintenance_until ? " до " + fmtDate(e.maintenance_until) : ""),
      hit: null,
    };
  }
  const hit =
    rentals.find(
      (r) =>
        (r.status === "booked" || r.status === "active") &&
        r.items.some((it) => it.equipment_id === e.id) &&
        d >= r.start_date &&
        d <= r.end_date
    ) ?? null;
  if (!hit) return { cls: "st-available", title: "Свободно", hit: null };
  const cl = clients.find((c) => c.id === hit.client_id);
  if (hit.status === "active" && dayDiff(hit.end_date) < 0 && d <= todayISO()) {
    return { cls: "st-overdue", title: "Просрочено — " + (cl?.name ?? ""), hit };
  }
  if (hit.status === "active") {
    return { cls: "st-active", title: "В аренде — " + (cl?.name ?? ""), hit };
  }
  return { cls: "st-booked", title: "Забронировано — " + (cl?.name ?? ""), hit };
}

/**
 * Экспорт видимого диапазона календаря в CSV (53-й проход, пункт 4 из
 * "что нужно доработать" — "распечатать/выгрузить видимый диапазон") — по
 * тому же образцу, что и exportRentalsCsv (rentals/csv.ts): toCsv() + BOM +
 * Blob + временная ссылка на скачивание. В отличие от Аренд, здесь нет
 * отдельного submodule-каталога csv.ts — вкладка Календаря не разнесена по
 * файлам, как Оборудование/Клиенты/Аренды, так что функция объявлена прямо
 * здесь. Строка на единицу оборудования, столбец на каждый видимый день —
 * содержимое ячейки то же title, что показывается во всплывающей подсказке
 * на самой ячейке (equipmentDayStatus().title — "Свободно"/"Забронировано —
 * Имя"/"В аренде — Имя"/"Просрочено — Имя"/"На обслуживании…").
 */
function exportCalendarCsv(list: Equipment[], daysList: string[], rentals: Rental[], clients: Client[]) {
  const header = ["Оборудование", "Код", ...daysList.map((d) => fmtDate(d))];
  const rows = list.map((e) => [
    e.name,
    e.code ?? "",
    ...daysList.map((d) => equipmentDayStatus(e, d, rentals, clients).title),
  ]);
  const csv = toCsv(header, rows);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Календарь ${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function isEquipmentFree(equipmentId: string, start: string, end: string, rentals: Rental[]): boolean {
  return !rentals.some((r) => {
    if (r.status !== "booked" && r.status !== "active") return false;
    if (!r.items.some((it) => it.equipment_id === equipmentId)) return false;
    return start <= r.end_date && r.start_date <= end;
  });
}

/** Число дней пересечения двух диапазонов дат (0, если не пересекаются) — 1:1 из демо. */
function overlapDays(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
  if (!(aStart <= bEnd && bStart <= aEnd)) return 0;
  const lo = aStart > bStart ? aStart : bStart;
  const hi = aEnd < bEnd ? aEnd : bEnd;
  return dayDiff(hi) - dayDiff(lo) + 1;
}

interface QuickBookTarget {
  equipmentId: string;
  startDate: string;
  endDate: string;
}

export function CalendarTab({
  businessId,
  search,
  focus,
  onOpenClient,
  onOpenEquipment,
}: {
  businessId: string;
  search: string;
  // Переход на конкретную дату из карточки/панели аренды (42-й проход, п.5
  // обзора — "переход из карточки аренды в Календарь на её даты"). Тот же
  // счётчиковый паттерн ({date, signal}), что и highlightEmployee в
  // Dashboard.tsx: signal растёт на каждый клик, поэтому повторный переход
  // на ТУ ЖЕ дату (например, вторая аренда в том же диапазоне) снова
  // срабатывает, а не игнорируется как "date не изменился".
  focus?: { date: string; signal: number } | null;
  // Карточка клиента/оборудования из RentalDetailPanel, открытой поверх
  // занятой ячейки (53-й проход) — тот же проп, что и у RentalsTab.tsx,
  // рендерится Dashboard.tsx отдельным слайдовером поверх текущей вкладки.
  onOpenClient: (clientId: string) => void;
  onOpenEquipment: (equipmentId: string) => void;
}) {
  const { equipment, clients, rentals, reloadRentals, reloadEquipment } = useData();
  const { notify } = useToast();
  const { confirm, dialog: confirmDialog } = useConfirm();

  const [calOffset, setCalOffset] = useState(0);
  const [calCategoryFilter, setCalCategoryFilter] = useState("all");
  const [calRange, setCalRange] = useState<number | "month">(14);
  const [calColStart, setCalColStart] = useState<string | null>(null);
  const [calColEnd, setCalColEnd] = useState<string | null>(null);

  // Порядок категорий (drag-and-drop) и свёрнутые категории (53-й проход —
  // раньше жили только в памяти компонента и сбрасывались при уходе со
  // вкладки; см. докстринг файла выше) — тот же usePersistedState, что и
  // сортировка/фильтры на других вкладках. Ключ включает businessId, чтобы
  // не "утекать" между разными бизнесами одного аккаунта.
  const [categoryOrder, setCategoryOrder] = usePersistedState<string[] | null>(`cal-cat-order:${businessId}`, null);
  const [collapsedCategories, setCollapsedCategories] = usePersistedState<string[]>(`cal-collapsed:${businessId}`, []);

  const [quickBook, setQuickBook] = useState<QuickBookTarget | null>(null);

  // Действия по аренде из RentalDetailPanel, открытой по клику на занятую
  // ячейку (53-й проход) — тот же набор состояний и та же схема, что и в
  // RentalsTab.tsx (renderCard → RentalDetailPanel → соответствующая
  // модалка), только источник открытия другой (ячейка календаря, а не
  // карточка в списке).
  const [openRentalId, setOpenRentalId] = useState<string | null>(null);
  const [editRental, setEditRental] = useState<Rental | null>(null);
  const [issueRental, setIssueRental] = useState<Rental | null>(null);
  const [returnRental, setReturnRental] = useState<Rental | null>(null);
  const [extendRental, setExtendRental] = useState<Rental | null>(null);
  const [cancelRental, setCancelRental] = useState<Rental | null>(null);
  const [paymentRental, setPaymentRental] = useState<Rental | null>(null);
  const [docModal, setDocModal] = useState<{ title: string; node: ReactNode } | null>(null);
  // "Повторить аренду" (onRepeat из RentalDetailPanel), "+ Новая аренда" в
  // тулбаре и "Забронировать" из сводки по выделенному диапазону столбцов —
  // одна и та же форма создания (CreateRentalModal), createDraft заполняет
  // её клиентом/позициями при повторе или датами при бронировании по
  // диапазону; при обычном "+" остаётся null (значения по умолчанию формы).
  const [showCreate, setShowCreate] = useState(false);
  const [createDraft, setCreateDraft] = useState<{
    clientId?: string;
    equipmentIds?: string[];
    startDate?: string;
    endDate?: string;
  } | null>(null);

  function openDoc(title: string, node: ReactNode) {
    setDocModal({ title, node });
  }

  const wrapRef = useRef<HTMLDivElement>(null);

  const calDragRef = useRef<{ eqId: string; anchorDate: string } | null>(null);
  const calDragMovedRef = useRef(false);
  const calSuppressNextClickRef = useRef(false);

  const calColDragRef = useRef<{ anchor: string; lastDate: string } | null>(null);
  const calColDragMovedRef = useRef(false);

  // Переход по focus (см. докстринг пропа выше) — просто переставляет
  // "сегодня" видимого диапазона (calOffset) на нужную дату; сам режим
  // (7/14/30 дней/месяц) и фильтр категории не трогаем — пользователь мог их
  // уже осмысленно настроить.
  useEffect(() => {
    if (!focus) return;
    setCalOffset(dayDiff(focus.date));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.signal]);

  const usableAll = useMemo(() => equipment.filter((e) => e.status !== "retired"), [equipment]);

  const categories = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    usableAll.forEach((e) => {
      if (!seen.has(e.category)) {
        seen.add(e.category);
        list.push(e.category);
      }
    });
    return list.sort((a, b) => a.localeCompare(b, "ru"));
  }, [usableAll]);

  // Число позиций на категорию (53-й проход, обзор — "на 'Оборудовании'
  // рядом с категорией в фильтре видно число позиций, здесь — нет") — тот же
  // счётчик, что и .cat-filter-count на "Оборудовании", передаётся сюда
  // через hint у Dropdown (components/Dropdown.tsx уже поддерживает его).
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    usableAll.forEach((e) => { counts[e.category] = (counts[e.category] ?? 0) + 1; });
    return counts;
  }, [usableAll]);

  // Фильтр по складу (53-й проход, обзор — "на 'Оборудовании' есть и
  // категория, и склад, здесь — только категория") — тот же принцип, что и
  // calCategoryFilter выше: одиночный выбор через общий Dropdown, а не
  // мультивыбор чекбоксами (в отличие от "Оборудования", где оба фильтра
  // можно комбинировать в любом сочетании сразу нескольких значений — для
  // Календаря, где и так уже есть категория, второй независимый мультивыбор
  // усложнил бы тулбар больше, чем оправдано).
  const [calWarehouseFilter, setCalWarehouseFilter] = useState("all");
  const warehouses = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    usableAll.forEach((e) => {
      if (e.warehouse && !seen.has(e.warehouse)) {
        seen.add(e.warehouse);
        list.push(e.warehouse);
      }
    });
    return list.sort((a, b) => a.localeCompare(b, "ru"));
  }, [usableAll]);
  const warehouseCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    usableAll.forEach((e) => { if (e.warehouse) counts[e.warehouse] = (counts[e.warehouse] ?? 0) + 1; });
    return counts;
  }, [usableAll]);

  const orderedCategories = useMemo(() => {
    if (!categoryOrder) return categories;
    const known = categoryOrder.filter((c) => categories.includes(c));
    const extra = categories.filter((c) => !known.includes(c)).sort((a, b) => a.localeCompare(b, "ru"));
    return known.concat(extra);
  }, [categories, categoryOrder]);

  function moveCategory(dragged: string, target: string) {
    if (!dragged || !target || dragged === target) return;
    const order = orderedCategories.slice();
    const from = order.indexOf(dragged);
    if (from === -1) return;
    order.splice(from, 1);
    const to = order.indexOf(target);
    if (to === -1) return;
    order.splice(to, 0, dragged);
    setCategoryOrder(order);
  }

  function toggleCollapsed(cat: string) {
    setCollapsedCategories((prev) => (prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]));
  }

  const anchor = isoAddDays(todayISO(), calOffset);
  const { start, DAYS } = useMemo(() => {
    if (calRange === "month") {
      const mDt = new Date(anchor + "T00:00:00");
      mDt.setDate(1);
      const s = ymd(mDt);
      const nextMonthFirst = new Date(mDt.getTime());
      nextMonthFirst.setMonth(nextMonthFirst.getMonth() + 1);
      const days = Math.round((nextMonthFirst.getTime() - mDt.getTime()) / 86400000);
      return { start: s, DAYS: days };
    }
    return { start: anchor, DAYS: calRange };
  }, [anchor, calRange]);

  const days = useMemo(() => {
    const arr: string[] = [];
    for (let i = 0; i < DAYS; i++) arr.push(isoAddDays(start, i));
    return arr;
  }, [start, DAYS]);

  const grouping = calCategoryFilter === "all";
  const catRank = useMemo(() => {
    const rank: Record<string, number> = {};
    orderedCategories.forEach((c, i) => { rank[c] = i; });
    return rank;
  }, [orderedCategories]);

  const q = search.trim().toLowerCase();
  const usable = useMemo(() => {
    return usableAll
      .filter((e) => {
        if (calCategoryFilter !== "all" && e.category !== calCategoryFilter) return false;
        if (calWarehouseFilter !== "all" && e.warehouse !== calWarehouseFilter) return false;
        if (q && !(e.name + " " + e.category + " " + (e.code ?? "")).toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => {
        if (grouping && a.category !== b.category) {
          const ra = catRank[a.category] ?? 999;
          const rb = catRank[b.category] ?? 999;
          return ra - rb;
        }
        return a.name.localeCompare(b.name, "ru");
      });
  }, [usableAll, calCategoryFilter, calWarehouseFilter, q, grouping, catRank]);

  function colSel(d: string): boolean {
    if (!calColStart || !calColEnd) return false;
    const lo = calColStart < calColEnd ? calColStart : calColEnd;
    const hi = calColStart < calColEnd ? calColEnd : calColStart;
    return d >= lo && d <= hi;
  }

  const colIndicator = useMemo(() => {
    if (!calColStart || !calColEnd) return null;
    const selLo = calColStart < calColEnd ? calColStart : calColEnd;
    const selHi = calColStart < calColEnd ? calColEnd : calColStart;
    const selDays = dayDiff(selHi) - dayDiff(selLo) + 1;
    const selLabel = selLo === selHi ? fmtDate(selLo) : fmtDate(selLo) + " – " + fmtDate(selHi);
    const selDaysList: string[] = [];
    for (let i = 0; i < selDays; i++) selDaysList.push(isoAddDays(selLo, i));
    let busyCount = 0;
    let freeCount = 0;
    let maintCount = 0;
    usable.forEach((e) => {
      const dayClasses = selDaysList.map((d) => equipmentDayStatus(e, d, rentals, clients).cls);
      const allMaint = dayClasses.every((c) => c === "st-maintenance");
      if (allMaint) { maintCount++; return; }
      const isBusy = dayClasses.some((c) => c !== "st-available");
      if (isBusy) busyCount++; else freeCount++;
    });
    let revenue = 0;
    const usableIds = new Set(usable.map((e) => e.id));
    rentals.forEach((r) => {
      if (r.status === "cancelled" || r.status === "returned") return;
      const ov = overlapDays(r.start_date, r.end_date, selLo, selHi);
      if (ov <= 0) return;
      r.items.forEach((it) => {
        if (!usableIds.has(it.equipment_id)) return;
        const eq = equipment.find((e) => e.id === it.equipment_id);
        if (eq) revenue += itemCostForDays(eq, ov);
      });
    });
    const bits = [`занято ${busyCount}/${busyCount + freeCount}`];
    if (maintCount) bits.push(`обсл. ${maintCount}`);
    if (revenue > 0) bits.push(`≈ ${money(revenue)}`);
    return { selLo, selHi, selDays, selLabel, summary: bits.join(" · ") };
  }, [calColStart, calColEnd, usable, rentals, clients, equipment]);

  function calHighlightRange(eqId: string, fromDate: string, toDate: string) {
    calClearHighlight();
    const lo = fromDate < toDate ? fromDate : toDate;
    const hi = fromDate < toDate ? toDate : fromDate;
    wrapRef.current?.querySelectorAll(`.cal-cell[data-eqid="${eqId}"][data-bookable="1"]`).forEach((cell) => {
      const d = cell.getAttribute("data-date");
      if (d && d >= lo && d <= hi) cell.classList.add("drag-highlight");
    });
  }
  function calClearHighlight() {
    wrapRef.current?.querySelectorAll(".cal-cell.drag-highlight").forEach((cell) => cell.classList.remove("drag-highlight"));
  }
  function calColPreview(fromDate: string, toDate: string) {
    calColClearPreview();
    const lo = fromDate < toDate ? fromDate : toDate;
    const hi = fromDate < toDate ? toDate : fromDate;
    wrapRef.current?.querySelectorAll(".cal-cell[data-date]").forEach((cell) => {
      const d = cell.getAttribute("data-date");
      if (d && d >= lo && d <= hi) cell.classList.add("col-selected");
    });
  }
  function calColClearPreview() {
    wrapRef.current?.querySelectorAll(".cal-cell.col-selected").forEach((cell) => cell.classList.remove("col-selected"));
  }

  // Протяжка мышью — 1:1 логика демо (calDrag/calHighlightRange +
  // calColDrag/calColPreview), реализованная через document-level слушатели,
  // как и в оригинале, но в пределах React-эффекта с корректной отпиской.
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      const target = e.target as HTMLElement;
      const cell = target.closest?.('.cal-cell[data-bookable="1"]') as HTMLElement | null;
      if (cell) {
        const eqId = cell.getAttribute("data-eqid");
        const anchorDate = cell.getAttribute("data-date");
        if (eqId && anchorDate) {
          calDragRef.current = { eqId, anchorDate };
          calDragMovedRef.current = false;
          calHighlightRange(eqId, anchorDate, anchorDate);
        }
        return;
      }
      const headCell = target.closest?.('.cal-row.head .cal-cell[data-action="cal-col-select"]') as HTMLElement | null;
      if (headCell) {
        const d = headCell.getAttribute("data-date");
        if (d) {
          calColDragRef.current = { anchor: d, lastDate: d };
          calColDragMovedRef.current = false;
          calColPreview(d, d);
        }
      }
    }
    function onMouseOver(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (calDragRef.current) {
        const cell = target.closest?.(`.cal-cell[data-eqid="${calDragRef.current.eqId}"]`) as HTMLElement | null;
        const d = cell?.getAttribute("data-date");
        if (d) {
          if (d !== calDragRef.current.anchorDate) calDragMovedRef.current = true;
          calHighlightRange(calDragRef.current.eqId, calDragRef.current.anchorDate, d);
        }
      }
      if (calColDragRef.current) {
        const cell = target.closest?.('.cal-row.head .cal-cell[data-date]') as HTMLElement | null;
        const d = cell?.getAttribute("data-date");
        if (d) {
          if (d !== calColDragRef.current.anchor) calColDragMovedRef.current = true;
          calColDragRef.current.lastDate = d;
          calColPreview(calColDragRef.current.anchor, d);
        }
      }
    }
    function onMouseUp(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (calDragRef.current) {
        const { eqId, anchorDate } = calDragRef.current;
        const endCell = target.closest?.(`.cal-cell[data-eqid="${eqId}"]`) as HTMLElement | null;
        const endD = endCell?.getAttribute("data-date") || anchorDate;
        const moved = calDragMovedRef.current;
        calDragRef.current = null;
        calClearHighlight();
        calSuppressNextClickRef.current = moved;
        if (moved) {
          const lo = anchorDate < endD ? anchorDate : endD;
          const hi = anchorDate < endD ? endD : anchorDate;
          const eq = equipment.find((x) => x.id === eqId);
          if (eq && eq.status !== "retired" && !isUnderMaintenanceOn(eq, lo) && isEquipmentFree(eqId, lo, hi, rentals)) {
            setQuickBook({ equipmentId: eqId, startDate: lo, endDate: hi });
          } else {
            notify("В выбранном диапазоне есть занятые дни — выберите другой период");
          }
        }
      }
      if (calColDragRef.current) {
        const anchorD = calColDragRef.current.anchor;
        const endCell = target.closest?.('.cal-row.head .cal-cell[data-date]') as HTMLElement | null;
        const endD = endCell?.getAttribute("data-date") || calColDragRef.current.lastDate;
        const moved = calColDragMovedRef.current;
        const wasSingleSelected = calColStart === anchorD && calColEnd === anchorD;
        calColDragRef.current = null;
        calColClearPreview();
        if (moved) {
          setCalColStart(anchorD < endD ? anchorD : endD);
          setCalColEnd(anchorD < endD ? endD : anchorD);
        } else if (wasSingleSelected) {
          setCalColStart(null);
          setCalColEnd(null);
        } else {
          setCalColStart(anchorD);
          setCalColEnd(anchorD);
        }
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mouseover", onMouseOver);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mouseover", onMouseOver);
      document.removeEventListener("mouseup", onMouseUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equipment, rentals, calColStart, calColEnd]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (calDragRef.current) { calDragRef.current = null; calClearHighlight(); }
      if (calColDragRef.current) { calColDragRef.current = null; calColClearPreview(); }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function handleCellClick(eqId: string, date: string) {
    if (calSuppressNextClickRef.current) {
      calSuppressNextClickRef.current = false;
      return;
    }
    setQuickBook({ equipmentId: eqId, startDate: date, endDate: date });
  }

  function navPrev() {
    if (calRange === "month") {
      const anchorDt = new Date(isoAddDays(todayISO(), calOffset) + "T00:00:00");
      anchorDt.setDate(1);
      anchorDt.setMonth(anchorDt.getMonth() - 1);
      setCalOffset(dayDiff(ymd(anchorDt)));
    } else {
      setCalOffset((v) => v - calRange);
    }
  }
  function navNext() {
    if (calRange === "month") {
      const anchorDt = new Date(isoAddDays(todayISO(), calOffset) + "T00:00:00");
      anchorDt.setDate(1);
      anchorDt.setMonth(anchorDt.getMonth() + 1);
      setCalOffset(dayDiff(ymd(anchorDt)));
    } else {
      setCalOffset((v) => v + calRange);
    }
  }
  function navToday() {
    setCalOffset(0);
  }

  const collapseAllAvailable = grouping && orderedCategories.length > 1;
  const allCollapsed = collapseAllAvailable && orderedCategories.every((c) => collapsedCategories.includes(c));

  async function afterBooked() {
    setQuickBook(null);
    await Promise.all([reloadRentals(), reloadEquipment()]);
  }

  return (
    <div>
      {/* .tab-toolbar-grid (53-й проход) — тот же общий тулбар-каркас, что и
          на "Оборудовании"/"Клиентах"/"Арендах": фильтры слева, кнопки
          действий прибиты к правому верхнему углу независимо от того, во
          сколько строк перенеслись фильтры (см. styles.css). */}
      <div className="tab-toolbar-grid">
        {/* Левый кластер: две строки (54-й проход, по итогам обзора верхней
            части — "не приведена к общему виду по образцу Аренды/Клиенты/
            Оборудование"). Раньше все шесть разнородных элементов (категория,
            склад, диапазон дней, навигация по датам, переход на дату,
            индикатор выделения) жили в одном ряду с общим flexWrap — та же
            "рябая" регрессия, которую на других вкладках чинили ещё в 44-45-м
            проходах (см. комментарии в EquipmentTab.tsx/ClientsTab.tsx/
            RentalsTab.tsx). Порядок строк (55-й проход, ещё одна правка по
            месту — "не приведена к общему виду") — не "что показываем" перед
            "когда смотрим", как было сначала, а по роли элемента, как на
            Клиентах/Арендах: строка 1 — сегментированные/самые часто
            используемые контролы (там диапазон дат листают постоянно,
            категорию/склад выставляют раз и надолго), строка 2 — дропдауны
            точечных фильтров (там же — "Фильтры"/сортировка). */}
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <div className="segmented">
              {CAL_RANGE_OPTIONS.map((opt) => (
                <button
                  key={String(opt)}
                  type="button"
                  className={calRange === opt ? "active" : ""}
                  onClick={() => setCalRange(opt)}
                >
                  {opt === "month" ? "Календарный месяц" : `${opt} дн.`}
                </button>
              ))}
            </div>
            {/* "Назад"/"Вперёд" сокращены до одних стрелок (55-й проход) —
                тот же приём, что и icon-only-кнопки в проекте (например,
                "Рискованные клиенты" на "Арендах" — .btn-icon-only + title/
                aria-label вместо подписи): смысл кнопки не в тексте, а в
                стрелке, а после переноса в первую строку тут стало теснее
                (сегмент диапазона + сегмент навигации + переход на дату +
                иногда ещё пилюля выделения). Символ стрелки — тот же, что и
                был, просто без слова рядом; title меняется на "Предыдущий/
                следующий месяц" в режиме "Календарный месяц", чтобы не
                путать со сдвигом на день. */}
            <div className="segmented">
              <button
                type="button"
                onClick={navPrev}
                title={calRange === "month" ? "Предыдущий месяц" : "Назад"}
                aria-label={calRange === "month" ? "Предыдущий месяц" : "Назад"}
              >
                ←
              </button>
              <button type="button" onClick={navToday}>Сегодня</button>
              <button
                type="button"
                onClick={navNext}
                title={calRange === "month" ? "Следующий месяц" : "Вперёд"}
                aria-label={calRange === "month" ? "Следующий месяц" : "Вперёд"}
              >
                →
              </button>
            </div>
            {/* Раньше "Сегодня" стояла и в сегменте навигации, и ещё раз рядом
                с полем даты (53-й проход, обзор — "раздвоенная кнопка
                'Сегодня'") — вторая убрана, остался только сам переход к
                произвольной дате. */}
            <div className="cal-jump">
              <input
                type="date"
                value={start}
                title="Перейти к дате"
                onChange={(e) => {
                  if (!e.target.value) return;
                  setCalOffset(dayDiff(e.target.value));
                }}
              />
            </div>
            {colIndicator && (
              <span className="cal-col-indicator">
                {colIndicator.selLabel} · {colIndicator.selDays} {pluralRu(colIndicator.selDays, "день", "дня", "дней")} · {colIndicator.summary}
                {/* "Забронировать" по выделенному диапазону (53-й проход,
                    пункт 2 из "что нужно доработать" — "выделение диапазона
                    ничего не даёт, кроме сводки") — открывает ту же форму
                    создания аренды, с предзаполненными датами диапазона;
                    список оборудования пользователь выбирает уже в форме. */}
                <button
                  type="button"
                  className="cal-col-book"
                  onClick={() => {
                    setCreateDraft({ startDate: colIndicator.selLo, endDate: colIndicator.selHi });
                    setShowCreate(true);
                  }}
                >
                  Забронировать
                </button>
                <button className="cal-col-close" type="button" title="Снять выделение" onClick={() => { setCalColStart(null); setCalColEnd(null); }}>
                  <IconClose />
                </button>
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {/* Категории — выпадающий список вместо плоского ряда кнопок на
                каждую категорию (53-й проход): ряд кнопок неограниченно рос
                вширь и переносился на вторую строку при каждой новой
                категории. Тот же общий одиночный Dropdown, что и везде в
                приложении (components/Dropdown.tsx — сам построен на классах
                .cat-filter*, которыми на "Оборудовании" реализован мультивыбор
                категорий/складов), а не отдельная копия того же idiom. */}
            <Dropdown
              value={calCategoryFilter}
              onChange={setCalCategoryFilter}
              placeholder="Все категории"
              options={[
                { value: "all", label: "Все категории", hint: usableAll.length },
                ...orderedCategories.map((cat) => ({ value: cat, label: cat, hint: categoryCounts[cat] })),
              ]}
            />
            {/* Фильтр по складу (53-й проход, пункт 3 из "что нужно доработать")
                — показывается только когда склады вообще заведены, тот же
                принцип, что и на "Оборудовании". Обёрнут в общий родительский
                ряд с категорией БЕЗ собственного flexWrap — те же две строки,
                тот же приём, что и "категория+склад"/"просрочка+фильтры" на
                других вкладках: переносятся вниз только вдвоём, если вообще
                переносятся, а не порознь. */}
            {warehouses.length > 0 && (
              <Dropdown
                value={calWarehouseFilter}
                onChange={setCalWarehouseFilter}
                placeholder="Все склады"
                options={[
                  { value: "all", label: "Все склады", hint: usableAll.length },
                  ...warehouses.map((w) => ({ value: w, label: w, hint: warehouseCounts[w] })),
                ]}
              />
            )}
          </div>
        </div>
        {/* Колонка кнопок в .tab-toolbar-grid (53-й проход) — тот же приём,
            что и на остальных вкладках: редкое действие ("Свернуть/развернуть
            все") спрятано за "Ещё", а на виду — только основной CTA. Раньше
            у "Календаря" не было своей кнопки создания вообще (бронь — только
            кликом/протяжкой по ячейке, неочевидно при первом знакомстве) —
            теперь есть "+ Новая аренда" на привычном для остальных вкладок
            месте, открывает ту же форму (CreateRentalModal), что и на
            "Арендах"; клик/протяжка по ячейке остаётся быстрым способом для
            тех, кто уже о нём знает — оба пути не исключают друг друга. */}
        <div style={{ display: "flex", gap: "8px" }}>
          {/* 53-й проход, пункт 4 из "что нужно доработать" — экспорт
              видимого диапазона в CSV (на "Оборудовании"/"Клиентах"/"Арендах"
              такой экспорт уже есть, у Календаря не было вообще). Раньше меню
              "Ещё" показывалось только когда есть что сворачивать/
              разворачивать (>1 категории) — теперь показывается всегда, т.к.
              экспорт полезен независимо от группировки по категориям. */}
          <MoreActionsMenu
            actions={[
              ...(collapseAllAvailable
                ? [
                    {
                      key: "collapse-all",
                      label: allCollapsed ? "Развернуть все" : "Свернуть все",
                      onClick: () => setCollapsedCategories(allCollapsed ? [] : orderedCategories),
                    },
                  ]
                : []),
              {
                key: "export-csv",
                label: "Экспорт в CSV",
                disabled: usable.length === 0,
                onClick: () => exportCalendarCsv(usable, days, rentals, clients),
              },
            ]}
          />
          <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
            + Новая аренда
          </button>
        </div>
      </div>

      {usable.length === 0 ? (
        <div className="panel">
          <div className="panel-body">
            <div className="empty-note">Ничего не найдено{search ? ` по запросу «${search}»` : ""}.</div>
          </div>
        </div>
      ) : (
        <>
          <div className="cal-wrap" ref={wrapRef}>
            <div className="cal-grid">
              <div className="cal-row head" style={{ ["--days" as string]: DAYS }}>
                <div className="cal-name-cell">Оборудование</div>
                {days.map((d) => {
                  const dt = new Date(d + "T00:00:00");
                  const weekend = dt.getDay() === 0 || dt.getDay() === 6;
                  const isToday = d === todayISO();
                  return (
                    <div
                      key={d}
                      className={
                        "cal-cell" + (weekend ? " weekend" : "") + (isToday ? " today" : "") + (colSel(d) ? " col-selected" : "")
                      }
                      data-action="cal-col-select"
                      data-date={d}
                      title="Нажмите, чтобы выделить день, или протяните мышью, чтобы выделить диапазон"
                    >
                      {dt.toLocaleDateString("ru-RU", { day: "numeric", month: "numeric" })}
                    </div>
                  );
                })}
              </div>

              {(() => {
                let lastCategory: string | null = null;
                const rows: React.ReactNode[] = [];
                usable.forEach((e) => {
                  if (grouping && e.category !== lastCategory) {
                    lastCategory = e.category;
                    const cat = lastCategory;
                    const count = usable.filter((x) => x.category === cat).length;
                    const collapsed = collapsedCategories.includes(cat);
                    rows.push(
                      <div
                        key={"group-" + cat}
                        className={"cal-group-row" + (collapsed ? " collapsed" : "")}
                        draggable
                        title="Нажмите, чтобы свернуть/развернуть категорию, или перетащите за неё, чтобы изменить порядок"
                        onClick={() => toggleCollapsed(cat)}
                        onDragStart={(ev) => {
                          ev.dataTransfer.setData("text/plain", cat);
                          ev.dataTransfer.effectAllowed = "move";
                          (ev.currentTarget as HTMLElement).classList.add("dragging");
                        }}
                        onDragEnd={(ev) => (ev.currentTarget as HTMLElement).classList.remove("dragging")}
                        onDragOver={(ev) => {
                          ev.preventDefault();
                          ev.dataTransfer.dropEffect = "move";
                          (ev.currentTarget as HTMLElement).classList.add("drag-over");
                        }}
                        onDragLeave={(ev) => (ev.currentTarget as HTMLElement).classList.remove("drag-over")}
                        onDrop={(ev) => {
                          ev.preventDefault();
                          (ev.currentTarget as HTMLElement).classList.remove("drag-over");
                          const dragged = ev.dataTransfer.getData("text/plain");
                          moveCategory(dragged, cat);
                        }}
                      >
                        <span className="cal-group-sticky">
                          <span className="cal-group-chevron"><IconChevronDown /></span>
                          <span className="cal-group-drag"><IconGrip /></span>
                          {cat}
                          <span className="cal-group-count">{count} шт.</span>
                        </span>
                      </div>
                    );
                  }
                  if (grouping && collapsedCategories.includes(e.category)) return;

                  rows.push(
                    <div className="cal-row" key={e.id} style={{ ["--days" as string]: DAYS }}>
                      <div
                        className="cal-name-cell clickable"
                        // Демо кликом по названию открывает слайд-панель деталей
                        // оборудования. В проде такой общей деталь-панели для
                        // оборудования пока нигде нет (EquipmentTab.tsx — это
                        // просто таблица, без карточки/слайдовера), поэтому
                        // здесь — функциональный аналог: клик фильтрует
                        // календарь по категории этой позиции (сопоставимо с
                        // filter-by-category в демо).
                        title={
                          `Показать только категорию «${e.category}»` +
                          (e.warehouse ? `, склад: ${e.warehouse}` : "")
                        }
                        onClick={() => setCalCategoryFilter(e.category)}
                      >
                        {/* Код единицы (53-й проход, обзор — "несколько единиц с
                            одинаковым названием неотличимы друг от друга в
                            календаре"): тот же приём, что и "№ …" в
                            EquipmentPicklist.tsx — единственная деталь, которая
                            выручает, если в одной категории лежат N одинаковых
                            по названию единиц (см. cat-filter выше). Склад в
                            эту же строку не влезает по ширине столбца — вынесен
                            в title (см. выше). Название и код обёрнуты одним
                            flex-row span'ом (а не два отдельных ребёнка column-
                            flex ячейки) — иначе .cal-name-cell (flex-direction:
                            column) кладёт каждого прямого потомка на свою
                            строку, и код уезжал бы на отдельную строку под
                            названием вместо одной строки с ним. */}
                        <span style={{ display: "flex", alignItems: "baseline", gap: "6px", minWidth: 0 }}>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: "1 1 auto" }}>
                            {e.name}
                          </span>
                          {e.code && <span className="cal-code" style={{ flex: "none" }}>№{e.code}</span>}
                        </span>
                        <span className="cat">
                          {e.period_days && e.period_price
                            ? `${money(e.period_price)}/${e.period_days}дн${
                                e.period_price_after
                                  ? ` → ${money(e.period_price_after)}/${
                                      (e.after_period_days || 1) === 1 ? "сутки" : `${e.after_period_days} дн`
                                    }`
                                  : ""
                              }`
                            : `${money(e.daily_rate)}/сутки`}
                        </span>
                      </div>
                      {days.map((d) => {
                        const info = equipmentDayStatus(e, d, rentals, clients);
                        const { cls, title, hit } = info;
                        const isBar = cls !== "st-available";
                        let leftContinues = false;
                        let rightContinues = false;
                        if (isBar) {
                          const prevInfo = equipmentDayStatus(e, isoAddDays(d, -1), rentals, clients);
                          const nextInfo = equipmentDayStatus(e, isoAddDays(d, 1), rentals, clients);
                          if (cls === "st-maintenance") {
                            leftContinues = prevInfo.cls === "st-maintenance";
                            rightContinues = nextInfo.cls === "st-maintenance";
                          } else {
                            leftContinues = !!(prevInfo.hit && hit && prevInfo.hit.id === hit.id);
                            rightContinues = !!(nextInfo.hit && hit && nextInfo.hit.id === hit.id);
                          }
                        }
                        const isToday = d === todayISO();
                        const dt = new Date(d + "T00:00:00");
                        const weekend = dt.getDay() === 0 || dt.getDay() === 6;
                        const hitClient = hit ? clients.find((c) => c.id === hit.client_id) : null;
                        // Занятая ячейка теперь тоже кликабельна (53-й проход,
                        // обзор — "по занятой ячейке ничего не сделать, только
                        // тултип"): открывает RentalDetailPanel той же аренды,
                        // тем же принципом, что и клик по карточке в списке
                        // "Аренды" (RentalsTab.tsx → renderCard). Раньше только
                        // свободные ячейки были кликабельны (бронирование) —
                        // курсор-указатель стоял у ВСЕХ ячеек не глядя на это
                        // (см. .cal-cell.clickable ниже), так что открытие по
                        // клику на занятой не меняет ожидание, а исправляет его.
                        const titleFull =
                          title +
                          (!hit && !isUnderMaintenanceOn(e, d) ? " — нажмите или протяните мышью, чтобы забронировать" : "") +
                          (hit ? " — нажмите, чтобы открыть карточку аренды" : "") +
                          ", " + fmtDate(d);
                        const bookable = !hit && !isUnderMaintenanceOn(e, d);
                        return (
                          <div
                            key={d}
                            className={
                              "cal-cell clickable" +
                              (isToday ? " today" : "") +
                              (weekend ? " weekend" : "") +
                              (colSel(d) ? " col-selected" : "")
                            }
                            title={titleFull}
                            data-eqid={e.id}
                            data-date={d}
                            data-bookable={bookable ? "1" : undefined}
                            onClick={bookable ? () => handleCellClick(e.id, d) : hit ? () => setOpenRentalId(hit.id) : undefined}
                          >
                            <div className={"cal-fill " + cls + (leftContinues ? " cont-left" : "") + (rightContinues ? " cont-right" : "")}>
                              {/* Просрочка отличается от "В аренде" не только цветом
                                  (53-й проход, обзор — оба статуса были различимы
                                  ТОЛЬКО оттенком) — значок восклицания перед
                                  инициалами добавляет некоторый небо-цветовой
                                  сигнал самому важному для бизнеса статусу, тем
                                  же принципом, что "Обслуживание" уже отличается
                                  штриховкой, а "Забронировано" — пунктиром. */}
                              {hitClient && (
                                <span className={"cal-fill-label" + (cls === "st-booked" ? " dark" : "")}>
                                  {cls === "st-overdue" && <IconAlert />}
                                  {clientInitials(hitClient.name)}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                });
                return rows;
              })()}
            </div>
          </div>
          <div className="cal-legend">
            <span className="item"><span className="sw" style={{ background: "transparent", border: "1px solid var(--border)" }} />Свободно</span>
            <span className="item"><span className="sw" style={{ background: "var(--info-soft)", border: "1px dashed var(--info)" }} />Забронировано</span>
            <span className="item"><span className="sw" style={{ background: "var(--accent)" }} />В аренде</span>
            <span className="item"><span className="sw" style={{ background: "var(--critical)" }} />Просрочено</span>
            <span className="item"><span className="sw" style={{ background: "repeating-linear-gradient(45deg,var(--warning-soft),var(--warning-soft) 3px,var(--surface-3) 3px,var(--surface-3) 6px)" }} />Обслуживание</span>
            <span className="item"><span className="sw" style={{ background: "transparent", border: "2px solid var(--today)" }} />Сегодня</span>
          </div>
        </>
      )}

      {quickBook && (
        <QuickBookModal
          businessId={businessId}
          equipmentId={quickBook.equipmentId}
          equipment={equipment}
          clients={clients}
          startDate={quickBook.startDate}
          endDate={quickBook.endDate}
          onClose={() => setQuickBook(null)}
          onBooked={afterBooked}
        />
      )}

      {/* Полноценная форма "Новая аренда" (53-й проход) — кнопка "+ Новая
          аренда" в тулбаре, "Повторить аренду" из RentalDetailPanel и
          "Забронировать" из сводки по выделенному диапазону столбцов (все
          три — ниже по файлу) используют одну и ту же форму, тем же
          принципом, что и в RentalsTab.tsx: createDraft заполняет её
          клиентом/позициями/датами, при обычном "+" остаётся null.
          QuickBookModal (клик/протяжка по одной ячейке) — сознательно
          отдельная облегчённая форма, см. её докстринг ниже, а не замена
          этой. */}
      {showCreate && (
        <CreateRentalModal
          businessId={businessId}
          clients={clients}
          equipment={equipment}
          rentals={rentals}
          initialClientId={createDraft?.clientId}
          initialEquipmentIds={createDraft?.equipmentIds}
          initialStartDate={createDraft?.startDate}
          initialEndDate={createDraft?.endDate}
          onClose={() => {
            setShowCreate(false);
            setCreateDraft(null);
          }}
          onCreated={async () => {
            await Promise.all([reloadRentals(), reloadEquipment()]);
          }}
        />
      )}

      {editRental && (
        <EditRentalModal
          businessId={businessId}
          rental={editRental}
          client={clients.find((c) => c.id === editRental.client_id)}
          equipment={equipment}
          rentals={rentals}
          onClose={() => setEditRental(null)}
          onSaved={async () => {
            await Promise.all([reloadRentals(), reloadEquipment()]);
          }}
        />
      )}

      {issueRental && (
        <IssueRentalModal
          businessId={businessId}
          rental={issueRental}
          client={clients.find((c) => c.id === issueRental.client_id)}
          equipment={equipment}
          onClose={() => setIssueRental(null)}
          onIssued={async (updated) => {
            await Promise.all([reloadRentals(), reloadEquipment()]);
            const c = clients.find((cl) => cl.id === updated.client_id);
            openDoc("Акт приёма-передачи", buildIssueDoc(updated, c, equipment));
          }}
        />
      )}

      {returnRental && (
        <ReturnRentalModal
          businessId={businessId}
          rental={returnRental}
          client={clients.find((c) => c.id === returnRental.client_id)}
          onClose={() => setReturnRental(null)}
          onReturned={async (updated) => {
            await Promise.all([reloadRentals(), reloadEquipment()]);
            const c = clients.find((cl) => cl.id === updated.client_id);
            openDoc("Акт возврата", buildReturnDoc(updated, c, equipment));
            // Предложить записать оплату остатка — тот же принцип, что и в
            // RentalsTab.tsx (49-й проход).
            if (isUnpaid(updated)) {
              const remaining = updated.total - updated.paid_amount;
              if (
                await confirm(`Остался долг ${money(remaining)} — записать оплату?`, {
                  confirmLabel: "Записать оплату",
                })
              ) {
                setPaymentRental(updated);
              }
            }
          }}
        />
      )}

      {paymentRental && (
        <PaymentModal
          businessId={businessId}
          rental={paymentRental}
          onClose={() => setPaymentRental(null)}
          onPaid={async () => {
            await reloadRentals();
          }}
        />
      )}

      {extendRental && (
        <ExtendRentalModal
          businessId={businessId}
          rental={extendRental}
          client={clients.find((c) => c.id === extendRental.client_id)}
          rentals={rentals}
          onClose={() => setExtendRental(null)}
          onSaved={async () => {
            await reloadRentals();
          }}
        />
      )}

      {cancelRental && (
        <CancelRentalModal
          businessId={businessId}
          rental={cancelRental}
          client={clients.find((c) => c.id === cancelRental.client_id)}
          onClose={() => setCancelRental(null)}
          onCancelled={async () => {
            await Promise.all([reloadRentals(), reloadEquipment()]);
          }}
        />
      )}

      <DocModal title={docModal?.title ?? ""} open={!!docModal} onClose={() => setDocModal(null)}>
        {docModal?.node}
      </DocModal>

      {/* Слайдовер деталей аренды по клику на занятую ячейку (53-й проход) —
          тот же приём, что и в RentalsTab.tsx: затемнённый фон + панель
          поверх текущей вкладки, закрывается кликом по фону или крестиком. */}
      {openRentalId && <div className="slideover-backdrop" onClick={() => setOpenRentalId(null)} />}
      {openRentalId && (
        <RentalDetailPanel
          businessId={businessId}
          rentalId={openRentalId}
          onClose={() => setOpenRentalId(null)}
          onOpenClient={(clientId) => onOpenClient(clientId)}
          onOpenEquipment={(equipmentId) => onOpenEquipment(equipmentId)}
          onExtend={(rentalId) => {
            const r = rentals.find((x) => x.id === rentalId);
            if (r) setExtendRental(r);
          }}
          onIssue={(rentalId) => {
            const r = rentals.find((x) => x.id === rentalId);
            if (r) setIssueRental(r);
          }}
          onReturn={(rentalId) => {
            const r = rentals.find((x) => x.id === rentalId);
            if (r) setReturnRental(r);
          }}
          onEdit={(rentalId) => {
            const r = rentals.find((x) => x.id === rentalId);
            if (r) setEditRental(r);
          }}
          onCancel={(rentalId) => {
            const r = rentals.find((x) => x.id === rentalId);
            if (r) setCancelRental(r);
          }}
          onRepeat={(clientId, equipmentIds) => {
            setCreateDraft({ clientId, equipmentIds });
            setShowCreate(true);
          }}
          // Переход "в календарь" здесь не уводит с вкладки (мы уже на ней) —
          // просто переставляет видимый диапазон на дату аренды и закрывает
          // панель, тем же принципом, что и focus-проп компонента выше.
          onOpenCalendar={(date) => {
            setOpenRentalId(null);
            setCalOffset(dayDiff(date));
          }}
        />
      )}

      {confirmDialog}
    </div>
  );
}

/**
 * Форма быстрой брони по клику/протяжке ячейки календаря.
 *
 * Демо в этом месте открывает общую модалку "Новая аренда" (addRentalForm)
 * с чекбокс-списком ВСЕГО оборудования и выбором клиента. С 52-го прохода
 * (разноска RentalsTab.tsx по модулям) полноценная форма создания аренды —
 * уже отдельный переиспользуемый компонент (CreateRentalModal, используется
 * здесь же кнопкой "+ Новая аренда" и "Повторить аренду" — см. ниже по
 * файлу), но для клика/протяжки по конкретной ячейке она остаётся избыточной
 * — оборудование здесь и так уже выбрано кликом, открывать полный чекбокс-
 * список всего каталога поверх уже сделанного выбора не нужно. Поэтому для
 * этого конкретного сценария — облегчённая версия: только выбор клиента и
 * дат (предзаполненных из клика/протяжки), одно оборудование. Сознательный
 * компромисс по UX, не техническое ограничение.
 */
function QuickBookModal({
  businessId,
  equipmentId,
  equipment,
  clients,
  startDate,
  endDate,
  onClose,
  onBooked,
}: {
  businessId: string;
  equipmentId: string;
  equipment: Equipment[];
  clients: Client[];
  startDate: string;
  endDate: string;
  onClose: () => void;
  onBooked: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const eq = equipment.find((e) => e.id === equipmentId);
  const [clientId, setClientId] = useState("");
  const [start, setStart] = useState(startDate);
  const [end, setEnd] = useState(endDate);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const days = spanDays(start, end);
  const cost = eq ? itemCostForDays(eq, days) : 0;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!clientId) { setError("Выберите клиента"); return; }
    if (end < start) { setError("Дата окончания раньше начала"); return; }
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/businesses/${businessId}/rentals`, {
        client_id: clientId,
        equipment_ids: [equipmentId],
        start_date: start,
        end_date: end,
      });
      onBooked();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось создать аренду");
      setSubmitting(false);
    }
  }

  return (
    <dialog id="modal" ref={ref} onClose={onClose} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form onSubmit={handleSubmit}>
        <div className="modal-head">
          <h3>Новая аренда — {eq?.name ?? "оборудование"}</h3>
          <button type="button" className="icon-btn" onClick={onClose}><IconClose /></button>
        </div>
        <div className="modal-body">
          {clients.length === 0 ? (
            <div className="empty-note">Сначала добавьте клиента на вкладке «Клиенты».</div>
          ) : (
            <div className="field">
              <label>Клиент</label>
              <Dropdown
                value={clientId}
                onChange={setClientId}
                placeholder="Выберите клиента"
                options={clients.map((c) => ({ value: c.id, label: c.name + (c.phone ? ` · ${c.phone}` : "") }))}
              />
              {/* 26-й проход — тот же баннер, что и в CreateRentalModal
                  (RentalsTab.tsx): предупреждение о чёрном списке должно
                  всплывать везде, где можно создать новую аренду, а не
                  только в одном из двух мест. */}
              {clients.find((c) => c.id === clientId)?.rating === "blacklist" && (
                <div className="form-error" style={{ marginTop: "6px" }}>
                  Клиент в чёрном списке
                  {clients.find((c) => c.id === clientId)?.blacklist_reason
                    ? `: ${clients.find((c) => c.id === clientId)?.blacklist_reason}`
                    : ""}
                </div>
              )}
            </div>
          )}
          <div className="field-row">
            <div className="field">
              <label>Начало</label>
              <input type="date" required value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="field">
              <label>Окончание</label>
              <input type="date" required value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
          </div>
          <div className="summary-box">
            <div className="summary-row">
              <span>Аренда, {days} {pluralRu(days, "день", "дня", "дней")}</span>
              <span className="v">{money(cost)}</span>
            </div>
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn btn-primary" disabled={submitting || clients.length === 0}>
            Забронировать
          </button>
        </div>
      </form>
    </dialog>
  );
}
