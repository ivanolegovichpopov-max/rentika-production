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
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../../api/client";
import type { Employee, Position } from "../../../api/types";
import { Dropdown } from "../../../components/Dropdown";
import { IconClose } from "../../../lib/icons";

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
  const [positionId, setPositionId] = useState(employee.position_id ?? "");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

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
          <div className="field">
            <label>Имя</label>
            <input required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
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
            <label>Новый временный пароль</label>
            <input
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Оставьте пустым, чтобы не менять"
              minLength={12}
            />
            <div className="field-hint">Заполните, только если сотрудник потерял доступ к своему паролю — передайте новый лично.</div>
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
