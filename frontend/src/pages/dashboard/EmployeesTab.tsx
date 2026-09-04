import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import type {
  ActivityLogEntry,
  Employee,
  EmployeeWorkload,
  Position,
  PermissionLevel,
  ResourceType,
} from "../../api/types";
import { useConfirm } from "../../components/ConfirmDialog";
import { Dropdown } from "../../components/Dropdown";
import { IconClose, IconEdit, IconHistory, IconRestore, IconTrash, IconTrendUp } from "../../lib/icons";

const RESOURCES: { key: ResourceType; label: string }[] = [
  { key: "equipment", label: "Оборудование" },
  { key: "clients", label: "Клиенты" },
  { key: "rentals", label: "Аренды" },
  { key: "finance", label: "Финансы" },
  { key: "employees", label: "Сотрудники" },
];

const LEVEL_LABEL: Record<PermissionLevel, string> = { none: "Нет доступа", view: "Просмотр", edit: "Просмотр и редактирование" };

// Человекочитаемые подписи "ресурс:действие" для общего журнала действий
// (64-й проход) — набор совпадает 1:1 со всеми log_action(...) вызовами по
// бэкенду (AuditLog пишется на каждое значимое действие уже давно, просто
// раньше нигде не читался обратно владельцу бизнеса за пределами одной
// конкретной аренды, см. RentalHistorySection.tsx). Формулировки, как и
// там, пассивные/безличные ("Аренда создана") — не нужно выбирать род
// глагола под сотрудника, автор указывается отдельной строкой ниже.
const ACTIVITY_LABELS: Record<string, string> = {
  "business:register": "Бизнес зарегистрирован",
  "user:change_password": "Пароль аккаунта изменён",
  "user:2fa_enabled": "Включена двухфакторная аутентификация",
  "user:2fa_disabled": "Отключена двухфакторная аутентификация",
  "client:create": "Клиент создан",
  "client:update": "Клиент изменён",
  "client:delete": "Клиент удалён",
  "client:restore": "Клиент восстановлен",
  "client:merge": "Клиенты объединены",
  "client:import": "Импортированы клиенты",
  "client_note:create": "Добавлена заметка о клиенте",
  "client_note:update": "Заметка о клиенте изменена",
  "client_note:delete": "Заметка о клиенте удалена",
  "client_document:create": "Загружен документ клиента",
  "client_document:delete": "Документ клиента удалён",
  "employee:invite": "Сотрудник приглашён",
  "employee:update": "Данные сотрудника изменены",
  "employee:disable": "Сотрудник отключён",
  "employee:reset_password": "Сотруднику сброшен пароль",
  "position:create": "Должность создана",
  "position:rename": "Должность переименована",
  "position:delete": "Должность удалена",
  "position:update_permissions": "Изменены права должности",
  "equipment:create": "Оборудование добавлено",
  "equipment:update": "Оборудование изменено",
  "equipment:delete": "Оборудование удалено",
  "equipment:restore": "Оборудование восстановлено",
  "equipment:import": "Импортировано оборудование",
  "equipment_category:create": "Категория оборудования создана",
  "equipment_category:rename": "Категория оборудования переименована",
  "equipment_category:delete": "Категория оборудования удалена",
  "equipment_category:reorder": "Изменён порядок категорий оборудования",
  "equipment_warehouse:create": "Склад создан",
  "equipment_warehouse:rename": "Склад переименован",
  "equipment_warehouse:delete": "Склад удалён",
  "equipment_warehouse:reorder": "Изменён порядок складов",
  "rental:create": "Аренда создана",
  "rental:issue": "Оборудование выдано",
  "rental:edit": "Аренда изменена",
  "rental:return": "Аренда закрыта (возврат)",
  "rental:return_items": "Частичный возврат позиций",
  "rental:cancel": "Аренда отменена",
  "rental:deposit_return": "Депозит отмечен возвращённым",
  "rental:deposit_return_undo": "Отметка о возврате депозита снята",
  "rental:payment": "Записан платёж",
  "rental:payment_correction": "Платёж исправлен",
  "rental_photo:create": "Загружено фото аренды",
  "rental_photo:delete": "Фото аренды удалено",
  "conversation:create": "Создана беседа",
  "message:create": "Отправлено сообщение",
  "dashboard_note:create": "Добавлена заметка на дашборд",
  "dashboard_note:update": "Заметка на дашборде изменена",
  "dashboard_note:delete": "Заметка на дашборде удалена",
};

function activityLabel(entry: ActivityLogEntry): string {
  return ACTIVITY_LABELS[`${entry.resource}:${entry.action}`] ?? `${entry.resource} · ${entry.action}`;
}

/* ---------- Редактирование сотрудника (64-й проход) ----------
   Раньше единственным способом изменить уже нанятого сотрудника было
   отключить его и пригласить заново — имя/должность после приглашения
   были неизменны из интерфейса, хотя PATCH на бэке это всегда умел.
   Здесь же — сброс временного пароля (новая возможность и на бэке тоже,
   см. EmployeeUpdate.new_password): раньше, если сотрудник не смог войти
   с временным паролем (забыл/потерял до первого входа), владелец был
   бессилен что-либо сделать. */
function EditEmployeeModal({
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

export function EmployeesTab({
  businessId,
  highlightEmployee,
  isOwner,
}: {
  businessId: string;
  // Сотрудник, к строке которого нужно проскроллить и на секунду подсветить
  // при переходе сюда по клику из блока "Команда" в сайдбаре — signal
  // инкрементируется при каждом клике (даже повторном по тому же человеку),
  // чтобы useEffect ниже срабатывал каждый раз.
  highlightEmployee?: { id: string; signal: number } | null;
  // 64-й проход — все административные действия (приглашение, редактирование,
  // отключение/включение, управление должностями, журнал действий, сводка
  // нагрузки) на бэке уже давно защищены _require_owner независимо от ACL-
  // прав на ресурс "employees" (владелец может выдать edit на "Сотрудники"
  // подчинённому, но это право регулирует только ВИДИМОСТЬ раздела, не
  // администрирование персонала — см. докстринг _require_owner в
  // positions.py). Раньше фронтенд этого не отражал: кнопки управления были
  // видны всем, кто просто мог открыть вкладку, и падали в 403 без
  // объяснения. Теперь скрываем их для всех, кроме владельца/платформенного
  // админа — как уже сделано на других вкладках (см. isOwner в
  // EquipmentTab.tsx/MessagesTab.tsx/DashboardTab.tsx).
  isOwner: boolean;
}) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showInvite, setShowInvite] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: "", name: "", position_id: "", temporary_password: "" });

  const [newPositionTitle, setNewPositionTitle] = useState("");
  const [renamingPosition, setRenamingPosition] = useState<{ id: string; value: string } | null>(null);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const [flashId, setFlashId] = useState<string | null>(null);

  // Журнал действий и сводка нагрузки (64-й проход) — только для владельца,
  // оба эндпоинта на бэке отвечают 403 кому-либо ещё, поэтому и не
  // запрашиваем их зря для остальных.
  const [activity, setActivity] = useState<ActivityLogEntry[] | null>(null);
  const [activityFilter, setActivityFilter] = useState("");
  const [workload, setWorkload] = useState<EmployeeWorkload[] | null>(null);

  useEffect(() => {
    if (!highlightEmployee || loading) return;
    const row = rowRefs.current[highlightEmployee.id];
    if (!row) return;
    row.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashId(highlightEmployee.id);
    const t = setTimeout(() => setFlashId(null), 1600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightEmployee?.signal, loading]);

  async function load() {
    setLoading(true);
    try {
      const [e, p] = await Promise.all([
        api.get<Employee[]>(`/businesses/${businessId}/employees`),
        api.get<Position[]>(`/businesses/${businessId}/positions`),
      ]);
      setEmployees(e);
      setPositions(p);
      if (isOwner) {
        api.get<EmployeeWorkload[]>(`/businesses/${businessId}/employees/workload`).then(setWorkload).catch(() => setWorkload([]));
      }
    } finally {
      setLoading(false);
    }
  }

  function loadActivity(employeeId: string) {
    if (!isOwner) return;
    const qs = employeeId ? `?employee_id=${employeeId}` : "";
    api
      .get<ActivityLogEntry[]>(`/businesses/${businessId}/employees/activity${qs}`)
      .then(setActivity)
      .catch(() => setActivity([]));
  }

  useEffect(() => {
    void load();
    if (isOwner) loadActivity("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId]);

  function positionTitle(id: string | null) {
    if (!id) return "—";
    return positions.find((p) => p.id === id)?.title ?? "—";
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/businesses/${businessId}/employees`, {
        email: inviteForm.email,
        name: inviteForm.name,
        position_id: inviteForm.position_id || null,
        temporary_password: inviteForm.temporary_password,
      });
      setInviteForm({ email: "", name: "", position_id: "", temporary_password: "" });
      setShowInvite(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось добавить сотрудника");
    }
  }

  async function handleCreatePosition(e: React.FormEvent) {
    e.preventDefault();
    if (!newPositionTitle.trim()) return;
    await api.post(`/businesses/${businessId}/positions`, { title: newPositionTitle });
    setNewPositionTitle("");
    await load();
  }

  async function handleRenamePosition(id: string, title: string) {
    if (!title.trim()) return;
    try {
      await api.patch(`/businesses/${businessId}/positions/${id}`, { title: title.trim() });
      setRenamingPosition(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось переименовать должность");
    }
  }

  async function handleDeletePosition(id: string, title: string) {
    if (
      !(await confirm(`Удалить должность «${title}»? Сотрудники на этой должности останутся без должности (без доступа к данным).`, {
        danger: true,
        confirmLabel: "Удалить",
      }))
    )
      return;
    await api.delete(`/businesses/${businessId}/positions/${id}`);
    await load();
  }

  async function handlePermissionChange(positionId: string, resource: ResourceType, level: PermissionLevel) {
    const position = positions.find((p) => p.id === positionId);
    if (!position) return;
    const updated = RESOURCES.map(({ key }) => {
      const existing = position.permissions.find((perm) => perm.resource === key);
      return { resource: key, level: key === resource ? level : existing?.level ?? "none" };
    });
    await api.put(`/businesses/${businessId}/positions/${positionId}/permissions`, { permissions: updated });
    await load();
  }

  async function handleDisableEmployee(id: string) {
    if (!(await confirm("Отключить доступ этого сотрудника?", { danger: true, confirmLabel: "Отключить" }))) return;
    await api.delete(`/businesses/${businessId}/employees/${id}`);
    await load();
  }

  async function handleReactivateEmployee(id: string) {
    await api.patch(`/businesses/${businessId}/employees/${id}`, { status: "active" });
    await load();
  }

  if (loading) return <div className="muted">Загрузка…</div>;

  return (
    <div>
      <div className="tab-toolbar">
        <h2>Сотрудники</h2>
        {isOwner && (
          <button className="btn btn-primary" onClick={() => setShowInvite((v) => !v)}>{showInvite ? "Отмена" : "+ Добавить сотрудника"}</button>
        )}
      </div>

      {showInvite && isOwner && (
        <form className="card form-grid" onSubmit={handleInvite}>
          <label>
            Имя
            <input required value={inviteForm.name} onChange={(e) => setInviteForm({ ...inviteForm, name: e.target.value })} />
          </label>
          <label>
            Email
            <input required type="email" value={inviteForm.email} onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })} />
          </label>
          <label>
            Должность
            <Dropdown
              value={inviteForm.position_id}
              onChange={(v) => setInviteForm({ ...inviteForm, position_id: v })}
              placeholder="Без должности (нет доступа к данным)"
              options={[
                { value: "", label: "Без должности (нет доступа к данным)" },
                ...positions.map((p) => ({ value: p.id, label: p.title })),
              ]}
            />
          </label>
          <label>
            Временный пароль
            <input required minLength={12} value={inviteForm.temporary_password} onChange={(e) => setInviteForm({ ...inviteForm, temporary_password: e.target.value })} />
          </label>
          <p className="muted small">Передайте сотруднику лично — рассылка по почте пока не реализована.</p>
          {error && <div className="form-error">{error}</div>}
          <button type="submit" className="btn btn-primary">Добавить</button>
        </form>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th>Имя</th>
            {isOwner && <th>Email</th>}
            <th>Должность</th>
            <th>Статус</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {employees.map((emp) => (
            <tr
              key={emp.id}
              ref={(el) => { rowRefs.current[emp.id] = el; }}
              className={flashId === emp.id ? "row-flash" : undefined}
            >
              <td>{emp.name}{emp.is_owner && <span className="badge badge-owner">владелец</span>}</td>
              {isOwner && <td className="muted">{emp.email ?? "—"}</td>}
              <td>{emp.is_owner ? "—" : positionTitle(emp.position_id)}</td>
              <td>{emp.status === "active" ? "Активен" : emp.status === "disabled" ? "Отключён" : "Приглашён"}</td>
              <td style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
                {isOwner && !emp.is_owner && (
                  <button className="btn btn-sm" onClick={() => setEditingEmployee(emp)} title="Редактировать">
                    <IconEdit />
                  </button>
                )}
                {isOwner && !emp.is_owner && emp.status !== "disabled" && (
                  <button className="btn btn-sm btn-danger-ghost" onClick={() => handleDisableEmployee(emp.id)}>Отключить</button>
                )}
                {isOwner && !emp.is_owner && emp.status === "disabled" && (
                  <button className="btn btn-sm" onClick={() => handleReactivateEmployee(emp.id)} title="Включить обратно">
                    <IconRestore /> Включить
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: "2rem" }}>Должности и права доступа</h2>
      {isOwner && (
        <form className="inline-form" onSubmit={handleCreatePosition}>
          <input placeholder="Название новой должности" value={newPositionTitle} onChange={(e) => setNewPositionTitle(e.target.value)} />
          <button type="submit" className="btn btn-primary">+ Добавить должность</button>
        </form>
      )}

      {positions.map((p) => (
        <div className="card" key={p.id} style={{ marginTop: "1rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
            {renamingPosition?.id === p.id ? (
              <form
                className="inline-form"
                style={{ flex: 1 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  handleRenamePosition(p.id, renamingPosition.value);
                }}
              >
                <input
                  autoFocus
                  value={renamingPosition.value}
                  onChange={(e) => setRenamingPosition({ id: p.id, value: e.target.value })}
                />
                <button type="submit" className="btn btn-sm btn-primary">Сохранить</button>
                <button type="button" className="btn btn-sm" onClick={() => setRenamingPosition(null)}>Отмена</button>
              </form>
            ) : (
              <>
                <h3 style={{ margin: 0 }}>{p.title}</h3>
                {isOwner && (
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button className="btn btn-sm" onClick={() => setRenamingPosition({ id: p.id, value: p.title })} title="Переименовать">
                      <IconEdit />
                    </button>
                    <button className="btn btn-sm btn-danger-ghost" onClick={() => handleDeletePosition(p.id, p.title)} title="Удалить должность">
                      <IconTrash />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
          <table className="data-table compact" style={{ marginTop: "10px" }}>
            <thead>
              <tr>
                <th>Раздел</th>
                <th>Доступ</th>
              </tr>
            </thead>
            <tbody>
              {RESOURCES.map(({ key, label }) => {
                const current = p.permissions.find((perm) => perm.resource === key)?.level ?? "none";
                return (
                  <tr key={key}>
                    <td>{label}</td>
                    <td>
                      {isOwner ? (
                        <Dropdown
                          value={current}
                          onChange={(v) => handlePermissionChange(p.id, key, v as PermissionLevel)}
                          placeholder={LEVEL_LABEL[current]}
                          options={(Object.keys(LEVEL_LABEL) as PermissionLevel[]).map((lvl) => ({
                            value: lvl,
                            label: LEVEL_LABEL[lvl],
                          }))}
                        />
                      ) : (
                        <span className="muted">{LEVEL_LABEL[current]}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      {isOwner && (
        <>
          <h2 style={{ marginTop: "2rem", display: "flex", alignItems: "center", gap: "6px" }}>
            <IconTrendUp /> Нагрузка команды
          </h2>
          {workload === null ? (
            <div className="muted">Загрузка…</div>
          ) : workload.length === 0 ? (
            <div className="empty-note">Активных сотрудников пока нет</div>
          ) : (
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>Сотрудник</th>
                  <th>Аренд оформлено</th>
                  <th>Заметок клиентам</th>
                  <th>Фото аренд загружено</th>
                </tr>
              </thead>
              <tbody>
                {workload.map((w) => (
                  <tr key={w.employee_id}>
                    <td>{w.employee_name}</td>
                    <td>{w.rentals_created}</td>
                    <td>{w.client_notes}</td>
                    <td>{w.rental_photos}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2 style={{ marginTop: "2rem", display: "flex", alignItems: "center", gap: "6px" }}>
            <IconHistory /> Журнал действий
          </h2>
          <div style={{ maxWidth: "320px", marginBottom: "10px" }}>
            <Dropdown
              value={activityFilter}
              onChange={(v) => {
                setActivityFilter(v);
                loadActivity(v);
              }}
              placeholder="Все сотрудники"
              options={[
                { value: "", label: "Все сотрудники" },
                ...employees.map((e) => ({ value: e.id, label: e.name })),
              ]}
            />
          </div>
          {activity === null ? (
            <div className="muted">Загрузка…</div>
          ) : activity.length === 0 ? (
            <div className="empty-note">Записей пока нет</div>
          ) : (
            <div className="card" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {activity.map((entry) => (
                <div key={entry.id} style={{ fontSize: "12.5px", paddingLeft: "10px", borderLeft: "2px solid var(--border)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                    <span style={{ fontWeight: 600 }}>{activityLabel(entry)}</span>
                    <span style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>
                      {new Date(entry.created_at).toLocaleDateString("ru-RU")} ·{" "}
                      {new Date(entry.created_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                  <div style={{ color: "var(--muted)", marginTop: "1px" }}>{entry.employee_name ?? "Сотрудник не определён"}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {editingEmployee && (
        <EditEmployeeModal
          businessId={businessId}
          employee={editingEmployee}
          positions={positions}
          onClose={() => setEditingEmployee(null)}
          onSaved={load}
        />
      )}

      {confirmDialog}
    </div>
  );
}
