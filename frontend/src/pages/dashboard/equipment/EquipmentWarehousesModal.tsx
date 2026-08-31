/**
 * EquipmentWarehousesModal — вынесено из EquipmentTab.tsx в отдельный модуль
 * (двадцать второй проход, "разнести по отдельным файлам").
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../../api/client";
import type { EquipmentWarehouse } from "../../../api/types";
import { IconClose, IconEdit, IconTrash, IconGrip } from "../../../lib/icons";
import { useConfirm } from "../../../components/ConfirmDialog";
import { useToast } from "../../../components/Toast";

/* ============================================================
   Модалка управления справочником складов — восемнадцатый проход, точная
   копия EquipmentCategoriesModal выше (тот же идиом, тот же принцип
   переименования каскадом/запрета удаления занятого склада — см. backend
   app/api/routes/equipment.py: rename/delete_equipment_warehouse). Отдельный
   компонент, а не параметризация EquipmentCategoriesModal — тексты и
   эндпоинты в двух местах отличаются ("категория"/"склад",
   equipment-categories/equipment-warehouses), а самой логики немного, так
   что дублирование дешевле, чем обобщение через пропы-строки.
   ============================================================ */
export function EquipmentWarehousesModal({
  open,
  businessId,
  warehouses,
  onClose,
  onChanged,
  onSelect,
}: {
  open: boolean;
  businessId: string;
  warehouses: EquipmentWarehouse[];
  onClose: () => void;
  onChanged: () => void;
  // См. onSelect у EquipmentCategoriesModal выше — тот же смысл.
  onSelect?: (name: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newWhName, setNewWhName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  // См. catSort у EquipmentCategoriesModal выше — тот же смысл "custom".
  const [whSort, setWhSort] = useState<{ key: "custom" | "name" | "count"; dir: "asc" | "desc" }>({
    key: "custom",
    dir: "asc",
  });
  const [dragWhId, setDragWhId] = useState<string | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { notify } = useToast();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (open) {
      setRenamingId(null);
      setRenameValue("");
      setRowError({});
      setNewWhName("");
      setAddError(null);
    }
  }, [open]);

  async function submitNewWarehouse() {
    const value = newWhName.trim();
    if (!value) {
      setAddError("Название не может быть пустым");
      return;
    }
    if (warehouses.some((w) => w.name.toLowerCase() === value.toLowerCase())) {
      setAddError("Такой склад уже есть в справочнике");
      return;
    }
    setAddBusy(true);
    setAddError(null);
    try {
      await api.post(`/businesses/${businessId}/equipment-warehouses`, { name: value });
      setNewWhName("");
      onChanged();
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : "Не удалось добавить склад");
    } finally {
      setAddBusy(false);
    }
  }

  function toggleWhSort(key: "custom" | "name" | "count") {
    if (key === "custom") {
      setWhSort({ key, dir: "asc" });
      return;
    }
    setWhSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  }
  const sortedWarehouses =
    whSort.key === "custom"
      ? warehouses
      : [...warehouses].sort((a, b) => {
          const dir = whSort.dir === "desc" ? -1 : 1;
          if (whSort.key === "count") return (a.equipment_count - b.equipment_count) * dir;
          return a.name.localeCompare(b.name, "ru") * dir;
        });

  async function submitWhReorder(order: string[]) {
    setReorderBusy(true);
    try {
      await api.post(`/businesses/${businessId}/equipment-warehouses/reorder`, { order });
      onChanged();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось изменить порядок складов");
    } finally {
      setReorderBusy(false);
    }
  }

  function handleWhDrop(targetId: string) {
    const dragged = dragWhId;
    setDragWhId(null);
    if (!dragged || dragged === targetId) return;
    const ids = warehouses.map((w) => w.id);
    const from = ids.indexOf(dragged);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragged);
    void submitWhReorder(ids);
  }

  function startRename(w: EquipmentWarehouse) {
    setRenamingId(w.id);
    setRenameValue(w.name);
    setRowError((prev) => ({ ...prev, [w.id]: "" }));
  }

  async function submitRename(w: EquipmentWarehouse) {
    const value = renameValue.trim();
    if (!value) {
      setRowError((prev) => ({ ...prev, [w.id]: "Название не может быть пустым" }));
      return;
    }
    if (value === w.name) {
      setRenamingId(null);
      return;
    }
    setBusyId(w.id);
    try {
      await api.patch(`/businesses/${businessId}/equipment-warehouses/${w.id}`, { name: value });
      setRenamingId(null);
      onChanged();
    } catch (err) {
      setRowError((prev) => ({ ...prev, [w.id]: err instanceof ApiError ? err.message : "Не удалось переименовать" }));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(w: EquipmentWarehouse) {
    if (w.equipment_count > 0) {
      notify(
        `Нельзя удалить: склад «${w.name}» использует ${w.equipment_count} ` +
          `${w.equipment_count === 1 ? "позиция" : "позиций"} оборудования. Сначала перенесите их на другой склад.`
      );
      return;
    }
    if (!(await confirm(`Склад «${w.name}» будет удалён безвозвратно.`, { danger: true }))) return;
    setBusyId(w.id);
    try {
      await api.delete(`/businesses/${businessId}/equipment-warehouses/${w.id}`);
      onChanged();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось удалить склад");
    } finally {
      setBusyId(null);
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
      <div className="modal-head">
        <h3>Склады</h3>
        <button type="button" className="icon-btn" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="modal-body">
        <div className="inline-form" style={{ marginBottom: "14px" }}>
          <input
            value={newWhName}
            onChange={(e) => {
              setNewWhName(e.target.value);
              setAddError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submitNewWarehouse();
              }
            }}
            placeholder="Новый склад…"
            disabled={addBusy}
            style={{ flex: 1 }}
          />
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void submitNewWarehouse()} disabled={addBusy}>
            {addBusy ? "Добавляем…" : "Добавить"}
          </button>
        </div>
        {addError && <div className="form-error" style={{ marginBottom: "10px" }}>{addError}</div>}
        {onSelect && warehouses.length > 0 && (
          <div className="field-hint" style={{ marginBottom: "10px" }}>
            Нажмите на склад в списке, чтобы подставить его в форму.
          </div>
        )}
        {warehouses.length === 0 ? (
          <div className="empty-note">Справочник пуст — добавьте первый склад выше (нужно только если у бизнеса несколько точек хранения).</div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: "360px", overflowY: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th
                    className={"sortable" + (whSort.key === "custom" ? " active" : "")}
                    title="Ручной порядок — перетащите строки за ⠿, чтобы изменить"
                    onClick={() => toggleWhSort("custom")}
                  >
                    <span className={"sort-arrow" + (whSort.key === "custom" ? "" : " sort-arrow-idle")}>
                      {whSort.key === "custom" ? "⠿" : "↕"}
                    </span>
                  </th>
                  <th className={"sortable" + (whSort.key === "name" ? " active" : "")} onClick={() => toggleWhSort("name")}>
                    Название
                    <span className={"sort-arrow" + (whSort.key === "name" ? "" : " sort-arrow-idle")}>
                      {whSort.key === "name" ? (whSort.dir === "desc" ? "▼" : "▲") : "↕"}
                    </span>
                  </th>
                  <th className={"sortable" + (whSort.key === "count" ? " active" : "")} onClick={() => toggleWhSort("count")}>
                    Позиций
                    <span className={"sort-arrow" + (whSort.key === "count" ? "" : " sort-arrow-idle")}>
                      {whSort.key === "count" ? (whSort.dir === "desc" ? "▼" : "▲") : "↕"}
                    </span>
                  </th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sortedWarehouses.map((w) => {
                  const selectable = !!onSelect && renamingId !== w.id;
                  const draggableRow = whSort.key === "custom" && !reorderBusy;
                  return (
                    <tr
                      key={w.id}
                      className={
                        (selectable ? "row-selectable " : "") + (draggableRow ? "row-draggable" : "") +
                        (dragWhId === w.id ? " dragging" : "")
                      }
                      style={selectable ? { cursor: "pointer" } : undefined}
                      title={selectable ? "Выбрать этот склад для формы" : undefined}
                      onClick={selectable ? () => { onSelect(w.name); onClose(); } : undefined}
                      onDragOver={
                        draggableRow
                          ? (e) => {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = "move";
                              e.currentTarget.classList.add("drag-over");
                            }
                          : undefined
                      }
                      onDragLeave={draggableRow ? (e) => e.currentTarget.classList.remove("drag-over") : undefined}
                      onDrop={
                        draggableRow
                          ? (e) => {
                              e.preventDefault();
                              e.currentTarget.classList.remove("drag-over");
                              handleWhDrop(w.id);
                            }
                          : undefined
                      }
                    >
                      <td
                        className={"drag-handle-cell" + (draggableRow ? "" : " disabled")}
                        draggable={draggableRow}
                        title={draggableRow ? "Перетащите, чтобы изменить порядок" : "Переключитесь на ручной порядок (⠿), чтобы перетаскивать"}
                        onClick={(e) => e.stopPropagation()}
                        onDragStart={
                          draggableRow
                            ? (e) => {
                                e.dataTransfer.setData("text/plain", w.id);
                                e.dataTransfer.effectAllowed = "move";
                                setDragWhId(w.id);
                              }
                            : undefined
                        }
                        onDragEnd={draggableRow ? () => setDragWhId(null) : undefined}
                      >
                        <IconGrip />
                      </td>
                      <td>
                        {renamingId === w.id ? (
                          <>
                            <input
                              autoFocus
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void submitRename(w);
                                if (e.key === "Escape") setRenamingId(null);
                              }}
                              style={{ maxWidth: "220px" }}
                            />
                            {rowError[w.id] && <div className="form-error">{rowError[w.id]}</div>}
                          </>
                        ) : (
                          w.name
                        )}
                      </td>
                      <td className="mono">{w.equipment_count}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                        {renamingId === w.id ? (
                          <>
                            <button type="button" className="btn btn-sm" onClick={() => setRenamingId(null)} disabled={busyId === w.id}>
                              Отмена
                            </button>{" "}
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              onClick={() => void submitRename(w)}
                              disabled={busyId === w.id}
                            >
                              Сохранить
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="icon-btn"
                              title="Переименовать"
                              onClick={() => startRename(w)}
                              disabled={busyId !== null}
                            >
                              <IconEdit />
                            </button>{" "}
                            <button
                              type="button"
                              className="icon-btn"
                              title={w.equipment_count > 0 ? "Нельзя удалить: склад используется" : "Удалить"}
                              onClick={() => void handleDelete(w)}
                              disabled={busyId !== null}
                            >
                              <IconTrash />
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Готово
        </button>
      </div>
      {confirmDialog}
    </dialog>
  );
}
