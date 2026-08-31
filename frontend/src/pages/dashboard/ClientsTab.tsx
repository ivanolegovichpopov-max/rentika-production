import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import { useData } from "../../context/DataContext";
import type { Client, Rental } from "../../api/types";
import { RATING_META, RENTAL_META, Badge, rentalDisplayStatus } from "../../lib/statusMeta";
import { money, fmtDate } from "../../lib/format";
import { IconClose, IconEdit, IconTrash } from "../../lib/icons";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { usePersistedState } from "../../lib/persist";
import { toCsv } from "../../lib/csv";

/* ============================================================
   Форма добавления/изменения клиента — двадцать четвёртый проход (обзор
   вкладки «Клиенты», п.1 обзора: раньше редактирования не было вообще,
   только создание + смена рейтинга из слайдовера). Backend уже был готов
   (PATCH .../clients/{id} принимает любое подмножество полей — см.
   ClientUpdate), не хватало только формы на фронте.
   ============================================================ */
interface ClientFormState {
  name: string;
  phone: string;
  email: string;
  doc: string;
  notes: string;
}

const EMPTY_CLIENT_FORM: ClientFormState = { name: "", phone: "", email: "", doc: "", notes: "" };

function formFromClient(c: Client): ClientFormState {
  return { name: c.name, phone: c.phone ?? "", email: c.email ?? "", doc: c.doc ?? "", notes: c.notes ?? "" };
}

function clientFormToPayload(f: ClientFormState) {
  return {
    name: f.name.trim(),
    phone: f.phone.trim() || null,
    email: f.email.trim() || null,
    doc: f.doc.trim() || null,
    notes: f.notes.trim() || null,
  };
}

/** Сравнение текущей формы с исходным состоянием — тот же смысл, что и
 * isFormDirty у формы оборудования (EquipmentTab.tsx): спрашивать
 * подтверждение закрытия только если пользователь реально что-то изменил. */
function isClientFormDirty(current: ClientFormState, initial: ClientFormState): boolean {
  return (Object.keys(current) as (keyof ClientFormState)[]).some((k) => current[k] !== initial[k]);
}

/** Модалка добавления/изменения клиента — тот же идиом `<dialog>`, что и
 * EquipmentFormModal (ref + showModal()/close() в useEffect по `open`),
 * только без ступенчатого тарифа и прочей специфики оборудования: у
 * клиента всего пять редактируемых полей. */
function ClientFormModal({
  open,
  title,
  initial,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initial: ClientFormState;
  error: string | null;
  onClose: () => void;
  onSubmit: (form: ClientFormState) => Promise<void> | void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<ClientFormState>(initial);
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { confirm: confirmDiscard, dialog: discardDialog } = useConfirm();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (open) {
      setForm(initial);
      setLocalError(null);
      const raf = requestAnimationFrame(() => nameInputRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function validateLocally(): string | null {
    if (!form.name.trim()) return "Имя/название не может состоять из одних пробелов";
    return null;
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problem = validateLocally();
    if (problem) {
      setLocalError(problem);
      return;
    }
    setLocalError(null);
    setSubmitting(true);
    try {
      await onSubmit(form);
    } finally {
      setSubmitting(false);
    }
  }

  async function requestClose() {
    if (submitting) return;
    if (isClientFormDirty(form, initial)) {
      if (!(await confirmDiscard("Несохранённые изменения будут потеряны.", { confirmLabel: "Закрыть без сохранения" })))
        return;
    }
    onClose();
  }

  return (
    <dialog
      id="modal"
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        void requestClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) void requestClose();
      }}
    >
      <form onSubmit={(e) => void handleSubmit(e)}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button type="button" className="icon-btn" onClick={() => void requestClose()} disabled={submitting}>
            <IconClose />
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>Имя / название</label>
            <input
              required
              ref={nameInputRef}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Например, Иванов Иван или ООО «Стройка»"
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label>Телефон</label>
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+7 900 000-00-00" />
            </div>
            <div className="field">
              <label>Email</label>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label>Документ (паспорт)</label>
            <input value={form.doc} onChange={(e) => setForm({ ...form, doc: e.target.value })} />
          </div>
          <div className="field">
            <label>Заметка</label>
            <textarea
              rows={3}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Что стоит помнить про этого клиента"
            />
          </div>
          {(localError || error) && <div className="form-error">{localError || error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={() => void requestClose()} disabled={submitting}>
            Отмена
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </form>
      {discardDialog}
    </dialog>
  );
}

/* ============================================================
   Фильтр по надёжности + сортировка таблицы — по образцу FILTERS/
   EQUIPMENT_SORT_COLUMNS из EquipmentTab.tsx. Рейтингов всего три и они
   закрытые (enum на backend), так что сегментированный переключатель
   подходит лучше, чем мультивыбор-дропдаун, каким сделан фильтр категорий
   у оборудования (тот нужен именно из-за открытого списка категорий).
   ============================================================ */
const RATING_FILTERS: { id: string; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "normal", label: "Надёжные" },
  { id: "watch", label: "На контроле" },
  { id: "blacklist", label: "Чёрный список" },
];

const CLIENT_SORT_COLUMNS: { key: string; label: string }[] = [
  { key: "name", label: "Имя" },
  { key: "doc", label: "Документ" },
  { key: "rating", label: "Рейтинг" },
  { key: "rentals", label: "Аренды" },
];

// Приоритет при сортировке по рейтингу — проблемные клиенты первые, тем же
// принципом, что и EQUIPMENT_STATUS_PRIORITY (overdue впереди available).
const CLIENT_RATING_PRIORITY: Record<string, number> = { blacklist: 0, watch: 1, normal: 2 };

interface ClientSort {
  key: string | null;
  dir: "asc" | "desc";
}

function clientSortValue(c: Client, key: string, rentals: Rental[]): string | number {
  if (key === "name") return c.name.toLowerCase();
  if (key === "doc") return (c.doc ?? "").toLowerCase();
  if (key === "rating") return CLIENT_RATING_PRIORITY[c.rating] ?? 99;
  if (key === "rentals") return rentals.filter((r) => r.client_id === c.id).length;
  return 0;
}

function sortClientList(list: Client[], sort: ClientSort, rentals: Rental[]): Client[] {
  if (!sort.key) return list;
  const key = sort.key;
  const dir = sort.dir === "desc" ? -1 : 1;
  return [...list].sort((a, b) => {
    const va = clientSortValue(a, key, rentals);
    const vb = clientSortValue(b, key, rentals);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return a.name.localeCompare(b.name, "ru");
  });
}

/** Есть ли у клиента незакрытая аренда (в работе или забронирована) — тот
 * же смысл и та же механика, что у equipmentHasOpenRentals в
 * EquipmentTab.tsx: определяется на фронте из уже загруженного списка
 * аренд, без отдельного запроса. "overdue" backend никогда не хранит как
 * реальный статус (см. rentalDisplayStatus) — просроченная аренда это
 * всегда status==="active" в базе, так что отдельно её проверять не нужно. */
function clientHasOpenRental(clientId: string, rentals: Rental[]): boolean {
  return rentals.some((r) => r.client_id === clientId && (r.status === "active" || r.status === "booked"));
}

/** Есть ли у клиента ПРЯМО СЕЙЧАС просроченная аренда — используется и для
 * бейджа в таблице, и для быстрого фильтра "Только с просрочкой" (24-й
 * проход, п.5 обзора: "просроченный клиент — это сигнал, который владелец
 * хочет видеть первым делом, не открывая карточку каждого"). */
function clientHasOverdueNow(clientId: string, rentals: Rental[]): boolean {
  return rentals.some((r) => r.client_id === clientId && rentalDisplayStatus(r) === "overdue");
}

/* ============================================================
   Экспорт CSV — по образцу exportEquipmentCsv (equipment/csv.ts): выгрузка
   ТЕКУЩЕГО видимого списка (с учётом поиска/фильтра рейтинга/просрочки и
   сортировки) плюс пара расчётных колонок (аренды всего/просрочено сейчас/
   выручка за всё время), которых нет в самой таблице, но которые
   пригодятся для выгрузки в бухгалтерию или для архива.
   ============================================================ */
const CLIENT_EXPORT_HEADER = [
  "name",
  "phone",
  "email",
  "doc",
  "rating",
  "notes",
  "rentals_total",
  "overdue_now",
  "lifetime_revenue",
  "created_at",
];

function exportClientsCsv(list: Client[], rentals: Rental[]) {
  const rows = list.map((c) => {
    const clientRentals = rentals.filter((r) => r.client_id === c.id);
    const overdueNow = clientRentals.filter((r) => rentalDisplayStatus(r) === "overdue").length;
    const lifetimeRevenue = clientRentals.filter((r) => r.status === "returned").reduce((s, r) => s + r.total, 0);
    return [
      c.name,
      c.phone ?? "",
      c.email ?? "",
      c.doc ?? "",
      RATING_META[c.rating].label,
      c.notes ?? "",
      clientRentals.length,
      overdueNow,
      Math.round(lifetimeRevenue),
      c.created_at.slice(0, 10),
    ];
  });
  const csv = toCsv(CLIENT_EXPORT_HEADER, rows);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }); // BOM — см. downloadImportTemplate в equipment/csv.ts
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Клиенты ${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ClientsTab({ businessId, search }: { businessId: string; search: string }) {
  const { clients, rentals, reloadClients } = useData();
  const [sort, setSort] = usePersistedState<ClientSort>(`client-sort:${businessId}`, { key: null, dir: "asc" });
  const [ratingFilter, setRatingFilter] = useState("all");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [modalMode, setModalMode] = useState<"add" | "edit" | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [openClientId, setOpenClientId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkRating, setBulkRating] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { confirm: confirmBulk, dialog: bulkConfirmDialog } = useConfirm();
  const { notify } = useToast();

  const q = search.trim().toLowerCase();
  const bySearch = clients.filter(
    (c) => !q || (c.name + " " + (c.phone ?? "") + " " + (c.email ?? "") + " " + (c.doc ?? "")).toLowerCase().includes(q)
  );
  // Счётчики на кнопках рейтинга считаются от уже применённого поиска, но НЕ
  // от самого фильтра рейтинга — тот же принцип, что и statusCounts в
  // EquipmentTab.tsx (иначе на остальных кнопках всегда было бы "0").
  const ratingCounts: Record<string, number> = { all: bySearch.length };
  for (const f of RATING_FILTERS) {
    if (f.id === "all") continue;
    ratingCounts[f.id] = bySearch.filter((c) => c.rating === f.id).length;
  }
  const byRating = bySearch.filter((c) => ratingFilter === "all" || c.rating === ratingFilter);
  const overdueNowCount = byRating.filter((c) => clientHasOverdueNow(c.id, rentals)).length;
  const filtered = overdueOnly ? byRating.filter((c) => clientHasOverdueNow(c.id, rentals)) : byRating;
  const list = sortClientList(filtered, sort, rentals);

  // Сброс выделения при смене фильтров/поиска — тот же принцип, что и в
  // EquipmentTab.tsx: иначе массовое действие могло бы применяться к
  // строкам, которые сейчас не видны на экране.
  useEffect(() => {
    setSelectedIds(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratingFilter, overdueOnly, search]);

  function toggleSort(key: string) {
    setSort((prev) => {
      if (prev.key === key) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
      return { key, dir: "asc" };
    });
  }

  function openAddModal() {
    setEditingId(null);
    setFormError(null);
    setModalMode("add");
  }

  function openEditModal(id: string) {
    setEditingId(id);
    setFormError(null);
    setModalMode("edit");
  }

  function closeFormModal() {
    setModalMode(null);
    setEditingId(null);
    setFormError(null);
  }

  async function handleSubmitForm(form: ClientFormState) {
    setFormError(null);
    try {
      if (modalMode === "edit" && editingId) {
        await api.patch(`/businesses/${businessId}/clients/${editingId}`, clientFormToPayload(form));
      } else {
        await api.post(`/businesses/${businessId}/clients`, clientFormToPayload(form));
      }
      await reloadClients();
      closeFormModal();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Не удалось сохранить клиента");
    }
  }

  /** Удаление одного клиента — используется и кнопкой в строке таблицы, и
   * слайдовером (ClientDetailPanel.onDelete). Проверка открытой аренды ДО
   * подтверждения — тот же порядок, что и в EquipmentDetailPanel.handleDelete:
   * не тратим клик пользователя на подтверждение действия, которое backend
   * всё равно отклонит. */
  async function handleDelete(id: string) {
    const client = clients.find((c) => c.id === id);
    if (clientHasOpenRental(id, rentals)) {
      notify("Нельзя удалить: у клиента есть аренда в работе или бронь. Сначала завершите её.");
      return;
    }
    if (!(await confirm(`Клиент «${client?.name ?? ""}» будет удалён безвозвратно.`, { danger: true }))) return;
    try {
      await api.delete(`/businesses/${businessId}/clients/${id}`);
      if (openClientId === id) setOpenClientId(null);
      await reloadClients();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось удалить");
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => (prev.size === list.length ? new Set() : new Set(list.map((c) => c.id))));
  }

  async function handleBulkRating() {
    if (!bulkRating || selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      const ids = [...selectedIds];
      const results = await Promise.allSettled(
        ids.map((id) => api.patch(`/businesses/${businessId}/clients/${id}`, { rating: bulkRating }))
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      await reloadClients();
      setBulkRating("");
      setSelectedIds(new Set());
      if (failed > 0) notify(`Рейтинг изменён у ${ids.length - failed} из ${ids.length}. Ошибок: ${failed}.`, "info");
    } finally {
      setBulkBusy(false);
    }
  }

  /** Массовое удаление — клиенты с открытой арендой/бронью пропускаются без
   * попытки удаления, тот же принцип, что и handleBulkDelete в
   * EquipmentTab.tsx. */
  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    const blocked = ids.filter((id) => clientHasOpenRental(id, rentals));
    const deletable = ids.filter((id) => !clientHasOpenRental(id, rentals));
    if (deletable.length === 0) {
      notify("Ни одного из выбранных клиентов нельзя удалить: у каждого есть аренда в работе или бронь.");
      return;
    }
    const message =
      blocked.length > 0
        ? `Будет безвозвратно удалено клиентов: ${deletable.length} из ${ids.length}. Остальные ${blocked.length} пропущены — у них есть аренда в работе или бронь.`
        : `Будет безвозвратно удалено клиентов: ${deletable.length}.`;
    if (!(await confirmBulk(message, { danger: true }))) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(deletable.map((id) => api.delete(`/businesses/${businessId}/clients/${id}`)));
      const failed = results.filter((r) => r.status === "rejected").length;
      await reloadClients();
      setSelectedIds(new Set());
      if (failed > 0 || blocked.length > 0) {
        notify(
          `Удалено: ${deletable.length - failed}.` +
            (failed > 0 ? ` Ошибок: ${failed}.` : "") +
            (blocked.length > 0 ? ` Пропущено (аренда в работе): ${blocked.length}.` : ""),
          "info"
        );
      }
    } finally {
      setBulkBusy(false);
    }
  }

  const editingClient = editingId ? clients.find((c) => c.id === editingId) ?? null : null;
  const formTitle = modalMode === "edit" ? "Изменить клиента" : "Новый клиент";
  const formInitial = modalMode === "edit" && editingClient ? formFromClient(editingClient) : EMPTY_CLIENT_FORM;

  return (
    <div>
      <div className="tab-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <div className="segmented">
            {RATING_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={ratingFilter === f.id ? "active" : ""}
                onClick={() => setRatingFilter(f.id)}
              >
                {f.label} ({ratingCounts[f.id] ?? 0})
              </button>
            ))}
          </div>
          <button
            type="button"
            className={"btn" + (overdueOnly ? " btn-primary" : "")}
            onClick={() => setOverdueOnly((v) => !v)}
            title="Показать только клиентов с просрочкой прямо сейчас"
          >
            Просрочка сейчас ({overdueNowCount})
          </button>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button className="btn" onClick={() => exportClientsCsv(list, rentals)} disabled={list.length === 0}>
            Экспорт CSV
          </button>
          <button className="btn btn-primary" onClick={openAddModal}>
            + Добавить
          </button>
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div className="panel" style={{ marginBottom: "10px" }}>
          <div className="panel-body" style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <strong>Выбрано: {selectedIds.size}</strong>
            <select value={bulkRating} onChange={(e) => setBulkRating(e.target.value)} style={{ maxWidth: "200px" }} disabled={bulkBusy}>
              <option value="">Изменить рейтинг…</option>
              <option value="normal">Надёжный</option>
              <option value="watch">На контроле</option>
              <option value="blacklist">Чёрный список</option>
            </select>
            <button className="btn btn-sm" disabled={!bulkRating || bulkBusy} onClick={() => void handleBulkRating()}>
              Применить
            </button>
            <button className="btn btn-sm btn-danger-ghost" disabled={bulkBusy} onClick={() => void handleBulkDelete()}>
              Удалить выбранные
            </button>
            <button className="btn btn-sm" disabled={bulkBusy} onClick={() => setSelectedIds(new Set())}>
              Снять выделение
            </button>
          </div>
        </div>
      )}

      {list.length === 0 ? (
        <div className="panel">
          <div className="panel-body">
            <div className="empty-note">Ничего не найдено{q ? ` по запросу «${search}»` : ""}.</div>
          </div>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: "1%" }}>
                  <input
                    type="checkbox"
                    checked={list.length > 0 && selectedIds.size === list.length}
                    onChange={toggleSelectAll}
                    title="Выбрать все"
                  />
                </th>
                {CLIENT_SORT_COLUMNS.map((col) => {
                  const active = sort.key === col.key;
                  return (
                    <th key={col.key} className={"sortable" + (active ? " active" : "")} onClick={() => toggleSort(col.key)}>
                      {col.label}
                      <span className={"sort-arrow" + (active ? "" : " sort-arrow-idle")}>
                        {active ? (sort.dir === "desc" ? "▼" : "▲") : "↕"}
                      </span>
                    </th>
                  );
                })}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => {
                const clientRentals = rentals.filter((r) => r.client_id === c.id);
                const activeCount = clientRentals.filter((r) => {
                  const s = rentalDisplayStatus(r);
                  return s === "active" || s === "overdue";
                }).length;
                const overdueNow = clientRentals.filter((r) => rentalDisplayStatus(r) === "overdue").length;
                return (
                  <tr key={c.id} data-clickable="true" onClick={() => setOpenClientId(c.id)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selectedIds.has(c.id)} onChange={() => toggleSelected(c.id)} />
                    </td>
                    <td>
                      <div className="cell-name">{c.name}</div>
                      <div className="cell-sub">{c.phone ?? "—"}</div>
                    </td>
                    <td>{c.doc ?? "—"}</td>
                    <td>
                      <Badge meta={RATING_META[c.rating]} />
                    </td>
                    <td>
                      {clientRentals.length} всего{activeCount > 0 ? `, ${activeCount} сейчас` : ""}
                      {overdueNow > 0 && (
                        <div style={{ marginTop: "4px" }}>
                          <Badge meta={{ label: `Просрочено × ${overdueNow}`, tone: "critical" }} />
                        </div>
                      )}
                    </td>
                    <td onClick={(e) => e.stopPropagation()} style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button type="button" className="icon-btn" title="Изменить" onClick={() => openEditModal(c.id)}>
                        <IconEdit />
                      </button>{" "}
                      <button type="button" className="icon-btn" title="Удалить" onClick={() => void handleDelete(c.id)}>
                        <IconTrash />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ClientFormModal
        open={modalMode !== null}
        title={formTitle}
        initial={formInitial}
        error={formError}
        onClose={closeFormModal}
        onSubmit={(form) => handleSubmitForm(form)}
      />

      {openClientId && <div className="slideover-backdrop" onClick={() => setOpenClientId(null)} />}
      {openClientId && (
        <ClientDetailPanel
          businessId={businessId}
          clientId={openClientId}
          onClose={() => setOpenClientId(null)}
          onEdit={(id) => {
            setOpenClientId(null);
            openEditModal(id);
          }}
          onDelete={handleDelete}
        />
      )}

      {confirmDialog}
      {bulkConfirmDialog}
    </div>
  );
}

export function ClientDetailPanel({
  businessId,
  clientId,
  onClose,
  onEdit,
  onDelete,
}: {
  businessId: string;
  clientId: string;
  onClose: () => void;
  // Необязательный — с дашборда слайдовер открывается в сокращённом
  // варианте без кнопки "Изменить" (тот же принцип, что и у onCopy в
  // EquipmentDetailPanel: полноценные действия нужны только во вкладке
  // «Клиенты», где и живёт сама форма/модалка).
  onEdit?: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { clients, rentals, equipment, reloadClients } = useData();
  const client = clients.find((c) => c.id === clientId);
  const { notify } = useToast();

  if (!client) return null;

  const history = rentals
    .filter((r) => r.client_id === clientId)
    .slice()
    .sort((a, b) => (a.start_date < b.start_date ? 1 : -1));

  const lifetimeRevenue = history.filter((r) => r.status === "returned").reduce((s, r) => s + r.total, 0);
  const lateReturns = history.filter((r) => r.status === "returned" && r.actual_return && r.actual_return > r.end_date).length;
  const currentlyOverdue = history.filter((r) => rentalDisplayStatus(r) === "overdue").length;
  const totalLate = lateReturns + currentlyOverdue;
  const depositHeld = history
    .filter((r) => {
      const s = rentalDisplayStatus(r);
      return s === "active" || s === "overdue";
    })
    .reduce((s, r) => s + r.deposit_total, 0);

  async function setRating(rating: Client["rating"]) {
    try {
      await api.patch(`/businesses/${businessId}/clients/${clientId}`, { rating });
      await reloadClients();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось изменить рейтинг");
    }
  }

  return (
    <div className="slideover">
      <div className="slideover-head">
        <div>
          <h3>{client.name}</h3>
          <div style={{ color: "var(--muted)", fontSize: "12.5px", marginTop: "2px" }}>{client.phone ?? "—"}</div>
        </div>
        <button className="icon-btn" onClick={onClose}>
          <IconClose />
        </button>
      </div>

      <div className="slideover-section">
        <h4>Надёжность</h4>
        <div style={{ marginBottom: "10px" }}>
          <Badge meta={RATING_META[client.rating]} />
        </div>
        <div className="rating-picker">
          <button
            className={"btn btn-sm" + (client.rating === "normal" ? " btn-primary" : "")}
            onClick={() => void setRating("normal")}
          >
            Надёжный
          </button>
          <button
            className={"btn btn-sm" + (client.rating === "watch" ? " btn-primary" : "")}
            onClick={() => void setRating("watch")}
          >
            На контроле
          </button>
          <button
            className={"btn btn-sm" + (client.rating === "blacklist" ? " btn-primary" : "")}
            onClick={() => void setRating("blacklist")}
          >
            Чёрный список
          </button>
        </div>
      </div>

      <div className="slideover-section">
        <h4>Показатели</h4>
        <div className="kv-grid">
          <span className="k">Выручка за всё время</span>
          <span className="mono">{money(lifetimeRevenue)}</span>
          <span className="k">Просрочек за всё время</span>
          <span className={"mono" + (totalLate > 0 ? " text-critical" : "")}>{totalLate}</span>
          <span className="k">Депозит на удержании сейчас</span>
          <span className="mono">{money(depositHeld)}</span>
        </div>
      </div>

      <div className="slideover-section">
        <h4>Контакты</h4>
        <div className="kv-grid">
          <span className="k">Email</span>
          <span>{client.email ?? "—"}</span>
          <span className="k">Документ</span>
          <span>{client.doc ?? "—"}</span>
          <span className="k">В базе с</span>
          <span>{fmtDate(client.created_at.slice(0, 10))}</span>
        </div>
      </div>

      {client.notes && (
        <div className="slideover-section">
          <h4>Заметки</h4>
          <div style={{ fontSize: "13.5px" }}>{client.notes}</div>
        </div>
      )}

      <div className="slideover-section">
        <h4>История аренд · {history.length}</h4>
        {history.length === 0 ? (
          <div className="empty-note">Ещё не сдавалось в аренду</div>
        ) : (
          history.map((r) => (
            <div className="mini-item" key={r.id}>
              <span>
                {r.items.map((it) => equipment.find((eq) => eq.id === it.equipment_id)?.name ?? "—").join(", ")} ·{" "}
                {fmtDate(r.start_date)}—{fmtDate(r.end_date)}
              </span>
              <Badge meta={RENTAL_META[rentalDisplayStatus(r)]} />
            </div>
          ))
        )}
      </div>

      <div className="slideover-section" style={{ display: "flex", gap: "8px" }}>
        {onEdit && (
          <button className="btn" onClick={() => onEdit(clientId)}>
            Изменить
          </button>
        )}
        <button
          className="btn btn-danger-ghost"
          onClick={() => {
            onDelete(clientId);
          }}
        >
          Удалить
        </button>
      </div>
    </div>
  );
}
