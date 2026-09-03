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
 * длина шага — как "/N дн".
 *
 * ВАЖНО (50-й проход, по итогам всестороннего обзора вкладки "Аренды"):
 * periodPrice НЕ является ценой за первые periodDays дней аренды — пока
 * срок не превышает periodDays, itemCostForDays (financeCalc.ts) считает
 * стоимость по обычной посуточной ставке dailyRate, periodPrice вообще не
 * участвует (это осознанное поведение бэкенда, зафиксированное тестом
 * test_pricing_within_period_uses_daily_rate_not_period_price в
 * backend/tests/test_pricing.py — здесь НЕ трогаем формулу, только текст).
 * Раньше подпись звучала как "690 ₽/14дн" — читалась как "14 дней стоят
 * 690 ₽", что для многих реальных тарифов просто неверно (пример из
 * обзора: dailyRate=27.14, periodDays=14 → 14 дней реально стоят 379.96 ₽,
 * а не 690). Теперь подпись честно показывает посуточную ставку и то, что
 * periodPrice — это цена, в которую упирается стоимость ТОЛЬКО когда срок
 * ПРЕВЫСИЛ период. */
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
    return (
      `${money(dailyRate)}/сутки → дольше ${periodDays} дн: ${money(periodPrice)}` +
      (periodPriceAfter != null ? ` +${money(periodPriceAfter)}/${afterUnit}` : "")
    );
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

/** Расшифровка ступенчатой ставки для title/подсказки (46-й проход, по
 * итогам обзора формы "Новая аренда" — короткая запись "690 ₽/14дн →
 * 190 ₽/7 дн" сама по себе непонятна тому, кто не в курсе идиомы "цена за
 * период → цена за шаг после него"; полным предложением при наведении —
 * понятно любому сотруднику). undefined для простого посуточного тарифа —
 * там rateLabel() уже самодостаточен, пояснять нечего.
 *
 * Переписана в 50-м проходе вместе с rateLabel() — старый текст "690 ₽ за
 * первые 14 дн." прямо утверждал то, что формула не делает (см. комментарий
 * над rateLabel). Теперь явно называет оба случая: посуточно в пределах
 * периода, порог periodPrice — только при выходе за него. */
export function rateLabelTitle(
  dailyRate: number,
  periodDays: number | null,
  periodPrice: number | null,
  periodPriceAfter: number | null,
  afterPeriodDays: number | null
): string | undefined {
  if (!periodDays || !periodPrice) return undefined;
  const afterDays = afterPeriodDays || 1;
  const afterUnit = afterDays === 1 ? "сутки" : `каждые ${afterDays} дн.`;
  const base = `До ${periodDays} дн. — по ${money(dailyRate)} ₽/сутки. Дольше ${periodDays} дн. — ${money(periodPrice)} ₽`;
  return periodPriceAfter != null ? `${base}, затем ${money(periodPriceAfter)} за ${afterUnit}.` : `${base}.`;
}

export function equipmentRateLabelTitle(e: Equipment): string | undefined {
  return rateLabelTitle(e.daily_rate, e.period_days, e.period_price, e.period_price_after, e.after_period_days);
}

export function itemRateLabelTitle(it: RentalItem): string | undefined {
  return rateLabelTitle(
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
    // !it.returned_at — та же поправка на частичный возврат, что и в
    // activeRentalFor (statusMeta.tsx), см. комментарий там (50-й проход):
    // индивидуально возвращённая позиция не должна блокировать её же саму
    // на новый диапазон дат, даже если сама аренда ещё active.
    if (!r.items.some((it) => it.equipment_id === equipmentId && !it.returned_at)) return false;
    return rangesOverlap(r.start_date, r.end_date, start, end);
  });
}

/** Аренда закрыта, депозит был, но ещё не отмечен возвращённым (43-й проход,
 * п.2 обзора) — та же формула, что и чекбокс "Депозит возвращён" в
 * RentalDetailPanel.tsx (deposit_returned_at выставляется только для
 * status="returned"), используется и для бейджа на карточке, и для фильтра
 * "Показать только". Перенесена сюда из RentalsTab.tsx (49-й проход) — та же
 * причина, что и у остальных функций этого файла: понадобилась ещё и в
 * Dashboard.tsx (сводка долга в шапке вкладки "Аренды"), дублировать формулу
 * ради одного места было бы ошибкой. */
export function isDepositDue(r: Rental): boolean {
  return r.status === "returned" && r.deposit_total > 0 && !r.deposit_returned_at;
}

/** Не оплачено (полностью или частично) — 46-й проход, "чего не хватает на
 * главной странице": total считается вживую (см. compute_rental_breakdown)
 * и может расти день ото дня для просроченной аренды, поэтому остаток
 * (total - paid_amount) тоже пересчитывается здесь при каждом рендере, а
 * не хранится. Отменённые аренды исключены — оплата за них не взимается.
 * Перенесена сюда из RentalsTab.tsx (49-й проход) вместе с isDepositDue
 * выше — та же причина. */
export function isUnpaid(r: Rental): boolean {
  return r.status !== "cancelled" && r.total - r.paid_amount > 0.01;
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
      // Та же поправка на частичный возврат, что и в isEquipmentFreeForRange
      // выше (50-й проход) — см. комментарий там.
      if (!r.items.some((it) => it.equipment_id === equipmentId && !it.returned_at)) return false;
      return rangesOverlap(r.start_date, r.end_date, start, end);
    })
    .sort((a, b) => (a.end_date < b.end_date ? 1 : -1));
  return blocking.length ? blocking[0].end_date : null;
}
