/**
 * ExtendRentalModal — быстрое продление аренды (только дата окончания).
 * Вынесена в отдельный файл при разноске RentalsTab.tsx по модулям (52-й
 * проход, по образцу round 23/29).
 */
import { useState } from "react";
import { api, ApiError } from "../../../api/client";
import type { Client, Rental } from "../../../api/types";
import { fmtDate, isoAddDays } from "../../../lib/format";
import { conflictEndFor } from "./helpers";
import { FormModal } from "./FormModal";
import { DatePicker } from "../../../components/DatePicker";

/* ---------- Быстрое продление (41-й проход) ---------- */
/**
 * Отдельная от EditRentalModal форма — там правится ВСЁ сразу (даты,
 * состав оборудования, скидка) и это осознанный полный набор полей "Изменить
 * аренду". Для самого частого случая — "клиент попросил ещё на пару дней" —
 * не нужно открывать весь этот набор и заново отмечать те же чекбоксы
 * оборудования: RentalEdit на backend'е (app/schemas/inventory.py) — все
 * поля опциональны, так что PATCH с одним end_date полностью безопасен и не
 * трогает остальные поля аренды. Открывается из RentalDetailPanel.tsx (кнопка
 * "Продлить") и из "Ещё" на самой карточке — RentalDetailPanel специально
 * НЕ делает сам PATCH-запрос (см. докстринг файла), а делегирует сюда через
 * onExtend, чтобы вся логика правки аренды жила в одном месте.
 */
export function ExtendRentalModal({
  businessId,
  rental,
  client,
  rentals,
  onClose,
  onSaved,
}: {
  businessId: string;
  rental: Rental;
  client: Client | undefined;
  rentals: Rental[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [endDate, setEndDate] = useState(isoAddDays(rental.end_date, 7));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (endDate <= rental.end_date) {
      setError("Новая дата окончания должна быть позже текущей.");
      return;
    }
    const conflict = rental.items
      .map((it) => conflictEndFor(it.equipment_id, rental.start_date, endDate, rentals, rental.id))
      .find((until) => until != null);
    if (conflict) {
      setError(`Часть оборудования уже забронирована на новый период (занято до ${fmtDate(conflict)}) — выберите более раннюю дату.`);
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/businesses/${businessId}/rentals/${rental.id}`, { end_date: endDate });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось продлить аренду");
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormModal
      title={`Продлить аренду — ${client?.name ?? "—"}`}
      open
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel={saving ? "Сохранение…" : "Продлить"}
      error={error}
    >
      <div className="field">
        <label>Текущая дата окончания</label>
        <div style={{ padding: "9px 11px", background: "var(--surface-2)", borderRadius: 8, fontSize: 13.5, fontWeight: 600 }}>
          {fmtDate(rental.end_date)}
        </div>
      </div>
      <div className="field">
        <label>Новая дата окончания</label>
        <DatePicker value={endDate} min={isoAddDays(rental.end_date, 1)} onChange={setEndDate} />
      </div>
      <div className="field-hint">Состав оборудования и скидка не меняются — только дата.</div>
    </FormModal>
  );
}
