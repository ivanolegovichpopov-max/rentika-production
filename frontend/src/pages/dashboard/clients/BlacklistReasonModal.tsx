/**
 * Причина занесения в чёрный список — вынесена из ClientsTab.tsx в отдельный
 * модуль (38-й проход, "прибраться в коде"). Простой `<dialog>` со свободным
 * текстовым полем, тем же идиомом, что и остальные модалки в проекте.
 * Отдельная модалка, а не общий useConfirm() (тот умеет только да/нет,
 * свободный текст не собирает) — см. Client.blacklist_reason в
 * app/models/inventory.py.
 */
import { useEffect, useRef, useState } from "react";
import { IconClose } from "../../../lib/icons";

export function BlacklistReasonModal({
  clientName,
  onClose,
  onConfirm,
}: {
  clientName: string;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void> | void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onConfirm(reason.trim());
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <dialog
      id="modal"
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form onSubmit={(e) => void handleSubmit(e)}>
        <div className="modal-head">
          <h3>В чёрный список — «{clientName}»</h3>
          <button type="button" className="icon-btn" onClick={onClose} disabled={submitting}>
            <IconClose />
          </button>
        </div>
        <div className="modal-body">
          <div className="field-hint" style={{ marginBottom: "10px" }}>
            Об этом стоит знать всей команде — укажите, что случилось, чтобы через полгода коллеге не пришлось
            разбираться заново.
          </div>
          <div className="field">
            <label>Причина</label>
            <textarea
              autoFocus
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Например: не вернул технику вовремя дважды подряд"
            />
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            Отмена
          </button>
          <button type="submit" className="btn btn-danger" disabled={submitting}>
            {submitting ? "Сохраняем…" : "В чёрный список"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
