/**
 * IssueRentalModal — форма «Выдать оборудование» (перевод аренды из
 * «Забронировано» в «В аренде», акт приёма-передачи формируется отдельно).
 * Вынесена в отдельный файл при разноске RentalsTab.tsx по модулям (52-й
 * проход, по образцу round 23/29).
 */
import { useState } from "react";
import { api, ApiError } from "../../../api/client";
import type { Client, Equipment, Rental } from "../../../api/types";
import { itemRateLabel, itemRateLabelTitle } from "./helpers";
import { FormModal } from "./FormModal";

// Текст по умолчанию для textarea — 1:1 с демо (issueRentalForm) и с
// DEFAULT_ISSUE_NOTES на backend'е (app/api/routes/rentals.py) — если поле
// не тронуто, отправляем именно этот текст явно (backend и сам подставит
// его при пустом значении, но так пользователь видит тот же дефолт, что и
// в форме демо).
const DEFAULT_ISSUE_NOTES = "Комплектация полная, состояние исправное.";

/* ---------- Выдать оборудование ---------- */
export function IssueRentalModal({
  businessId,
  rental,
  client,
  equipment,
  onClose,
  onIssued,
}: {
  businessId: string;
  rental: Rental;
  client: Client | undefined;
  equipment: Equipment[];
  onClose: () => void;
  onIssued: (updated: Rental) => Promise<void>;
}) {
  const [notes, setNotes] = useState(DEFAULT_ISSUE_NOTES);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const updated = await api.post<Rental>(`/businesses/${businessId}/rentals/${rental.id}/issue`, {
        issue_notes: notes,
      });
      await onIssued(updated);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось выдать аренду");
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormModal
      title={`Выдать оборудование — ${client?.name ?? "—"}`}
      open
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel={saving ? "Сохранение…" : "Выдать"}
      error={error}
    >
      <div className="summary-box">
        {rental.items.map((it) => {
          const eq = equipment.find((e) => e.id === it.equipment_id);
          return (
            <div className="mini-item" key={it.equipment_id}>
              <span>{eq?.name ?? "—"}</span>
              <span className="mono" title={itemRateLabelTitle(it)}>
                {itemRateLabel(it)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="field">
        <label>Состояние на момент выдачи</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Комплектация полная, повреждений нет…" />
      </div>
      <div className="field-hint">После выдачи автоматически сформируется акт приёма-передачи.</div>
    </FormModal>
  );
}
