/**
 * Прикреплённые сканы/фото документов клиента — вынесена из ClientsTab.tsx в
 * отдельный модуль (38-й проход, "прибраться в коде"). 26-й проход, проф.
 * обзор, п.4: "Документ" в карточке — это раньше был только текст, а не сама
 * фотография паспорта/доверенности. Тот же структурный idiom, что и
 * ClientNotesJournal (загрузка списка по clientId, локальный state,
 * append/remove на успехе запроса), но с загрузкой файла через
 * api.postForm — тем же способом, что и CSV-импорт.
 */
import { useRef, useState, useEffect } from "react";
import { api, ApiError } from "../../../api/client";
import type { ClientDocument } from "../../../api/types";
import { fmtDate } from "../../../lib/format";
import { IconFile, IconTrash, IconEdit, IconCheck, IconClose } from "../../../lib/icons";
import { useConfirm } from "../../../components/ConfirmDialog";
import { MAX_CLIENT_DOCUMENT_BYTES } from "./formHelpers";

/** Открыть/скачать документ клиента через Blob + ObjectURL вместо прямой
 * data:-ссылки (29-й проход, п.9 обзора) — современный Chrome блокирует
 * навигацию верхнего фрейма на data: URL ("Not allowed to navigate top
 * frame to data URL"), так что клик по ссылке `href="data:…"` в реальном
 * проде у пользователя просто ничего не делал молча, без видимой ошибки.
 * Blob-URL того же ограничения не имеет. URL.revokeObjectURL — с небольшой
 * задержкой, а не сразу: сама навигация в новую вкладку асинхронна, слишком
 * ранний revoke иногда успевал "погасить" ссылку раньше, чем вкладка её
 * прочитает. */
function documentToBlobUrl(doc: ClientDocument): string {
  const byteChars = atob(doc.data_base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const blob = new Blob([bytes], { type: doc.content_type });
  return URL.createObjectURL(blob);
}

function openClientDocument(doc: ClientDocument) {
  const url = documentToBlobUrl(doc);
  window.open(url, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Явная кнопка "Скачать" (29-й проход, повторный обзор, п.11 — открытие в
 * новой вкладке не всегда очевидно как "сохранить файл", особенно для PDF;
 * нужна отдельная кнопка со скачиванием под явным именем файла). Тот же
 * Blob-URL, что и у openClientDocument, но через временный <a download>,
 * а не window.open — так браузер сохраняет файл вместо навигации. */
function downloadClientDocument(doc: ClientDocument) {
  const url = documentToBlobUrl(doc);
  const a = document.createElement("a");
  a.href = url;
  a.download = doc.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function ClientDocumentsSection({ businessId, clientId }: { businessId: string; clientId: string }) {
  const [docs, setDocs] = useState<ClientDocument[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();
  // 29-й проход, повторный обзор, п.12: подпись документа ("Разворот
  // паспорта", "Прописка") — редактируется по одному файлу за раз, id
  // редактируемого документа + черновик текста, null = ничего не редактируется.
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [savingLabel, setSavingLabel] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDocs(null);
    api
      .get<ClientDocument[]>(`/businesses/${businessId}/clients/${clientId}/documents`)
      .then((res) => {
        if (!cancelled) setDocs(res);
      })
      .catch(() => {
        if (!cancelled) setDocs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, clientId]);

  /** Загрузка сразу нескольких файлов (29-й проход, п.9 обзора: "нужно
   * прикреплять сразу несколько файлов, а не по одному") — по одному запросу
   * на файл, последовательно (не Promise.all — чтобы не заваливать backend
   * параллельными запросами при выборе сразу десятка сканов, да и порядок
   * появления в списке предсказуемее). Подпись при самой загрузке не
   * запрашиваем — при выборе сразу нескольких файлов одна общая подпись на
   * все была бы бессмысленной (нужны разные: "Разворот паспорта", "Прописка"
   * и т.п.), поэтому подпись добавляется/меняется по каждому файлу отдельно
   * после загрузки (см. handleSaveLabel ниже, повторный обзор, п.12). Один
   * неудачный файл не прерывает загрузку остальных — итоговая ошибка (если
   * была) показывается одной строкой после того, как отработали все. */
  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    const list = Array.from(files);
    const tooBig = list.filter((f) => f.size > MAX_CLIENT_DOCUMENT_BYTES);
    const toUpload = list.filter((f) => f.size <= MAX_CLIENT_DOCUMENT_BYTES);
    setUploading(true);
    let failed = 0;
    try {
      for (const file of toUpload) {
        try {
          const form = new FormData();
          form.append("file", file);
          const created = await api.postForm<ClientDocument>(`/businesses/${businessId}/clients/${clientId}/documents`, form);
          setDocs((prev) => [created, ...(prev ?? [])]);
        } catch {
          failed++;
        }
      }
      if (tooBig.length > 0 || failed > 0) {
        setError(
          [
            tooBig.length > 0 ? `Слишком большой файл (максимум 5 МБ): ${tooBig.map((f) => f.name).join(", ")}` : "",
            failed > 0 ? `Не удалось загрузить файлов: ${failed}` : "",
          ]
            .filter(Boolean)
            .join(". ")
        );
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDelete(doc: ClientDocument) {
    if (!(await confirm(`Удалить файл «${doc.filename}»?`, { danger: true }))) return;
    try {
      await api.delete(`/businesses/${businessId}/clients/${clientId}/documents/${doc.id}`);
      setDocs((prev) => (prev ?? []).filter((d) => d.id !== doc.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось удалить файл");
    }
  }

  function startEditLabel(doc: ClientDocument) {
    setEditingLabelId(doc.id);
    setLabelDraft(doc.label ?? "");
    setError(null);
  }

  async function handleSaveLabel(doc: ClientDocument) {
    setSavingLabel(true);
    try {
      const updated = await api.patch<ClientDocument>(
        `/businesses/${businessId}/clients/${clientId}/documents/${doc.id}`,
        { label: labelDraft.trim() || null }
      );
      setDocs((prev) => (prev ?? []).map((d) => (d.id === doc.id ? updated : d)));
      setEditingLabelId(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить подпись");
    } finally {
      setSavingLabel(false);
    }
  }

  return (
    <div className="slideover-section">
      <h4>Документы{docs ? ` · ${docs.length}` : ""}</h4>
      <div className="field-hint" style={{ marginBottom: "8px" }}>
        Сканы/фото документов клиента (паспорт, доверенность и т.п.) — до 5 МБ на файл, можно выбрать сразу несколько.
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        onChange={(e) => void handleFiles(e.target.files)}
        disabled={uploading}
        style={{ marginBottom: "8px" }}
      />
      {uploading && <div className="empty-note">Загружаем…</div>}
      {error && <div className="form-error">{error}</div>}
      {docs === null ? (
        <div className="empty-note">Загрузка…</div>
      ) : docs.length === 0 ? (
        <div className="empty-note">Файлов пока нет</div>
      ) : (
        docs.map((d) => (
          <div className="mini-item" key={d.id} style={{ flexDirection: "column", alignItems: "stretch", gap: "4px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
              {/* Blob + ObjectURL вместо прямой data:-ссылки — см. докстринг
                  openClientDocument выше (Chrome блокирует top-frame навигацию
                  на data: URL). */}
              <a href="#" onClick={(e) => { e.preventDefault(); openClientDocument(d); }}>
                <IconFile /> {d.filename}
              </a>
              <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ color: "var(--muted)", fontSize: "11.5px", whiteSpace: "nowrap" }}>
                  {fmtDate(d.created_at.slice(0, 10))}
                </span>
                <button
                  type="button"
                  className="link-btn"
                  title="Скачать файл"
                  onClick={() => downloadClientDocument(d)}
                  style={{ whiteSpace: "nowrap" }}
                >
                  Скачать
                </button>
                <button type="button" className="icon-btn mini-item-action" title="Удалить" onClick={() => void handleDelete(d)}>
                  <IconTrash />
                </button>
              </span>
            </div>
            {/* Подпись документа (29-й проход, повторный обзор, п.12) — чтобы
                несколько файлов не приходилось различать только по имени с
                телефона ("Разворот паспорта", "Прописка" и т.п.). */}
            {editingLabelId === d.id ? (
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <input
                  type="text"
                  value={labelDraft}
                  onChange={(e) => setLabelDraft(e.target.value)}
                  placeholder="Подпись, например «Разворот паспорта»"
                  maxLength={255}
                  autoFocus
                  disabled={savingLabel}
                  style={{ flex: 1, fontSize: "12.5px" }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSaveLabel(d);
                    if (e.key === "Escape") setEditingLabelId(null);
                  }}
                />
                <button type="button" className="icon-btn" title="Сохранить" disabled={savingLabel} onClick={() => void handleSaveLabel(d)}>
                  <IconCheck />
                </button>
                <button type="button" className="icon-btn" title="Отмена" disabled={savingLabel} onClick={() => setEditingLabelId(null)}>
                  <IconClose />
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{ fontSize: "12.5px", color: d.label ? "var(--text)" : "var(--muted)", fontStyle: d.label ? "normal" : "italic" }}>
                  {d.label || "Без подписи"}
                </span>
                <button type="button" className="icon-btn mini-item-action" title="Изменить подпись" onClick={() => startEditLabel(d)}>
                  <IconEdit />
                </button>
              </div>
            )}
          </div>
        ))
      )}
      {confirmDialog}
    </div>
  );
}
