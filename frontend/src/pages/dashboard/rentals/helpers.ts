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
import type { Equipment, RentalItem } from "../../../api/types";
import { money } from "../../../lib/format";

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
