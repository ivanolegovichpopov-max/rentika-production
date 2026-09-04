/**
 * CancelRentalModal — отмена аренды с необязательной причиной (43-й проход,
 * п.5 обзора). Вынесена в отдельный файл при разноске RentalsTab.tsx по
 * модулям (52-й проход, по образцу round 23/29).
 */
import { useState } from "react";
import { api, ApiError } from "../../../api/client";
import type { Client, Rental } from "../../../api/types";
import { FormModal } from "./FormModal";

/* ---------- Отменить аренду (43-й проход, п.5 обзора) ---------- */
/**
 * Раньше "Отменить" сразу вызывал generic useConfirm() (да/нет, без полей
 * ввода) — причину нельзя было указать, хотя backend (POST .../cancel,
 * body: RentalCancel | None) её уже принимает и пишет в журнал (см.
 * RentalHistorySection.tsx — entryDetails, case "cancel"). Отдельная
 * маленькая форма вместо расширения useConfirm полем ввода: useConfirm —
 * общий на десяток разных да/нет-подтверждений по всему приложению,
 * прикручивать к нему один текстовый инпут ради одного сценария было бы
 * менее точечным изменением, чем отдельная модалка на существующем
 * FormModal (тот же паттерн, что ExtendRentalModal чуть выше).
 */
export function CancelRentalModal({
  businessId,
  rental,
  client,
  onClose,
  onCancelled,
}: {
  businessId: string;
  rental: Rental;
  client: Client | undefined;
  onClose: () => void;
  onCancelled: () => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const trimmed = reason.trim();
      await api.post(`/businesses/${businessId}/rentals/${rental.id}/cancel`, trimmed ? { reason: trimmed } : undefined);
      await onCancelled();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось отменить аренду");
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormModal
      title={`Отменить аренду — ${client?.name ?? "—"}`}
      open
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel={saving ? "Отмена…" : "Отменить аренду"}
      danger
      error={error}
    >
      <div className="field">
        <label>Причина отмены (необязательно)</label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Клиент передумал, нашёл дешевле у конкурента…"
        />
      </div>
      <div className="field-hint">Причина попадёт в журнал изменений аренды — видна только сотрудникам.</div>
    </FormModal>
  );
}
