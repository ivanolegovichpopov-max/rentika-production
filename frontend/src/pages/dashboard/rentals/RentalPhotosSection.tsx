/**
 * Фотофиксация состояния оборудования при выдаче/возврате (41-й проход) —
 * новое в RentalDetailPanel по итогам обзора вкладки "Аренды" ("Какие
 * доработки ещё реализовать?"). Тот же структурный idiom, что и
 * ClientDocumentsSection.tsx (загрузка списка по rentalId, локальный state,
 * append/remove на успехе запроса, Blob+ObjectURL вместо прямой data:-ссылки
 * — см. докстринг openClientDocument в том файле про блокировку Chrome
 * top-frame навигации на data: URL), но с двумя независимыми списками —
 * "При выдаче"/"При возврате" (RentalPhoto.stage) — и без подписи файла
 * (там это паспорт/доверенность, здесь просто фотография, подпись избыточна).
 * Показывается миниатюрами (превью 64×64), а не списком имён файлов — для
 * фотографий состояния сама картинка важнее имени файла.
 */
import { useRef, useState, useEffect } from "react";
import { api, ApiError } from "../../../api/client";
import type { RentalPhoto } from "../../../api/types";
import { fmtDate } from "../../../lib/format";
import { IconTrash } from "../../../lib/icons";
import { useConfirm } from "../../../components/ConfirmDialog";

// То же значение и обоснование, что и MAX_CLIENT_DOCUMENT_BYTES
// (clients/formHelpers.ts) — зеркалит MAX_RENTAL_PHOTO_BYTES на backend'е
// (app/api/routes/rentals.py).
const MAX_RENTAL_PHOTO_BYTES = 5 * 1024 * 1024;

function photoToBlobUrl(photo: RentalPhoto): string {
  const byteChars = atob(photo.data_base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const blob = new Blob([bytes], { type: photo.content_type });
  return URL.createObjectURL(blob);
}

function openPhoto(photo: RentalPhoto) {
  const url = photoToBlobUrl(photo);
  window.open(url, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function PhotoStageGroup({
  title,
  stage,
  photos,
  uploading,
  onUpload,
  onDelete,
}: {
  title: string;
  stage: "issue" | "return";
  photos: RentalPhoto[];
  uploading: boolean;
  onUpload: (files: FileList | null, stage: "issue" | "return") => void;
  onDelete: (photo: RentalPhoto) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div style={{ marginBottom: "12px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
        <span className="k">{title}{photos.length > 0 ? ` · ${photos.length}` : ""}</span>
        <button
          type="button"
          className="link-btn"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          + Добавить фото
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            onUpload(e.target.files, stage);
            if (fileInputRef.current) fileInputRef.current.value = "";
          }}
        />
      </div>
      {photos.length === 0 ? (
        <div className="empty-note" style={{ padding: "2px 0" }}>Фото нет</div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
          {photos.map((p) => (
            <div key={p.id} style={{ position: "relative" }} title={`${p.filename} · ${fmtDate(p.created_at.slice(0, 10))}`}>
              <img
                src={`data:${p.content_type};base64,${p.data_base64}`}
                alt={p.filename}
                onClick={() => openPhoto(p)}
                style={{
                  width: "64px",
                  height: "64px",
                  objectFit: "cover",
                  borderRadius: "8px",
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                }}
              />
              <button
                type="button"
                className="icon-btn"
                title="Удалить фото"
                onClick={() => onDelete(p)}
                style={{
                  position: "absolute",
                  top: "-6px",
                  right: "-6px",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "50%",
                  width: "22px",
                  height: "22px",
                  padding: 0,
                }}
              >
                <IconTrash />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RentalPhotosSection({ businessId, rentalId }: { businessId: string; rentalId: string }) {
  const [photos, setPhotos] = useState<RentalPhoto[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();

  useEffect(() => {
    let cancelled = false;
    setPhotos(null);
    api
      .get<RentalPhoto[]>(`/businesses/${businessId}/rentals/${rentalId}/photos`)
      .then((res) => {
        if (!cancelled) setPhotos(res);
      })
      .catch(() => {
        if (!cancelled) setPhotos([]);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, rentalId]);

  async function handleUpload(files: FileList | null, stage: "issue" | "return") {
    if (!files || files.length === 0) return;
    setError(null);
    const list = Array.from(files);
    const tooBig = list.filter((f) => f.size > MAX_RENTAL_PHOTO_BYTES);
    const toUpload = list.filter((f) => f.size <= MAX_RENTAL_PHOTO_BYTES);
    setUploading(true);
    let failed = 0;
    try {
      for (const file of toUpload) {
        try {
          const form = new FormData();
          form.append("file", file);
          form.append("stage", stage);
          const created = await api.postForm<RentalPhoto>(`/businesses/${businessId}/rentals/${rentalId}/photos`, form);
          setPhotos((prev) => [created, ...(prev ?? [])]);
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
    }
  }

  async function handleDelete(photo: RentalPhoto) {
    if (!(await confirm("Удалить это фото?", { danger: true }))) return;
    try {
      await api.delete(`/businesses/${businessId}/rentals/${rentalId}/photos/${photo.id}`);
      setPhotos((prev) => (prev ?? []).filter((p) => p.id !== photo.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось удалить фото");
    }
  }

  const issuePhotos = (photos ?? []).filter((p) => p.stage === "issue");
  const returnPhotos = (photos ?? []).filter((p) => p.stage === "return");

  return (
    <div className="slideover-section">
      <h4>Фотофиксация состояния</h4>
      {photos === null ? (
        <div className="empty-note">Загрузка…</div>
      ) : (
        <>
          <PhotoStageGroup title="При выдаче" stage="issue" photos={issuePhotos} uploading={uploading} onUpload={handleUpload} onDelete={handleDelete} />
          <PhotoStageGroup title="При возврате" stage="return" photos={returnPhotos} uploading={uploading} onUpload={handleUpload} onDelete={handleDelete} />
        </>
      )}
      {error && <div className="form-error">{error}</div>}
      {confirmDialog}
    </div>
  );
}
