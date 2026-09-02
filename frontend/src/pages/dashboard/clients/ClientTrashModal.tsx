/**
 * Корзина клиентов — вынесена из ClientsTab.tsx в отдельный модуль (38-й
 * проход, "прибраться в коде"), по образцу equipment/EquipmentTab.tsx
 * (EquipmentTrashModal). Список клиентов, удалённых за последние 30 дней
 * (см. TRASH_RETENTION_DAYS в app/services/trash.py), с восстановлением в
 * один клик. Тот же idiom `<dialog className="wide">`, что и
 * ClientImportModal: загружается при каждом открытии, а не держится в общем
 * DataContext — корзину смотрят не каждый день, тащить её в общий стейт
 * приложения смысла нет.
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../../api/client";
import type { TrashedClient } from "../../../api/types";
import { fmtDate, initials } from "../../../lib/format";
import { IconClose, IconRestore } from "../../../lib/icons";

export function ClientTrashModal({
  open,
  businessId,
  onClose,
  onRestored,
}: {
  open: boolean;
  businessId: string;
  onClose: () => void;
  onRestored: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<TrashedClient[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setItems(null);
    setError(null);
    api
      .get<TrashedClient[]>(`/businesses/${businessId}/clients/trash`)
      .then((res) => {
        if (!cancelled) setItems(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Не удалось загрузить корзину");
      });
    return () => {
      cancelled = true;
    };
  }, [open, businessId]);

  async function handleRestore(id: string) {
    setRestoringId(id);
    try {
      await api.post(`/businesses/${businessId}/clients/${id}/restore`, {});
      setItems((prev) => (prev ?? []).filter((c) => c.id !== id));
      onRestored();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось восстановить клиента");
    } finally {
      setRestoringId(null);
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
      <div className="modal-head">
        <h3>Корзина клиентов</h3>
        <button type="button" className="icon-btn" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="modal-body">
        <div className="field-hint" style={{ marginBottom: "10px" }}>
          Удалённые клиенты хранятся здесь 30 дней и восстанавливаются в один клик. Клиенты с историей аренд (даже
          закрытой) остаются в корзине бессрочно — это финансовая история, физически она не удаляется.
        </div>
        {error && <div className="form-error">{error}</div>}
        {items === null ? (
          <div className="empty-note">Загрузка…</div>
        ) : items.length === 0 ? (
          <div className="empty-note">Корзина пуста</div>
        ) : (
          items.map((c) => (
            <div className="mini-item" key={c.id}>
              <span>
                <span className="avatar" style={{ width: 18, height: 18, fontSize: "9px", marginRight: "6px" }}>
                  {initials(c.name)}
                </span>
                {c.name}
                {c.phone ? ` · ${c.phone}` : ""}
                <span style={{ color: "var(--muted)", fontSize: "11.5px", marginLeft: "8px" }}>
                  удалён {fmtDate(c.deleted_at.slice(0, 10))}
                  {c.deleted_by_name ? ` · ${c.deleted_by_name}` : ""}
                </span>
              </span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={restoringId === c.id}
                onClick={() => void handleRestore(c.id)}
              >
                <IconRestore /> {restoringId === c.id ? "Восстанавливаем…" : "Восстановить"}
              </button>
            </div>
          ))
        )}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Готово
        </button>
      </div>
    </dialog>
  );
}
