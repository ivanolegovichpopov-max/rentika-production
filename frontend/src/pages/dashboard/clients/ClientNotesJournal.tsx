/**
 * Журнал датированных записей по клиенту — вынесен из ClientsTab.tsx в
 * отдельный модуль (38-й проход, "прибраться в коде"). 25-й проход, п.4
 * обзора — в отличие от Client.notes (одна затираемая памятка), лента с
 * автором и временем каждой записи (см. ClientNote в app/models/inventory.py).
 * Загружается отдельным запросом при открытии карточки — та же причина, что
 * и у остального содержимого слайдовера (история аренд, показатели): не
 * тащить это в общий список клиентов, который и так может быть большим.
 *
 * С 37-го прохода — уже не полностью неприкосновенна: по итогам обсуждения
 * "нет возможности управлять записями" автор может изменить текст или
 * удалить СВОЮ запись в течение короткого окна после добавления
 * (опечатался/добавил не то), не задним числом. can_edit/can_delete на
 * каждой записи считаются на backend (_note_can_modify в
 * app/api/routes/clients.py) — фронт просто следует этим флагам, не
 * дублируя логику "своя запись + окно по времени" у себя.
 */
import { useEffect, useState } from "react";
import { api, ApiError } from "../../../api/client";
import type { ClientNote } from "../../../api/types";
import { fmtDate } from "../../../lib/format";
import { IconEdit, IconTrash } from "../../../lib/icons";
import { useConfirm } from "../../../components/ConfirmDialog";

export function ClientNotesJournal({ businessId, clientId }: { businessId: string; clientId: string }) {
  const [notes, setNotes] = useState<ClientNote[] | null>(null);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Правка текста (37-й проход, продолжение — "Изменить" рядом с
  // "Удалить") — editingId=null означает "ничего не редактируется",
  // черновик текста держим отдельно от notes, чтобы не трогать список,
  // пока правка не сохранена (тот же приём, что и editingLabelId/labelDraft
  // в ClientDocumentsSection).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();

  useEffect(() => {
    let cancelled = false;
    setNotes(null);
    api
      .get<ClientNote[]>(`/businesses/${businessId}/clients/${clientId}/notes`)
      .then((res) => {
        if (!cancelled) setNotes(res);
      })
      .catch(() => {
        if (!cancelled) setNotes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, clientId]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      const created = await api.post<ClientNote>(`/businesses/${businessId}/clients/${clientId}/notes`, {
        text: text.trim(),
      });
      setNotes((prev) => [created, ...(prev ?? [])]);
      setText("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить запись");
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(note: ClientNote) {
    setError(null);
    setEditingId(note.id);
    setDraft(note.text);
  }

  async function handleSaveEdit(note: ClientNote) {
    if (!draft.trim()) return;
    setError(null);
    setSaving(true);
    try {
      const updated = await api.patch<ClientNote>(`/businesses/${businessId}/clients/${clientId}/notes/${note.id}`, {
        text: draft.trim(),
      });
      setNotes((prev) => (prev ?? []).map((n) => (n.id === note.id ? updated : n)));
      setEditingId(null);
    } catch (err) {
      // 403 сюда приходит только при гонке (окно истекло между рендером
      // списка и кликом, либо запись изменил кто-то другой) — can_edit на
      // кнопке уже отфильтровал все ожидаемые случаи заранее.
      setError(err instanceof ApiError ? err.message : "Не удалось изменить запись");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(note: ClientNote) {
    if (!(await confirm("Удалить запись из журнала? Это необратимо.", { danger: true }))) return;
    setError(null);
    setDeletingId(note.id);
    try {
      await api.delete(`/businesses/${businessId}/clients/${clientId}/notes/${note.id}`);
      setNotes((prev) => (prev ?? []).filter((n) => n.id !== note.id));
    } catch (err) {
      // 403 сюда приходит только при гонке (окно истекло между рендером
      // списка и кликом, либо запись удалил кто-то другой) — can_delete на
      // кнопке уже отфильтровал все ожидаемые случаи заранее.
      setError(err instanceof ApiError ? err.message : "Не удалось удалить запись");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="slideover-section">
      <h4>Журнал{notes ? ` · ${notes.length}` : ""}</h4>
      <form onSubmit={(e) => void handleAdd(e)} style={{ display: "flex", gap: "6px", marginBottom: "10px" }}>
        <input
          style={{ flex: 1 }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Например: звонил, спрашивал про виброплиту"
          disabled={submitting}
        />
        <button type="submit" className="btn btn-sm" disabled={submitting || !text.trim()}>
          Добавить
        </button>
      </form>
      {error && <div className="form-error">{error}</div>}
      {notes === null ? (
        <div className="empty-note">Загрузка…</div>
      ) : notes.length === 0 ? (
        <div className="empty-note">Записей пока нет</div>
      ) : (
        // journal-list — точка привязки для разделителей между записями
        // (37-й проход: "нужно чтобы записи визуально разделялись друг с
        // другом") и для .mini-item-action-hover в styles.css.
        <div className="journal-list">
          {notes.map((n) =>
            editingId === n.id ? (
              // Режим правки — целиком отдельная ветка разметки, а не
              // условный рендер кусков внутри обычной строки: тут другая
              // структура (textarea на всю ширину + кнопки Сохранить/
              // Отмена под ней), пытаться уместить оба варианта в одну
              // разметку было бы менее читаемо, чем два явных ветвления
              // (тот же приём, что и editingLabelId в ClientDocumentsSection).
              <div className="mini-item" key={n.id} style={{ alignItems: "stretch", flexDirection: "column", gap: "6px" }}>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={2}
                  maxLength={2000}
                  autoFocus
                  disabled={saving}
                  style={{ width: "100%", fontSize: "13px" }}
                />
                <div style={{ display: "flex", gap: "6px" }}>
                  <button type="button" className="btn btn-sm" disabled={saving || !draft.trim()} onClick={() => void handleSaveEdit(n)}>
                    {saving ? "Сохраняем…" : "Сохранить"}
                  </button>
                  <button type="button" className="btn btn-sm" disabled={saving} onClick={() => setEditingId(null)}>
                    Отмена
                  </button>
                </div>
              </div>
            ) : (
              <div className="mini-item" key={n.id} style={{ alignItems: "flex-start" }}>
                {/* Перенос длинного текста без пробелов (37-й проход:
                    "если добавить длинную запись — выходит за границы
                    экрана") — flex-элемент без min-width:0 по умолчанию не
                    сжимается меньше содержимого, а нередактируемая строка
                    без единого пробела (например, повторяющиеся символы)
                    не имеет точек переноса вовсе — overflowWrap: "anywhere"
                    разрешает перенос прямо посреди такого "слова", когда
                    другого выхода нет. */}
                <span style={{ flex: 1, minWidth: 0, wordBreak: "break-word", overflowWrap: "anywhere" }}>{n.text}</span>
                <span style={{ display: "flex", alignItems: "center", gap: "4px", marginLeft: "8px", flexShrink: 0 }}>
                  <span style={{ color: "var(--muted)", fontSize: "11.5px", whiteSpace: "nowrap" }}>
                    {n.employee_name ?? "—"} · {fmtDate(n.created_at.slice(0, 10))}
                  </span>
                  {/* Обе кнопки видны только когда can_edit/can_delete=true —
                      своя запись и ещё не вышло окно (либо владелец
                      бизнеса, которому можно всегда, см. комментарий у
                      компонента). */}
                  {n.can_edit && (
                    <button type="button" className="icon-btn mini-item-action" title="Изменить запись" onClick={() => startEdit(n)}>
                      <IconEdit />
                    </button>
                  )}
                  {n.can_delete && (
                    <button
                      type="button"
                      className="icon-btn mini-item-action"
                      title="Удалить запись"
                      disabled={deletingId === n.id}
                      onClick={() => void handleDelete(n)}
                    >
                      <IconTrash />
                    </button>
                  )}
                </span>
              </div>
            )
          )}
        </div>
      )}
      {confirmDialog}
    </div>
  );
}
