/**
 * Мелкие чистые функции-хелперы вокруг Equipment/Rental, вынесенные из
 * EquipmentTab.tsx в отдельный модуль (двадцать второй проход, "разнести по
 * отдельным файлам") — используются и в основном списке оборудования
 * (EquipmentTab), и в детальной панели (EquipmentDetailPanel).
 */
import type { Equipment, Rental } from "../../../api/types";
import { money } from "../../../lib/format";

/** Ставка, разложенная на "главную" и "вторую" часть (32-й проход, обзор
 * оформления таблицы «Оборудование») — используется там, где нужно
 * визуально отличить основную цену от цены "после периода" (в таблице она
 * рендерится мельче и приглушённым цветом, см. .rate-secondary в
 * styles.css). period_price_after — цена за ОДИН полный или начатый шаг
 * длиной after_period_days дней, а не линейно размазанная по дням надбавка
 * (двадцатый проход, п.4 обзора) — печатается как есть, без деления.
 * after_period_days==1 (самый частый случай, посуточная надбавка) печатается
 * как "/сутки" для читаемости, любая другая длина шага — как "/N дн". */
export function rateLabelParts(e: Equipment): { primary: string; secondary: string | null } {
  if (e.period_days && e.period_price) {
    const afterDays = e.after_period_days || 1;
    const afterUnit = afterDays === 1 ? "сутки" : `${afterDays} дн`;
    return {
      primary: money(e.period_price) + "/" + e.period_days + "дн",
      secondary: e.period_price_after != null ? "→ " + money(e.period_price_after) + "/" + afterUnit : null,
    };
  }
  return { primary: money(e.daily_rate) + "/сутки", secondary: null };
}

/** Ставка одной строкой — 1:1 из демо (rateLabel), для мест, где разбивка на
 * главную/вторую часть не нужна (детальная панель, форма аренды). */
export function rateLabel(e: Equipment): string {
  const { primary, secondary } = rateLabelParts(e);
  return primary + (secondary ? " " + secondary : "");
}

/** Есть ли у позиции незакрытая аренда (в работе или забронирована) —
 * определяется на фронте из уже загруженного списка аренд, без нового
 * эндпоинта, 1:1 с демо (equipmentHasOpenRentals). */
export function equipmentHasOpenRentals(equipmentId: string, rentals: Rental[]): boolean {
  return rentals.some(
    (r) => (r.status === "active" || r.status === "booked") && r.items.some((it) => it.equipment_id === equipmentId)
  );
}
