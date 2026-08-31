/**
 * Мелкие чистые функции-хелперы вокруг Equipment/Rental, вынесенные из
 * EquipmentTab.tsx в отдельный модуль (двадцать второй проход, "разнести по
 * отдельным файлам") — используются и в основном списке оборудования
 * (EquipmentTab), и в детальной панели (EquipmentDetailPanel).
 */
import type { Equipment, Rental } from "../../../api/types";
import { money } from "../../../lib/format";

/** Подпись ставки с учётом ступенчатого тарифа — 1:1 из демо (rateLabel).
 *
 * period_price_after (двадцатый проход, п.4 обзора) — цена за ОДИН полный
 * или начатый шаг длиной after_period_days дней, а не линейно размазанная
 * по дням надбавка, как было раньше — печатается как есть, без деления.
 * after_period_days==1 (самый частый случай, посуточная надбавка) печатается
 * как "/сутки" для читаемости, любая другая длина шага — как "/N дн". */
export function rateLabel(e: Equipment): string {
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

/** Есть ли у позиции незакрытая аренда (в работе или забронирована) —
 * определяется на фронте из уже загруженного списка аренд, без нового
 * эндпоинта, 1:1 с демо (equipmentHasOpenRentals). */
export function equipmentHasOpenRentals(equipmentId: string, rentals: Rental[]): boolean {
  return rentals.some(
    (r) => (r.status === "active" || r.status === "booked") && r.items.some((it) => it.equipment_id === equipmentId)
  );
}
