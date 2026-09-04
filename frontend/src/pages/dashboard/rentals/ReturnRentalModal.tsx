/**
 * ReturnRentalModal — форма «Принять возврат» вместе с локальным
 * предпросмотром финансов (просрочка, повреждения, доп. услуги, скидка).
 * Вынесена в отдельный файл при разноске RentalsTab.tsx по модулям (52-й
 * проход, по образцу round 23/29).
 *
 * itemCostForDays/itemsCostForDays ниже — НАМЕРЕННО не консолидированы с
 * ../../../lib/financeCalc.ts: та же формула независимо продублирована в трёх
 * местах (financeCalc.ts, здесь и в CalendarTab.tsx) — держать все три
 * синхронными при любом изменении формулы, см. комментарий в financeCalc.ts.
 */
import { useState } from "react";
import { api, ApiError } from "../../../api/client";
import type { Client, Rental, RentalItem } from "../../../api/types";
import { money, spanDays, dayDiff, todayISO } from "../../../lib/format";
import { FormModal } from "./FormModal";
import { DatePicker } from "../../../components/DatePicker";


/* ============================================================
   Предпросмотр финансов при возврате — порт itemCostForDays/rentalFinanceCalc
   демо, той же формулой, что и app/services/pricing.py (item_cost_for_days/
   compute_rental_breakdown): пока форма открыта, актуальная дата возврата и
   доплата за повреждения ещё не сохранены, поэтому пересчитываем локально
   для live-превью в .summary-box. На самой отправке формы источник истины —
   backend (POST /return пересчитывает то же самое на своих данных).
   ============================================================ */
function itemCostForDays(it: RentalItem, days: number): number {
  if (days <= 0) return 0;
  const dailyRate = it.daily_rate_snapshot;
  const periodDays = it.period_days_snapshot;
  const periodPrice = it.period_price_snapshot;
  const periodPriceAfter = it.period_price_after_snapshot;
  if (!periodDays || !periodPrice) return dailyRate * days;
  if (days <= periodDays) return dailyRate * days;
  const extraDays = days - periodDays;
  const afterUnit = it.after_period_days_snapshot;
  // Блочная надбавка (двадцатый проход) — см. financeCalc.ts:itemCostForDays,
  // та же формула, продублированная здесь по тому же принципу, что и раньше.
  if (afterUnit) {
    const blocks = Math.ceil(extraDays / afterUnit);
    return periodPrice + blocks * (periodPriceAfter || 0);
  }
  const perDayAfter = (periodPriceAfter || 0) / periodDays;
  return periodPrice + extraDays * perDayAfter;
}

function itemsCostForDays(items: RentalItem[], days: number): number {
  return items.reduce((s, it) => s + itemCostForDays(it, days), 0);
}

interface FinancePreview {
  plannedDays: number;
  lateDays: number;
  base: number;
  lateFee: number;
  damage: number;
  // Доп. услуги (46-й проход) — фиксированное значение аренды, здесь не
  // редактируется (это делает CreateRentalModal/EditRentalModal), просто
  // должно попадать в итоговую сумму предпросмотра возврата — см. ниже.
  extraFee: number;
  extraFeeNote: string | null;
  discount: number;
  total: number;
}

// isDepositDue/isUnpaid перенесены в rentals/helpers.ts (49-й проход) —
// понадобились и в Dashboard.tsx (сводка долга в шапке вкладки), см. импорт
// ниже.

function previewReturnFinance(r: Rental, actualReturn: string, damageFee: number): FinancePreview {
  const plannedDays = spanDays(r.start_date, r.end_date);
  const endForCalc = actualReturn || (dayDiff(r.end_date) < 0 ? todayISO() : r.end_date);
  const actualDays = spanDays(r.start_date, endForCalc);
  const lateDays = Math.max(0, actualDays - plannedDays);
  const base = Math.round(itemsCostForDays(r.items, plannedDays));
  const actualCost = Math.round(itemsCostForDays(r.items, actualDays));
  const lateFee = Math.max(0, actualCost - base);
  const discount = r.discount || 0;
  const extraFee = r.extra_fee || 0;
  const total = Math.max(0, base + lateFee + damageFee + extraFee - discount);
  return {
    plannedDays,
    lateDays,
    base,
    lateFee,
    damage: damageFee,
    extraFee,
    extraFeeNote: r.extra_fee_note,
    discount,
    total,
  };
}

function FinanceSummary({ fin, depositTotal }: { fin: FinancePreview; depositTotal: number }) {
  return (
    <div className="summary-box">
      <div className="summary-row">
        <span>Аренда, {fin.plannedDays} дн.</span>
        <span className="v">{money(fin.base)}</span>
      </div>
      {fin.lateFee > 0 && (
        <div className="summary-row critical">
          <span>Просрочка, {fin.lateDays} дн.</span>
          <span className="v">{money(fin.lateFee)}</span>
        </div>
      )}
      {fin.damage > 0 && (
        <div className="summary-row critical">
          <span>Компенсация повреждений</span>
          <span className="v">{money(fin.damage)}</span>
        </div>
      )}
      {fin.extraFee > 0 && (
        <div className="summary-row">
          <span>{fin.extraFeeNote ? `Доп. услуги — ${fin.extraFeeNote}` : "Доп. услуги"}</span>
          <span className="v">{money(fin.extraFee)}</span>
        </div>
      )}
      {fin.discount > 0 && (
        <div className="summary-row">
          <span>Скидка</span>
          <span className="v">−{money(fin.discount)}</span>
        </div>
      )}
      <div className="summary-row total">
        <span>Итого к оплате</span>
        <span className="v">{money(fin.total)}</span>
      </div>
      <div className="summary-row">
        <span>Депозит на удержании</span>
        <span className="v">{money(depositTotal)}</span>
      </div>
    </div>
  );
}

// Текст по умолчанию для textarea — 1:1 с демо (returnRentalForm) и с
// DEFAULT_RETURN_NOTES на backend'е (app/api/routes/rentals.py) — если поле
// не тронуто, отправляем именно этот текст явно (backend и сам подставит
// его при пустом значении, но так пользователь видит тот же дефолт, что и
// в форме демо).
const DEFAULT_RETURN_NOTES = "Без повреждений, комплектация полная.";

/* ---------- Принять возврат ---------- */
export function ReturnRentalModal({
  businessId,
  rental,
  client,
  onClose,
  onReturned,
}: {
  businessId: string;
  rental: Rental;
  client: Client | undefined;
  onClose: () => void;
  onReturned: (updated: Rental) => Promise<void>;
}) {
  const [actualReturn, setActualReturn] = useState(todayISO());
  const [notes, setNotes] = useState(DEFAULT_RETURN_NOTES);
  const [damageFee, setDamageFee] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fin = previewReturnFinance(rental, actualReturn || todayISO(), Number(damageFee) || 0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const updated = await api.post<Rental>(`/businesses/${businessId}/rentals/${rental.id}/return`, {
        actual_return: actualReturn || todayISO(),
        return_notes: notes,
        damage_fee: Number(damageFee) || 0,
        // Скидка не редактируется в этой форме (как и в демо — она задаётся при
        // создании/правке аренды, не при возврате), но передать текущее
        // rental.discount явно обязательно: RentalReturn.discount по умолчанию
        // 0 на backend'е, и без явной передачи уже установленная скидка молча
        // сбросилась бы в 0 при приёме возврата.
        discount: rental.discount,
      });
      await onReturned(updated);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось принять возврат");
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormModal
      title={`Принять возврат — ${client?.name ?? "—"}`}
      open
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel={saving ? "Сохранение…" : "Принять возврат"}
      error={error}
    >
      <div className="field">
        <label>Фактическая дата возврата</label>
        <DatePicker value={actualReturn} onChange={setActualReturn} />
      </div>
      <div className="field">
        <label>Состояние при возврате</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Без повреждений…" />
      </div>
      <div className="field">
        <label>Доплата за повреждения, ₽ (если есть)</label>
        <input type="number" min={0} value={damageFee} onChange={(e) => setDamageFee(e.target.value)} />
      </div>
      <FinanceSummary fin={fin} depositTotal={rental.deposit_total} />
    </FormModal>
  );
}
