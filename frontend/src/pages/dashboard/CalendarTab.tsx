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
 * ДВЕ ОСОЗНАННЫЕ УПРОЩЕНИЯ ОТНОСИТЕЛЬНО ДЕМО (см. также комментарии ниже
 * по месту):
 *  1. Порядок категорий (drag-and-drop) и свёрнутые категории в демо
 *     персистентны per-viewer через localStorage (oborotcrm_cal_category_
 *     order_v1 / oborotcrm_cal_collapsed_categories_v1). Здесь это обычное
 *     состояние компонента — сбрасывается при уходе с вкладки/перезагрузке
 *     страницы. Сознательное упрощение: сам факт наличия календаря в проде
 *     важнее персистентности мелких предпочтений одного пользователя.
 *  2. Всплывающее уведомление "диапазон занят" раньше шло через browser
 *     alert() (соответствовало остальному приложению — см. 16-й проход,
 *     обзор по скриншотам). Теперь — через общий useToast() (Toast.tsx),
 *     системную замену alert() на всё приложение.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useData } from "../../context/DataContext";
import { api, ApiError } from "../../api/client";
import type { Client, Equipment, Rental } from "../../api/types";
import { todayISO, isoAddDays, dayDiff, ymd, fmtDate, money, spanDays } from "../../lib/format";
import { IconChevronDown, IconGrip, IconClose } from "../../lib/icons";
import { useToast } from "../../components/Toast";
import { Dropdown } from "../../components/Dropdown";

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

export function CalendarTab({ businessId, search }: { businessId: string; search: string }) {
  const { equipment, clients, rentals, reloadRentals, reloadEquipment } = useData();
  const { notify } = useToast();

  const [calOffset, setCalOffset] = useState(0);
  const [calCategoryFilter, setCalCategoryFilter] = useState("all");
  const [calRange, setCalRange] = useState<number | "month">(14);
  const [calColStart, setCalColStart] = useState<string | null>(null);
  const [calColEnd, setCalColEnd] = useState<string | null>(null);

  // Порядок категорий (drag-and-drop) и свёрнутые категории — см. заметку об
  // упрощении в шапке файла: живёт только в памяти этого компонента.
  const [categoryOrder, setCategoryOrder] = useState<string[] | null>(null);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  const [quickBook, setQuickBook] = useState<QuickBookTarget | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);

  const calDragRef = useRef<{ eqId: string; anchorDate: string } | null>(null);
  const calDragMovedRef = useRef(false);
  const calSuppressNextClickRef = useRef(false);

  const calColDragRef = useRef<{ anchor: string; lastDate: string } | null>(null);
  const calColDragMovedRef = useRef(false);

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
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
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
  }, [usableAll, calCategoryFilter, q, grouping, catRank]);

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
    return { selDays, selLabel, summary: bits.join(" · ") };
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
  const allCollapsed = collapseAllAvailable && orderedCategories.every((c) => collapsedCategories.has(c));

  async function afterBooked() {
    setQuickBook(null);
    await Promise.all([reloadRentals(), reloadEquipment()]);
  }

  return (
    <div>
      <div className="tab-toolbar">
        <div className="segmented">
          <button type="button" className={calCategoryFilter === "all" ? "active" : ""} onClick={() => setCalCategoryFilter("all")}>
            Все категории
          </button>
          {orderedCategories.map((cat) => (
            <button
              key={cat}
              type="button"
              className={calCategoryFilter === cat ? "active" : ""}
              onClick={() => setCalCategoryFilter(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {collapseAllAvailable && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() =>
                setCollapsedCategories(allCollapsed ? new Set() : new Set(orderedCategories))
              }
            >
              {allCollapsed ? "Развернуть все" : "Свернуть все"}
            </button>
          )}
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
          <div className="segmented">
            <button type="button" onClick={navPrev}>{calRange === "month" ? "← Пред. месяц" : "← Назад"}</button>
            <button type="button" onClick={navToday}>Сегодня</button>
            <button type="button" onClick={navNext}>{calRange === "month" ? "След. месяц →" : "Вперёд →"}</button>
          </div>
          <div className="cal-jump">
            <button type="button" className="btn btn-sm btn-ghost" title="Перейти к сегодняшнему дню" onClick={navToday}>
              Сегодня
            </button>
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
              <button type="button" title="Снять выделение" onClick={() => { setCalColStart(null); setCalColEnd(null); }}>
                <IconClose />
              </button>
            </span>
          )}
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
                    const collapsed = collapsedCategories.has(cat);
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
                  if (grouping && collapsedCategories.has(e.category)) return;

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
                        title={`Показать только категорию «${e.category}»`}
                        onClick={() => setCalCategoryFilter(e.category)}
                      >
                        {e.name}
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
                        const titleFull = title + (!hit && !isUnderMaintenanceOn(e, d) ? " — нажмите или протяните мышью, чтобы забронировать" : "") + ", " + fmtDate(d);
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
                            onClick={bookable ? () => handleCellClick(e.id, d) : undefined}
                          >
                            <div className={"cal-fill " + cls + (leftContinues ? " cont-left" : "") + (rightContinues ? " cont-right" : "")}>
                              {hitClient && (
                                <span className={"cal-fill-label" + (cls === "st-booked" ? " dark" : "")}>
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
    </div>
  );
}

/**
 * Форма быстрой брони по клику/протяжке ячейки календаря.
 *
 * Демо в этом месте открывает общую модалку "Новая аренда" (addRentalForm)
 * с чекбокс-списком ВСЕГО оборудования и выбором клиента. В проде нет
 * готового переиспользуемого компонента этой формы (аналог в RentalsTab.tsx
 * встроен прямо в вкладку и не экспортируется), а дублировать её целиком
 * ради календаря избыточно — оборудование здесь и так уже выбрано кликом по
 * ячейке. Поэтому здесь — облегчённая версия: только выбор клиента и дат
 * (предзаполненных из клика/протяжки), одно оборудование. Это сознательный
 * компромисс по UX (а не навигация на вкладку "Аренды" с предзаполнением,
 * которая потребовала бы прокидывать состояние формы между вкладками через
 * Dashboard.tsx, которым мы не владеем за пределами точечной правки).
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
