/**
 * EquipmentCategoriesModal — вынесено из EquipmentTab.tsx в отдельный модуль
 * (двадцать второй проход, "разнести по отдельным файлам").
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../../api/client";
import type { EquipmentCategory } from "../../../api/types";
import { IconClose, IconEdit, IconTrash, IconGrip } from "../../../lib/icons";
import { useConfirm } from "../../../components/ConfirmDialog";
import { useToast } from "../../../components/Toast";

/* ============================================================
   Модалка управления справочником категорий — пункт 1 обзора (владелец
   может переименовать категорию, что каскадом переименует её у всего
   оборудования на backend, или удалить неиспользуемую; занятую нельзя —
   см. app/api/routes/equipment.py: rename/delete_equipment_category). Тот же
   идиом <dialog>, что и остальные модалки файла. Список категорий и счётчики
   (equipment_count) приходят из контекста (equipmentCategories) — модалка
   их только показывает и дёргает reload после успешного изменения.
   ============================================================ */
export function EquipmentCategoriesModal({
  open,
  businessId,
  categories,
  onClose,
  onChanged,
  onSelect,
}: {
  open: boolean;
  businessId: string;
  categories: EquipmentCategory[];
  onClose: () => void;
  onChanged: () => void;
  // Присутствует только когда модалка открыта из формы добавления/изменения
  // оборудования (ссылка "Управление категориями") — тогда строки становятся
  // кликабельными: клик подставляет имя в поле формы и закрывает модалку.
  // Открытая из тулбара ("Категории"), где onSelect не передан, строки не
  // кликабельны — там это чисто экран управления справочником, выбирать
  // здесь нечего (19-й проход, п.2 обзора).
  onSelect?: (name: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  // Добавление категории прямо из "Управления категориями" (16-й проход,
  // обзор по скриншотам, п.1) — раньше единственный способ завести категорию
  // был вписать новое имя в поле "Категория" формы оборудования (авто-
  // создание при сохранении); эндпоинт POST .../equipment-categories для
  // этого уже существовал на backend с 15-го прохода, просто не был вызван
  // отсюда.
  const [newCatName, setNewCatName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  // Сортировка списка (16-й проход, п.4/5 обзора) — тот же idiom
  // sortable/sort-arrow, что и в главной таблице оборудования ниже по файлу.
  // "custom" (двадцатый проход, п.1 обзора) — ручной порядок (поле position
  // на backend), в этом режиме доступно перетаскивание строк; по умолчанию
  // список открывается именно в нём, так как это порядок, который видит
  // пользователь везде в приложении (фильтры, выпадающие списки).
  const [catSort, setCatSort] = useState<{ key: "custom" | "name" | "count"; dir: "asc" | "desc" }>({
    key: "custom",
    dir: "asc",
  });
  const [dragCatId, setDragCatId] = useState<string | null>(null);
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
      setNewCatName("");
      setAddError(null);
    }
  }, [open]);

  async function submitNewCategory() {
    const value = newCatName.trim();
    if (!value) {
      setAddError("Название не может быть пустым");
      return;
    }
    if (categories.some((c) => c.name.toLowerCase() === value.toLowerCase())) {
      setAddError("Такая категория уже есть в справочнике");
      return;
    }
    setAddBusy(true);
    setAddError(null);
    try {
      await api.post(`/businesses/${businessId}/equipment-categories`, { name: value });
      setNewCatName("");
      onChanged();
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : "Не удалось добавить категорию");
    } finally {
      setAddBusy(false);
    }
  }

  function toggleCatSort(key: "custom" | "name" | "count") {
    if (key === "custom") {
      setCatSort({ key, dir: "asc" });
      return;
    }
    setCatSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  }
  // В режиме "custom" порядок уже пришёл с backend отсортированным по
  // position (см. GET .../equipment-categories) — переупорядочивать на
  // клиенте не нужно, это и есть тот порядок, который двигает drag'n'drop.
  const sortedCategories =
    catSort.key === "custom"
      ? categories
      : [...categories].sort((a, b) => {
          const dir = catSort.dir === "desc" ? -1 : 1;
          if (catSort.key === "count") return (a.equipment_count - b.equipment_count) * dir;
          return a.name.localeCompare(b.name, "ru") * dir;
        });

  async function submitCatReorder(order: string[]) {
    setReorderBusy(true);
    try {
      await api.post(`/businesses/${businessId}/equipment-categories/reorder`, { order });
      onChanged();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось изменить порядок категорий");
    } finally {
      setReorderBusy(false);
    }
  }

  function handleCatDrop(targetId: string) {
    const dragged = dragCatId;
    setDragCatId(null);
    if (!dragged || dragged === targetId) return;
    const ids = categories.map((c) => c.id);
    const from = ids.indexOf(dragged);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragged);
    void submitCatReorder(ids);
  }

  function startRename(c: EquipmentCategory) {
    setRenamingId(c.id);
    setRenameValue(c.name);
    setRowError((prev) => ({ ...prev, [c.id]: "" }));
  }

  async function submitRename(c: EquipmentCategory) {
    const value = renameValue.trim();
    if (!value) {
      setRowError((prev) => ({ ...prev, [c.id]: "Название не может быть пустым" }));
      return;
    }
    if (value === c.name) {
      setRenamingId(null);
      return;
    }
    setBusyId(c.id);
    try {
      await api.patch(`/businesses/${businessId}/equipment-categories/${c.id}`, { name: value });
      setRenamingId(null);
      onChanged();
    } catch (err) {
      setRowError((prev) => ({ ...prev, [c.id]: err instanceof ApiError ? err.message : "Не удалось переименовать" }));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(c: EquipmentCategory) {
    if (c.equipment_count > 0) {
      notify(
        `Нельзя удалить: категорию «${c.name}» использует ${c.equipment_count} ` +
          `${c.equipment_count === 1 ? "позиция" : "позиций"} оборудования. Сначала перенесите их в другую категорию.`
      );
      return;
    }
    if (!(await confirm(`Категория «${c.name}» будет удалена безвозвратно.`, { danger: true }))) return;
    setBusyId(c.id);
    try {
      await api.delete(`/businesses/${businessId}/equipment-categories/${c.id}`);
      onChanged();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось удалить категорию");
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
        // Клик по затемнённому фону закрывает модалку — тот же идиом
        // click-outside-to-close, что и у формы добавления оборудования
        // (16-й проход, п.2 обзора).
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-head">
        <h3>Категории оборудования</h3>
        <button type="button" className="icon-btn" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="modal-body">
        <div className="inline-form" style={{ marginBottom: "14px" }}>
          <input
            value={newCatName}
            onChange={(e) => {
              setNewCatName(e.target.value);
              setAddError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submitNewCategory();
              }
            }}
            placeholder="Новая категория…"
            disabled={addBusy}
            style={{ flex: 1 }}
          />
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void submitNewCategory()} disabled={addBusy}>
            {addBusy ? "Добавляем…" : "Добавить"}
          </button>
        </div>
        {addError && <div className="form-error" style={{ marginBottom: "10px" }}>{addError}</div>}
        {onSelect && categories.length > 0 && (
          <div className="field-hint" style={{ marginBottom: "10px" }}>
            Нажмите на категорию в списке, чтобы подставить её в форму.
          </div>
        )}
        {categories.length === 0 ? (
          <div className="empty-note">Справочник пуст — добавьте первую категорию выше.</div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: "360px", overflowY: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th
                    className={"sortable" + (catSort.key === "custom" ? " active" : "")}
                    title="Ручной порядок — перетащите строки за ⠿, чтобы изменить"
                    onClick={() => toggleCatSort("custom")}
                  >
                    <span className={"sort-arrow" + (catSort.key === "custom" ? "" : " sort-arrow-idle")}>
                      {catSort.key === "custom" ? "⠿" : "↕"}
                    </span>
                  </th>
                  <th className={"sortable" + (catSort.key === "name" ? " active" : "")} onClick={() => toggleCatSort("name")}>
                    Название
                    <span className={"sort-arrow" + (catSort.key === "name" ? "" : " sort-arrow-idle")}>
                      {catSort.key === "name" ? (catSort.dir === "desc" ? "▼" : "▲") : "↕"}
                    </span>
                  </th>
                  <th className={"sortable" + (catSort.key === "count" ? " active" : "")} onClick={() => toggleCatSort("count")}>
                    Позиций
                    <span className={"sort-arrow" + (catSort.key === "count" ? "" : " sort-arrow-idle")}>
                      {catSort.key === "count" ? (catSort.dir === "desc" ? "▼" : "▲") : "↕"}
                    </span>
                  </th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sortedCategories.map((c) => {
                  // Клик по строке выбирает категорию — только в select-режиме
                  // (onSelect передан) и только когда строка не в процессе
                  // переименования (иначе клик по полю ввода/кнопкам конфликтовал
                  // бы с выбором — 19-й проход, п.2 обзора).
                  const selectable = !!onSelect && renamingId !== c.id;
                  // Перетаскивание доступно только в режиме ручного порядка
                  // (иначе порядок строк на экране не совпадает с backend-
                  // позициями, и drop переставил бы не то — двадцатый проход).
                  const draggableRow = catSort.key === "custom" && !reorderBusy;
                  return (
                    <tr
                      key={c.id}
                      className={
                        (selectable ? "row-selectable " : "") + (draggableRow ? "row-draggable" : "") +
                        (dragCatId === c.id ? " dragging" : "")
                      }
                      style={selectable ? { cursor: "pointer" } : undefined}
                      title={selectable ? "Выбрать эту категорию для формы" : undefined}
                      onClick={selectable ? () => { onSelect(c.name); onClose(); } : undefined}
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
                              handleCatDrop(c.id);
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
                                e.dataTransfer.setData("text/plain", c.id);
                                e.dataTransfer.effectAllowed = "move";
                                setDragCatId(c.id);
                              }
                            : undefined
                        }
                        onDragEnd={draggableRow ? () => setDragCatId(null) : undefined}
                      >
                        <IconGrip />
                      </td>
                      <td>
                        {renamingId === c.id ? (
                          <>
                            <input
                              autoFocus
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void submitRename(c);
                                if (e.key === "Escape") setRenamingId(null);
                              }}
                              style={{ maxWidth: "220px" }}
                            />
                            {rowError[c.id] && <div className="form-error">{rowError[c.id]}</div>}
                          </>
                        ) : (
                          c.name
                        )}
                      </td>
                      <td className="mono">{c.equipment_count}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                        {renamingId === c.id ? (
                          <>
                            <button type="button" className="btn btn-sm" onClick={() => setRenamingId(null)} disabled={busyId === c.id}>
                              Отмена
                            </button>{" "}
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              onClick={() => void submitRename(c)}
                              disabled={busyId === c.id}
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
                              onClick={() => startRename(c)}
                              disabled={busyId !== null}
                            >
                              <IconEdit />
                            </button>{" "}
                            <button
                              type="button"
                              className="icon-btn"
                              title={c.equipment_count > 0 ? "Нельзя удалить: категория используется" : "Удалить"}
                              onClick={() => void handleDelete(c)}
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
