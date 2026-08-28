/**
 * Агрегирующие расчёты для Дашборда и Финансов — перенесены из демо-
 * прототипа. Расчёт стоимости ОДНОЙ аренды (base/late_fee/total/discount/
 * deposit_total) в проде делает backend (см. app/services/pricing.py,
 * compute_rental_breakdown) и отдаёт готовыми полями в Rental — здесь
 * только то, что считается ПО СПИСКУ аренд сразу (выручка за период,
 * топ оборудования, бакеты для графика), точно так же, как в демо, которое
 * тоже считало все агрегаты на лету из полного in-memory списка.
 */
import type { Equipment, Rental, RentalItem } from "../api/types";
import { dayDiff, isoAddDays, todayISO } from "./format";

export function minRentalDate(rentals: Rental[]): string {
  if (rentals.length === 0) return todayISO();
  return rentals.reduce((min, r) => (r.start_date < min ? r.start_date : min), rentals[0].start_date);
}

export interface FinancePeriod {
  key: "7" | "30" | "90" | "all" | "custom";
  from: string;
  to: string;
}

export function periodFor(key: "7" | "30" | "90" | "all", rentals: Rental[]): FinancePeriod {
  if (key === "all") return { key, from: minRentalDate(rentals), to: todayISO() };
  const days = Number(key);
  return { key, from: isoAddDays(todayISO(), -(days - 1)), to: todayISO() };
}

/** Возвраты, попавшие в период [from,to] по дате фактического (или плановой,
 * если факт не зафиксирован) возврата — ровно как в демо. */
export function returnsInPeriod(rentals: Rental[], from: string, to: string): Rental[] {
  return rentals
    .filter((r) => r.status === "returned")
    .filter((r) => {
      const d = r.actual_return || r.end_date;
      return d >= from && d <= to;
    })
    .sort((a, b) => {
      const da = a.actual_return || a.end_date;
      const db = b.actual_return || b.end_date;
      return da < db ? 1 : -1;
    });
}

/** Доля выручки конкретной позиции оборудования в аренде — пропорционально
 * её доле дневной ставки среди всех позиций аренды; компенсация за
 * повреждения делится поровну между позициями. */
function itemRevenueShare(r: Rental, equipmentId: string): number {
  const totalDaily = r.items.reduce((s, it) => s + it.daily_rate_snapshot, 0) || 1;
  const item = r.items.find((it) => it.equipment_id === equipmentId);
  if (!item) return 0;
  const share = item.daily_rate_snapshot / totalDaily;
  return (r.base + r.late_fee) * share + r.damage_fee / r.items.length;
}

export function equipmentRevenueMap(rentals: Rental[]): Record<string, number> {
  const map: Record<string, number> = {};
  rentals
    .filter((r) => r.status === "returned")
    .forEach((r) => {
      r.items.forEach((it) => {
        map[it.equipment_id] = (map[it.equipment_id] || 0) + itemRevenueShare(r, it.equipment_id);
      });
    });
  return map;
}

/** range не задан — считаем за всё время (как раньше). range задан —
 * учитываются только аренды, ВОЗВРАЩЁННЫЕ внутри [range.from, range.to] (тот
 * же фильтр, что и в "Финансах", returnsInPeriod) — используется дашбордовой
 * панелью "Топ оборудования по доходу" при добавлении переключателя периода. */
export function topEquipmentByRevenue(
  rentals: Rental[],
  equipment: Equipment[],
  limit = 5,
  range?: { from: string; to: string }
) {
  const scoped = range ? returnsInPeriod(rentals, range.from, range.to) : rentals;
  const map = equipmentRevenueMap(scoped);
  return Object.keys(map)
    .map((id) => ({ id, revenue: map[id] }))
    .filter((x) => equipment.some((e) => e.id === x.id))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}

/** Категориальный аналог topEquipmentByRevenue выше — тот же принцип
 * необязательного диапазона, поверх уже существующего categoryRevenueMap
 * (см. ниже), а не отдельная реализация. */
export function topCategoriesByRevenue(
  rentals: Rental[],
  equipment: Equipment[],
  limit = 5,
  range?: { from: string; to: string }
) {
  const scoped = range ? returnsInPeriod(rentals, range.from, range.to) : rentals.filter((r) => r.status === "returned");
  const map = categoryRevenueMap(scoped, equipment);
  return Object.keys(map)
    .map((category) => ({ category, revenue: map[category] }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}

export function categoryRevenueMap(rows: Rental[], equipment: Equipment[]): Record<string, number> {
  const byId: Record<string, Equipment> = {};
  equipment.forEach((e) => (byId[e.id] = e));
  const map: Record<string, number> = {};
  rows.forEach((r) => {
    r.items.forEach((it) => {
      const eq = byId[it.equipment_id];
      const cat = eq?.category || "Без категории";
      map[cat] = (map[cat] || 0) + itemRevenueShare(r, it.equipment_id);
    });
  });
  return map;
}

export function topClientsByRevenue(rows: Rental[], limit = 5) {
  const map: Record<string, number> = {};
  rows.forEach((r) => {
    map[r.client_id] = (map[r.client_id] || 0) + r.total;
  });
  return Object.keys(map)
    .map((id) => ({ id, revenue: map[id] }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}

export interface FinanceBucket {
  from: string;
  to: string;
  total: number;
}

/** Бакетинг по дням (период ≤31 дня), неделям (≤120 дней) или месяцам —
 * ровно как в демо (financeBuckets). */
export function financeBuckets(from: string, to: string, rows: Rental[]): FinanceBucket[] {
  const totalSpan = dayDiff(to) - dayDiff(from) + 1;
  const bucketDays = totalSpan <= 31 ? 1 : totalSpan <= 120 ? 7 : 30;
  const buckets: FinanceBucket[] = [];
  let cursor = from;
  while (cursor <= to) {
    const bucketTo = isoAddDays(cursor, bucketDays - 1) > to ? to : isoAddDays(cursor, bucketDays - 1);
    const total = rows
      .filter((r) => {
        const d = r.actual_return || r.end_date;
        return d >= cursor && d <= bucketTo;
      })
      .reduce((s, r) => s + r.total, 0);
    buckets.push({ from: cursor, to: bucketTo, total });
    cursor = isoAddDays(bucketTo, 1);
  }
  return buckets;
}

/** Депозиты, удержанные ПРЯМО СЕЙЧАС по активным/просроченным арендам — не
 * зависит от выбранного периода отчёта (см. demo: "сейчас, вне периода
 * отчёта"). */
export function depositsHeldNow(rentals: Rental[], displayStatusOf: (r: Rental) => string): number {
  return rentals
    .filter((r) => {
      const s = displayStatusOf(r);
      return s === "active" || s === "overdue";
    })
    .reduce((s, r) => s + r.deposit_total, 0);
}

/** Число дней пересечения двух диапазонов дат (0, если не пересекаются) —
 * порт overlapDays() из демо. */
export function overlapDays(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
  if (aStart > bEnd || bStart > aEnd) return 0;
  const lo = aStart > bStart ? aStart : bStart;
  const hi = aEnd < bEnd ? aEnd : bEnd;
  return dayDiff(hi) - dayDiff(lo) + 1;
}

/** Стоимость ОДНОЙ позиции аренды за N дней с учётом ступенчатого тарифа
 * (если задан period_days_snapshot/period_price_snapshot) — порт
 * itemCostForDays() из демо: первые period_days_snapshot дней — по
 * period_price_snapshot, каждый следующий полный период той же длины — по
 * period_price_after_snapshot (или по той же цене, если "после" не задана),
 * неполный хвостовой период — пропорционально дням. */
export function itemCostForDays(it: RentalItem, days: number): number {
  if (days <= 0) return 0;
  if (!it.period_days_snapshot || !it.period_price_snapshot) return it.daily_rate_snapshot * days;
  const P = it.period_days_snapshot;
  const fullPeriods = Math.floor(days / P);
  const remDays = days - fullPeriods * P;
  let total = 0;
  if (fullPeriods >= 1) {
    total += it.period_price_snapshot;
    if (fullPeriods > 1) total += (fullPeriods - 1) * (it.period_price_after_snapshot || it.period_price_snapshot);
  }
  if (remDays > 0) {
    const perDay = (fullPeriods >= 1 ? (it.period_price_after_snapshot || it.period_price_snapshot) : it.period_price_snapshot) / P;
    total += perDay * remDays;
  }
  return total;
}

/** Стоимость ВСЕХ позиций аренды за N дней — порт rentalItemsCost() из демо. */
export function rentalItemsCost(items: RentalItem[], days: number): number {
  return items.reduce((s, it) => s + itemCostForDays(it, days), 0);
}

/** Начисленная выручка по активным/просроченным арендам, попадающая в
 * [from,to] — точный порт accruedRevenueForPeriod() из демо (маржинальный
 * расчёт: стоимость дней аренды ДО начала пересечения вычитается из
 * стоимости дней аренды ПО КОНЕЦ пересечения, так ступенчатый тариф
 * применяется корректно относительно фактического начала аренды, а не
 * начала периода отчёта). Использует r.status напрямую (не displayStatus) —
 * ровно как демо: backend никогда не хранит "overdue" явно (см. types.ts),
 * поэтому фильтр по "active"/"overdue" безопасен и без вычисляемого статуса. */
export function accruedRevenueForPeriod(rentals: Rental[], from: string, to: string): number {
  let total = 0;
  rentals
    .filter((r) => r.status === "active" || r.status === "overdue")
    .forEach((r) => {
      const endForCalc = dayDiff(r.end_date) < 0 ? todayISO() : r.end_date;
      const ov = overlapDays(r.start_date, endForCalc, from, to);
      if (ov <= 0) return;
      const overlapStart = r.start_date > from ? r.start_date : from;
      const daysBefore = dayDiff(overlapStart) - dayDiff(r.start_date);
      const costThrough = rentalItemsCost(r.items, daysBefore + ov);
      const costBefore = daysBefore > 0 ? rentalItemsCost(r.items, daysBefore) : 0;
      total += costThrough - costBefore;
    });
  return Math.round(total);
}
