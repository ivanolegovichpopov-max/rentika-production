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
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../../api/client";
import type { Employee, EmployeeResetPasswordResult, Position } from "../../../api/types";
import { Dropdown } from "../../../components/Dropdown";
import { IconClose } from "../../../lib/icons";
import { formatPhoneInput, initials } from "../../../lib/format";

// Тот же предохранитель, что и у логотипа бизнеса (AccountSettings.tsx) —
// своего файлового хранилища у проекта нет, фото сотрудника хранится прямо
// в столбце employees.photo_url.
const MAX_PHOTO_BYTES = 300 * 1024;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
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
    if (file.size > MAX_PHOTO_BYTES) {
      setError(`Файл слишком большой (максимум ${Math.round(MAX_PHOTO_BYTES / 1024)} КБ) — уменьшите изображение.`);
      return;
    }
    setPhotoBusy(true);
    try {
      setPhotoUrl(await readFileAsDataUrl(file));
    } catch {
      setError("Не удалось прочитать файл");
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
