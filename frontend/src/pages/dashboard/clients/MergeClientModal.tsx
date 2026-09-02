/**
 * Слияние дублей клиента — вынесена из ClientsTab.tsx в отдельный модуль
 * (38-й проход, "прибраться в коде"). По образцу общего idiom `<dialog>` в
 * проекте. source — карточка, которая исчезнет; выбранная в селекте цель
 * остаётся и получает всю историю аренд source (см.
 * app/api/routes/clients.py:merge_client). Найдено при обзоре вкладки
 * «Клиенты» (24-й проход, п.7): раньше объединить случайно заведённых
 * дублей можно было только вручную через API.
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../../api/client";
import type { Client } from "../../../api/types";
import { IconClose } from "../../../lib/icons";
import { useConfirm } from "../../../components/ConfirmDialog";
import { Dropdown } from "../../../components/Dropdown";

export function MergeClientModal({
  businessId,
  source,
  clients,
  onClose,
  onMerged,
}: {
  businessId: string;
  source: Client;
  clients: Client[];
  onClose: () => void;
  onMerged: () => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [targetId, setTargetId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
  }, []);

  const candidates = clients.filter((c) => c.id !== source.id);
  const target = candidates.find((c) => c.id === targetId);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) {
      setError("Выберите клиента, в которого нужно перенести историю");
      return;
    }
    if (
      !(await confirm(
        `Карточка «${source.name}» будет удалена, вся её история аренд перейдёт клиенту «${target.name}». Отменить это действие будет нельзя.`,
        { danger: true, confirmLabel: "Объединить" }
      ))
    )
      return;
    setError(null);
    setSaving(true);
    try {
      await api.post(`/businesses/${businessId}/clients/${source.id}/merge`, { into_client_id: target.id });
      await onMerged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось объединить клиентов");
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      id="modal"
      className="wide"
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form onSubmit={(e) => void handleSubmit(e)}>
        <div className="modal-head">
          <h3>Объединить с другим клиентом</h3>
          <button type="button" className="icon-btn" onClick={onClose} disabled={saving}>
            <IconClose />
          </button>
        </div>
        <div className="modal-body">
          <div className="field-hint" style={{ marginBottom: "10px" }}>
            Вся история аренд клиента «{source.name}» будет перенесена в выбранную карточку, а карточка «{source.name}» —
            удалена. Используйте, если это дубль. Данные самой карточки (телефон/email/заметка) не переносятся —
            заранее скопируйте нужное в целевую карточку вручную, если требуется.
          </div>
          <div className="field">
            <label>Перенести историю в</label>
            {/* Поле поиска в пикере (29-й проход, п.15 обзора) — в базе с
                сотнями клиентов листать простой список неудобно; заодно
                модалка расширена (className="wide" на <dialog> выше), чтобы
                длинные имена/телефоны в списке не переносились через строку. */}
            <Dropdown
              value={targetId}
              onChange={setTargetId}
              placeholder="Выберите клиента"
              searchable
              searchPlaceholder="Поиск по имени…"
              options={candidates.map((c) => ({ value: c.id, label: c.name + (c.phone ? ` · ${c.phone}` : "") }))}
            />
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            Отмена
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !targetId}>
            {saving ? "Объединяем…" : "Объединить"}
          </button>
        </div>
      </form>
      {confirmDialog}
    </dialog>
  );
}
