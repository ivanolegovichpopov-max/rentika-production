/**
 * Личные сообщения — новая функция без аналога в демо-прототипе (см.
 * app/api/routes/messaging.py про архитектуру и приватность на бэкенде).
 *
 * Два диалоговых типа — dm (1-на-1) и group (группа/канал), с полем "кто
 * кому может писать" (MessagingPermission), которое владелец переключает
 * прямо здесь же (сегмент-контрол в шапке списка диалогов, тот же приём,
 * что и у NotesPanel на дашборде).
 *
 * Обновления — лёгкий polling (без WebSocket, см. заметки проекта): список
 * диалогов обновляется каждые несколько секунд, открытый диалог — чаще,
 * пока пользователь реально смотрит в него.
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { ChatMessage, Conversation, ConversationType, DirectoryEmployee, MessagingPermission } from "../../api/types";
import { colorFromId, initials } from "../../lib/format";
import { IconClose, IconMessages, IconPlus, IconSend } from "../../lib/icons";
import { useToast } from "../../components/Toast";

const LIST_POLL_MS = 6000;
const THREAD_POLL_MS = 4000;

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

interface NewConversationModalProps {
  open: boolean;
  directory: DirectoryEmployee[];
  canCreateGroup: boolean;
  onClose: () => void;
  onCreate: (type: ConversationType, participantIds: string[], name?: string) => Promise<void>;
}

function NewConversationModal({ open, directory, canCreateGroup, onClose, onCreate }: NewConversationModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<ConversationType>("dm");
  const [selected, setSelected] = useState<string[]>([]);
  const [groupName, setGroupName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (open) {
      setTab("dm");
      setSelected([]);
      setGroupName("");
      setError(null);
    }
  }, [open]);

  function toggleSelected(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function submit() {
    setError(null);
    if (tab === "dm") {
      if (selected.length !== 1) {
        setError("Выберите одного собеседника");
        return;
      }
    } else {
      if (!groupName.trim()) {
        setError("Введите название группы");
        return;
      }
      if (selected.length === 0) {
        setError("Добавьте хотя бы одного участника");
        return;
      }
    }
    setBusy(true);
    try {
      await onCreate(tab, selected, tab === "group" ? groupName.trim() : undefined);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось создать диалог");
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog id="modal" ref={ref} onClose={onClose} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-head">
        <h3>Новый диалог</h3>
        <button type="button" className="icon-btn" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="modal-body">
        {canCreateGroup && (
          <div className="segmented segmented-sm" style={{ marginBottom: 14 }}>
            <button type="button" className={tab === "dm" ? "active" : ""} onClick={() => setTab("dm")}>
              Личное сообщение
            </button>
            <button type="button" className={tab === "group" ? "active" : ""} onClick={() => setTab("group")}>
              Группа
            </button>
          </div>
        )}

        {tab === "group" && (
          <div className="field" style={{ marginBottom: 12 }}>
            <label>Название группы</label>
            <input value={groupName} maxLength={255} onChange={(e) => setGroupName(e.target.value)} placeholder="Например, «Смена А»" />
          </div>
        )}

        <div className="field">
          <label>{tab === "dm" ? "Собеседник" : "Участники"}</label>
          {directory.length === 0 ? (
            <div className="empty-note">Пока некому написать — доступных собеседников нет.</div>
          ) : (
            <div className="directory-list">
              {directory.map((e) => {
                const isSelected = selected.includes(e.id);
                return (
                  <button
                    type="button"
                    key={e.id}
                    className={"directory-row" + (isSelected ? " selected" : "")}
                    onClick={() => (tab === "dm" ? setSelected([e.id]) : toggleSelected(e.id))}
                  >
                    <span className="avatar" style={{ background: colorFromId(e.id) }}>
                      {initials(e.name)}
                    </span>
                    <span className="directory-name">
                      {e.name}
                      {e.is_owner && <span className="hint"> · владелец</span>}
                    </span>
                    {isSelected && <span className="directory-check">✓</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {error && <div className="form-error">{error}</div>}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn" onClick={onClose}>
          Отмена
        </button>
        <button type="button" className="btn btn-primary" disabled={busy || directory.length === 0} onClick={() => void submit()}>
          Создать
        </button>
      </div>
    </dialog>
  );
}

export function MessagesTab({
  businessId,
  isOwner,
  messagingPermission,
  onMessagingPermissionChange,
  onUnreadTotalChange,
}: {
  businessId: string;
  isOwner: boolean;
  messagingPermission: MessagingPermission;
  onMessagingPermissionChange: (mode: MessagingPermission) => void;
  onUnreadTotalChange: (total: number) => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [threadLoaded, setThreadLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [directory, setDirectory] = useState<DirectoryEmployee[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const { notify } = useToast();

  const canCreateGroup = isOwner || messagingPermission === "everyone";

  function reloadConversations() {
    return api
      .get<Conversation[]>(`/businesses/${businessId}/conversations`)
      .then((list) => {
        setConversations(list);
        onUnreadTotalChange(list.reduce((s, c) => s + c.unread_count, 0));
      })
      .catch(() => {});
  }

  useEffect(() => {
    setConversationsLoaded(false);
    setActiveId(null);
    reloadConversations().finally(() => setConversationsLoaded(true));
    const interval = setInterval(() => void reloadConversations(), LIST_POLL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId]);

  function loadThread(id: string, opts?: { silent?: boolean }) {
    if (!opts?.silent) setThreadLoaded(false);
    return api
      .get<ChatMessage[]>(`/businesses/${businessId}/conversations/${id}/messages`)
      .then((list) => {
        setMessages(list);
        // Прочитанное сейчас пометилось на бэкенде — обнуляем локально, не
        // дожидаясь следующего polling'а списка, иначе значок непрочитанных
        // "моргнёт" обратно на секунду.
        setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, unread_count: 0 } : c)));
      })
      .catch(() => {})
      .finally(() => {
        if (!opts?.silent) setThreadLoaded(true);
      });
  }

  useEffect(() => {
    if (!activeId) return;
    void loadThread(activeId);
    const interval = setInterval(() => void loadThread(activeId, { silent: true }), THREAD_POLL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  useEffect(() => {
    onUnreadTotalChange(conversations.reduce((s, c) => s + c.unread_count, 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, activeId]);

  function openNewConversationModal() {
    setModalOpen(true);
    api
      .get<DirectoryEmployee[]>(`/businesses/${businessId}/messaging-directory`)
      .then(setDirectory)
      .catch(() => setDirectory([]));
  }

  async function createConversation(type: ConversationType, participantIds: string[], name?: string) {
    const conv = await api.post<Conversation>(`/businesses/${businessId}/conversations`, {
      type,
      participant_ids: participantIds,
      name,
    });
    setModalOpen(false);
    await reloadConversations();
    setActiveId(conv.id);
  }

  async function send() {
    const text = draft.trim();
    if (!text || !activeId) return;
    setSending(true);
    try {
      const created = await api.post<ChatMessage>(`/businesses/${businessId}/conversations/${activeId}/messages`, { text });
      setMessages((prev) => [...prev, created]);
      setDraft("");
      void reloadConversations();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось отправить сообщение");
    } finally {
      setSending(false);
    }
  }

  async function changeMode(mode: MessagingPermission) {
    if (mode === messagingPermission) return;
    try {
      await api.put(`/businesses/${businessId}/messaging-mode`, { mode });
      onMessagingPermissionChange(mode);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось изменить режим");
    }
  }

  const activeConversation = conversations.find((c) => c.id === activeId) ?? null;

  return (
    <div className="msg-shell">
      <div className="msg-list-pane panel">
        <div className="panel-head">
          <h2>Диалоги</h2>
          <button type="button" className="icon-btn" title="Новый диалог" onClick={openNewConversationModal}>
            <IconPlus />
          </button>
        </div>
        {isOwner && (
          <div className="panel-body" style={{ paddingTop: 0, paddingBottom: 10 }}>
            <div className="segmented segmented-sm" title="Кто кому может писать">
              <button type="button" className={messagingPermission === "owner_only" ? "active" : ""} onClick={() => void changeMode("owner_only")}>
                Только мне
              </button>
              <button type="button" className={messagingPermission === "everyone" ? "active" : ""} onClick={() => void changeMode("everyone")}>
                Пишут все всем
              </button>
            </div>
          </div>
        )}
        <div className="msg-conv-list">
          {!conversationsLoaded ? (
            <div className="empty-note" style={{ padding: "0 18px" }}>
              Загрузка…
            </div>
          ) : conversations.length === 0 ? (
            <div className="empty-note" style={{ padding: "0 18px" }}>
              Пока нет ни одного диалога — начните новый.
            </div>
          ) : (
            conversations.map((c) => (
              <button
                type="button"
                key={c.id}
                className={"conv-item" + (c.id === activeId ? " active" : "")}
                onClick={() => setActiveId(c.id)}
              >
                <span className="avatar" style={{ background: colorFromId(c.id) }}>
                  {initials(c.display_name)}
                </span>
                <span className="conv-item-body">
                  <span className="conv-item-head">
                    <span className="conv-item-name">{c.display_name}</span>
                    {c.last_message_at && <span className="conv-item-time">{fmtDay(c.last_message_at)}</span>}
                  </span>
                  <span className="conv-item-preview">{c.last_message_preview ?? "Пока нет сообщений"}</span>
                </span>
                {c.unread_count > 0 && <span className="conv-unread-badge">{c.unread_count}</span>}
              </button>
            ))
          )}
        </div>
      </div>

      <div className="msg-thread-pane panel">
        {!activeConversation ? (
          <div className="msg-thread-empty">
            <IconMessages />
            <p className="muted">Выберите диалог слева или начните новый</p>
          </div>
        ) : (
          <>
            <div className="panel-head msg-thread-head">
              <div>
                <h2>{activeConversation.display_name}</h2>
                {activeConversation.type === "group" && <span className="hint">{activeConversation.participant_count} участников</span>}
              </div>
            </div>
            <div className="msg-thread-body">
              {!threadLoaded ? (
                <div className="empty-note">Загрузка…</div>
              ) : messages.length === 0 ? (
                <div className="empty-note">Сообщений пока нет — напишите первым.</div>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className={"msg-bubble-row" + (m.is_mine ? " mine" : "")}>
                    <div className="msg-bubble">
                      {!m.is_mine && activeConversation.type === "group" && <div className="msg-bubble-author">{m.author_name}</div>}
                      <div className="msg-bubble-text">{m.text}</div>
                      <div className="msg-bubble-time">{fmtTime(m.created_at)}</div>
                    </div>
                  </div>
                ))
              )}
              <div ref={threadEndRef} />
            </div>
            <div className="msg-composer">
              <textarea
                value={draft}
                maxLength={2000}
                placeholder="Написать сообщение…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <button type="button" className="btn btn-primary icon-btn" disabled={!draft.trim() || sending} onClick={() => void send()} title="Отправить">
                <IconSend />
              </button>
            </div>
          </>
        )}
      </div>

      <NewConversationModal
        open={modalOpen}
        directory={directory}
        canCreateGroup={canCreateGroup}
        onClose={() => setModalOpen(false)}
        onCreate={createConversation}
      />
    </div>
  );
}
