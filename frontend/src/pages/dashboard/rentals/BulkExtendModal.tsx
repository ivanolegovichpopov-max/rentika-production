/**
 * BulkExtendModal — массовое продление нескольких аренд одной датой сразу
 * (43-й проход, п.8 обзора). Вынесена в отдельный файл при разноске
 * RentalsTab.tsx по модулям (52-й проход, по образцу round 23/29).
 */
import { useState } from "react";
import { api } from "../../../api/client";
import type { Rental } from "../../../api/types";
import { todayISO, isoAddDays } from "../../../lib/format";
import { FormModal } from "./FormModal";
import { DatePicker } from "../../../components/DatePicker";

/* ---------- Массовое продление (43-й проход, п.8 обзора) ---------- */
/**
 * В отличие от ExtendRentalModal (одна аренда — проверка конфликта по
 * каждой её позиции через conflictEndFor до отправки), здесь одна дата
 * применяется сразу к нескольким разным арендам через Promise.allSettled —
 * предварительно проверять конфликт по всем позициям всех аренд разом
 * избыточно (backend и так отклонит конкретный PATCH при конфликте, см.
 * edit_rental), а allSettled уже даёт честный подсчёт "скольким реально
 * удалось продлить", как и handleBulkCancel чуть выше по файлу.
 */
export function BulkExtendModal({
  businessId,
  rentals,
  onClose,
  onDone,
}: {
  businessId: string;
  rentals: Rental[];
  onClose: () => void;
  onDone: (result: { ok: number; failed: number }) => Promise<void>;
}) {
  const latestCurrentEnd = rentals.reduce((max, r) => (r.end_date > max ? r.end_date : max), rentals[0]?.end_date ?? todayISO());
  const [endDate, setEndDate] = useState(isoAddDays(latestCurrentEnd, 7));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (endDate <= latestCurrentEnd) {
      setError("Новая дата окончания должна быть позже текущей даты окончания у всех выбранных аренд.");
      return;
    }
    setSaving(true);
    try {
      const results = await Promise.allSettled(
        rentals.map((r) => api.patch(`/businesses/${businessId}/rentals/${r.id}`, { end_date: endDate }))
      );
      const failed = results.filter((res) => res.status === "rejected").length;
      await onDone({ ok: rentals.length - failed, failed });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormModal
      title={`Продлить аренды (${rentals.length})`}
      open
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel={saving ? "Сохранение…" : "Продлить все"}
      error={error}
    >
      <div className="field">
        <label>Новая дата окончания</label>
        <DatePicker value={endDate} min={isoAddDays(latestCurrentEnd, 1)} onChange={setEndDate} />
      </div>
      <div className="field-hint">
        Применится ко всем выбранным арендам ({rentals.length}) — состав оборудования и скидка не меняются. Если у части
        оборудования на новый период уже есть конфликт с другой бронью, для соответствующей аренды продление не пройдёт — об
        этом будет сказано в итоговом сообщении.
      </div>
    </FormModal>
  );
}
