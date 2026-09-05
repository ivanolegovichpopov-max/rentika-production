/**
 * Редактирование сотрудника (64-й проход, вынесено в отдельный модуль на
 * 65-м — теперь открывается и из таблицы «Команда», и из EmployeeDetailPanel).
 * Раньше единственным способом изменить уже нанятого сотрудника было
 * отключить его и пригласить заново — имя/должность после приглашения были
 * неизменны из интерфейса, хотя PATCH на бэке это всегда умел. Здесь же —
 * сброс временного пароля (новая возможность и на бэке тоже, см.
 * EmployeeUpdate.new_password): раньше, если сотрудник не смог войти с
 * временным паролем (забыл/потерял до первого входа), владелец был
 * бессилен что-либо сделать.
 *
 * 67-й проход (обзор карточки сотрудника — "беднее карточки клиента")
 * добавил сюда телефон, заметки владельца, фото и кнопку "Сгенерировать
 * новый пароль" (сервер сам придумывает пароль вместо владельца — см.
 * POST .../reset-password, отдельно от ручного поля "Новый пароль" ниже,
 * которое по-прежнему работает как раньше).
 *
 * Доп. проход после 67-го ("делаем всё") — загруженное фото теперь всегда
 * обрезается по центру в квадрат и уменьшается до PHOTO_OUTPUT_SIZE px
 * (см. resizeAndCropToSquare) ПЕРЕД тем, как попасть в photoUrl/на сервер:
 * раньше фото просто сохранялось как есть (только проверка размера файла),
 * так что не-квадратное фото сжималось/растягивалось только в CSS
 * (object-fit: cover) на конкретных местах показа — само сохранённое
 * изображение оставалось непредсказуемого размера и соотношения сторон.
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../../api/client";
import type { Employee, EmployeeResetPasswordResult, Position } from "../../../api/types";
import { Dropdown } from "../../../components/Dropdown";
import { IconClose } from "../../../lib/icons";
import { formatPhoneInput, initials } from "../../../lib/format";

// Свой файловый лимит теперь на ИСХОДНЫЙ файл (доп. проход после 67-го) —
// щедрее прежнего, т.к. итоговый результат всё равно ужимается до
// PHOTO_OUTPUT_SIZE px через canvas ниже; этот порог — просто защита от
// попытки скормить сюда откровенно не-фото (видео, RAW и т.п.), а не расчёт
// на то, что итоговый data:URL уложится в него без обработки.
const MAX_ORIGINAL_PHOTO_BYTES = 8 * 1024 * 1024;
// Сторона квадрата после обрезки по центру, px — тот же порядок величины,
// что и у аватаров в интерфейсе (крупнее самого крупного места показа —
// 48px в этой же модалке — с запасом под Retina-экраны).
const PHOTO_OUTPUT_SIZE = 256;

// Центрированная обрезка в квадрат + уменьшение (доп. проход после 67-го,
// п.5 "клиентский ресайз/кроп фото"): раньше загруженное фото сохранялось
// как есть, каким бы оно ни было по размеру/пропорциям — здесь же всегда
// приводится к одному и тому же квадратному формату ДО сохранения, а не
// только визуально на конкретной странице через object-fit: cover.
function resizeAndCropToSquare(file: File, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Не удалось прочитать файл"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Не удалось прочитать изображение"));
      img.onload = () => {
        const side = Math.min(img.naturalWidth, img.naturalHeight) || 1;
        const sx = (img.naturalWidth - side) / 2;
        const sy = (img.naturalHeight - side) / 2;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          // Окружение без 2D-канваса (в проекте не встречалось, но на всякий
          // случай не блокируем загрузку фото целиком) — используем исходный
          // файл как есть, тем же способом, что и до этого прохода.
          resolve(reader.result as string);
          return;
        }
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

export function EditEmployeeModal({
  businessId,
  employee,
  positions,
  onClose,
  onSaved,
}: {
  businessId: string;
  employee: Employee;
  positions: Position[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(employee.name);
  const [phone, setPhone] = useState(employee.phone ?? "");
  const [positionId, setPositionId] = useState(employee.position_id ?? "");
  const [notes, setNotes] = useState(employee.notes ?? "");
  const [photoUrl, setPhotoUrl] = useState<string | null>(employee.photo_url);
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  async function handlePhotoFile(file: File) {
    setError(null);
    if (!file.type.startsWith("image/")) {
      setError("Выберите файл изображения (PNG, JPG…)");
      return;
    }
    if (file.size > MAX_ORIGINAL_PHOTO_BYTES) {
      setError(`Файл слишком большой (максимум ${Math.round(MAX_ORIGINAL_PHOTO_BYTES / 1024 / 1024)} МБ)`);
      return;
    }
    setPhotoBusy(true);
    try {
      setPhotoUrl(await resizeAndCropToSquare(file, PHOTO_OUTPUT_SIZE));
    } catch {
      setError("Не удалось обработать изображение");
    } finally {
      setPhotoBusy(false);
      if (photoInputRef.current) photoInputRef.current.value = "";
    }
  }

  async function handleGeneratePassword() {
    setError(null);
    setGenerating(true);
    try {
      const resp = await api.post<EmployeeResetPasswordResult>(`/businesses/${businessId}/employees/${employee.id}/reset-password`);
      setGenerated(resp.temporary_password);
      setNewPassword("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сгенерировать пароль");
    } finally {
      setGenerating(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Введите имя");
      return;
    }
    if (newPassword && newPassword.length < 12) {
      setError("Новый пароль должен быть не короче 12 символов");
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/businesses/${businessId}/employees/${employee.id}`, {
        name: name.trim(),
        position_id: positionId || null,
        phone: phone.trim() || null,
        notes: notes.trim() || null,
        photo_url: photoUrl,
        ...(newPassword ? { new_password: newPassword } : {}),
      });
      onClose();
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить изменения");
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form onSubmit={handleSubmit}>
        <div className="modal-head">
          <h3>Редактировать сотрудника</h3>
          <button className="icon-btn" onClick={onClose} type="button">
            <IconClose />
          </button>
        </div>
        <div className="modal-body">
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "6px" }}>
            {photoUrl ? (
              <img src={photoUrl} alt="Фото" style={{ width: 48, height: 48, borderRadius: "50%", objectFit: "cover" }} />
            ) : (
              <span className={"avatar avatar-emp-" + employee.status} style={{ width: 48, height: 48, fontSize: "16px" }}>
                {initials(name || employee.name)}
              </span>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <input
                ref={photoInputRef}
                type="file"
                accept="image/*"
                disabled={photoBusy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handlePhotoFile(file);
                }}
              />
              {photoUrl && (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPhotoUrl(null)}>
                  Убрать фото
                </button>
              )}
            </div>
          </div>
          <div className="field">
            <label>Имя</label>
            <input required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label>Телефон</label>
            <input value={phone} onChange={(e) => setPhone(formatPhoneInput(e.target.value))} placeholder="+7 900 123-45-67" />
          </div>
          <div className="field">
            <label>Должность</label>
            <Dropdown
              value={positionId}
              onChange={setPositionId}
              placeholder="Без должности (нет доступа к данным)"
              options={[
                { value: "", label: "Без должности (нет доступа к данным)" },
                ...positions.map((p) => ({ value: p.id, label: p.title })),
              ]}
            />
          </div>
          <div className="field">
            <label>Заметки (видны только вам)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Например: испытательный срок до…, отлично работает с VIP-клиентами"
            />
          </div>
          <div className="field">
            <label>Новый временный пароль</label>
            <div style={{ display: "flex", gap: "8px" }}>
              <input
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  setGenerated(null);
                }}
                placeholder="Оставьте пустым, чтобы не менять"
                minLength={12}
                style={{ flex: 1 }}
              />
              <button type="button" className="btn btn-sm" disabled={generating} onClick={() => void handleGeneratePassword()}>
                {generating ? "Генерация…" : "Сгенерировать"}
              </button>
            </div>
            <div className="field-hint">Заполните вручную или сгенерируйте — только если сотрудник потерял доступ к своему паролю, передайте новый лично.</div>
            {generated && (
              <div className="form-note" style={{ marginTop: "6px" }}>
                Новый пароль (сохранён сразу, показывается один раз): <code className="mono">{generated}</code>
              </div>
            )}
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose} type="button">
            Отмена
          </button>
          <button className="btn btn-primary" type="submit">
            {saving ? "Сохранение…" : "Сохранить"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
