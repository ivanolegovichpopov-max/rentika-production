/**
 * Форматирование ставки оборудования/позиции аренды — вынесено из
 * RentalsTab.tsx в отдельный модуль (39-й проход, доработки вкладки
 * "Аренды" по итогам обзора). Раньше rateLabel/equipmentRateLabel/
 * itemRateLabel были локальными функциями RentalsTab.tsx — их пришлось
 * "расшарить", когда понадобился RentalDetailPanel.tsx: показывает ту же
 * построчную ставку для каждой позиции аренды, что и IssueRentalModal, и
 * дублировать формулу (см. периодную/блочную надбавку — двадцатый проход,
 * п.4) во втором файле было бы ошибкой, а не решением.
 */
import type { Equipment, Rental, RentalItem } from "../../../api/types";
import { money } from "../../../lib/format";
import { itemCostForDays } from "../../../lib/financeCalc";

/** periodPriceAfter — цена за ОДИН ПОЛНЫЙ ИЛИ НАЧАТЫЙ шаг длиной
 * afterPeriodDays дней (двадцатый проход, п.4 обзора), а не цена, размазанная
 * линейно по дням. afterPeriodDays==1 печатается как "/сутки" для
 * читаемости (самый частый случай — посуточная надбавка), любая другая
 * длина шага — как "/N дн". */
export function rateLabel(
  dailyRate: number,
  periodDays: number | null,
  periodPrice: number | null,
  periodPriceAfter: number | null,
  afterPeriodDays: number | null
): string {
  if (periodDays && periodPrice) {
    const afterDays = afterPeriodDays || 1;
    const afterUnit = afterDays === 1 ? "сутки" : `${afterDays} дн`;
    return `${money(periodPrice)}/${periodDays}дн` + (periodPriceAfter != null ? ` → ${money(periodPriceAfter)}/${afterUnit}` : "");
  }
  return `${money(dailyRate)}/сутки`;
}

export function equipmentRateLabel(e: Equipment): string {
  return rateLabel(e.daily_rate, e.period_days, e.period_price, e.period_price_after, e.after_period_days);
}

export function itemRateLabel(it: RentalItem): string {
  return rateLabel(
    it.daily_rate_snapshot,
    it.period_days_snapshot,
    it.period_price_snapshot,
    it.period_price_after_snapshot,
    it.after_period_days_snapshot
  );
}

/** Стоимость позиции ПО ТЕКУЩЕМУ (живому) тарифу Equipment за N дней — для
 * живой оценки в CreateRentalModal/EditRentalModal (43-й проход, п.1
 * обзора), где реальных RentalItem-снимков ещё нет (аренда не создана/не
 * сохранена). Оборачивает ту же itemCostForDays из financeCalc.ts — ТОЙ ЖЕ
 * формулой, что считает реальную стоимость аренды и предпросмотр тарифа в
 * EquipmentFormModal.tsx, без своей копии ступенчатой логики: собирает
 * временный RentalItem-подобный объект из живых полей Equipment (тот же
 * приём, что и previewCost в EquipmentFormModal.tsx). */
export function equipmentCostForDays(e: Equipment, days: number): number {
  return itemCostForDays(
    {
      equipment_id: e.id,
      daily_rate_snapshot: e.daily_rate,
      period_days_snapshot: e.period_days,
      period_price_snapshot: e.period_price,
      period_price_after_snapshot: e.period_price_after,
      after_period_days_snapshot: e.after_period_days,
      returned_at: null,
    },
    days
  );
}

/** Короткий номер договора, показываемый в печатных документах (documents.tsx)
 * — первые 8 символов id заглавными. Вынесен сюда (43-й проход, п.7 обзора),
 * чтобы тем же значением можно было искать аренду в списке (RentalsTab.tsx),
 * не дублируя формулу в двух местах. */
export function docNumber(r: Rental): string {
  return r.id.slice(0, 8).toUpperCase();
}

/* ============================================================
   Доступность оборудования на произвольный диапазон дат — порт
   isEquipmentFree/nextFreeDate демо (addRentalForm/editRentalForm). Раньше
   жило только внутри RentalsTab.tsx (EquipmentPicklist) — вынесено сюда
   (41-й проход) для повторного использования в ExtendRentalModal (проверка
   конфликта при быстром продлении аренды) и CreateRentalModal (фильтрация
   предзаполненных позиций при "Повторить аренду" — только реально свободные
   на новый период сразу отмечаются галочкой).
   ============================================================ */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export function isEquipmentFreeForRange(
  equipmentId: string,
  start: string,
  end: string,
  rentals: Rental[],
  excludeRentalId?: string
): boolean {
  if (!start || !end) return true;
  return !rentals.some((r) => {
    if (r.id === excludeRentalId) return false;
    if (r.status !== "booked" && r.status !== "active") return false;
    if (!r.items.some((it) => it.equipment_id === equipmentId)) return false;
    return rangesOverlap(r.start_date, r.end_date, start, end);
  });
}

export function conflictEndFor(
  equipmentId: string,
  start: string,
  end: string,
  rentals: Rental[],
  excludeRentalId?: string
): string | null {
  const blocking = rentals
    .filter((r) => {
      if (r.id === excludeRentalId) return false;
      if (r.status !== "booked" && r.status !== "active") return false;
      if (!r.items.some((it) => it.equipment_id === equipmentId)) return false;
      return rangesOverlap(r.start_date, r.end_date, start, end);
    })
    .sort((a, b) => (a.end_date < b.end_date ? 1 : -1));
  return blocking.length ? blocking[0].end_date : null;
}
