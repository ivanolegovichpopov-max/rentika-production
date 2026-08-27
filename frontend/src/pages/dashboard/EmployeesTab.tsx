import { useEffect, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { Employee, Position, PermissionLevel, ResourceType } from "../../api/types";

const RESOURCES: { key: ResourceType; label: string }[] = [
  { key: "equipment", label: "Оборудование" },
  { key: "clients", label: "Клиенты" },
  { key: "rentals", label: "Аренды" },
  { key: "finance", label: "Финансы" },
  { key: "employees", label: "Сотрудники" },
];

const LEVEL_LABEL: Record<PermissionLevel, string> = { none: "Нет доступа", view: "Просмотр", edit: "Просмотр и редактирование" };

export function EmployeesTab({ businessId }: { businessId: string }) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showInvite, setShowInvite] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: "", name: "", position_id: "", temporary_password: "" });

  const [newPositionTitle, setNewPositionTitle] = useState("");

  async function load() {
    setLoading(true);
    try {
      const [e, p] = await Promise.all([
        api.get<Employee[]>(`/businesses/${businessId}/employees`),
        api.get<Position[]>(`/businesses/${businessId}/positions`),
      ]);
      setEmployees(e);
      setPositions(p);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
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
    if (!confirm("Отключить доступ этого сотрудника?")) return;
    await api.delete(`/businesses/${businessId}/employees/${id}`);
    await load();
  }

  if (loading) return <div className="muted">Загрузка…</div>;

  return (
    <div>
      <div className="tab-toolbar">
        <h2>Сотрудники</h2>
        <button className="btn btn-primary" onClick={() => setShowInvite((v) => !v)}>{showInvite ? "Отмена" : "+ Добавить сотрудника"}</button>
      </div>

      {showInvite && (
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
            <select value={inviteForm.position_id} onChange={(e) => setInviteForm({ ...inviteForm, position_id: e.target.value })}>
              <option value="">Без должности (нет доступа к данным)</option>
              {positions.map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
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
            <th>Должность</th>
            <th>Статус</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {employees.map((emp) => (
            <tr key={emp.id}>
              <td>{emp.name}{emp.is_owner && <span className="badge badge-owner">владелец</span>}</td>
              <td>{emp.is_owner ? "—" : positionTitle(emp.position_id)}</td>
              <td>{emp.status === "active" ? "Активен" : emp.status === "disabled" ? "Отключён" : "Приглашён"}</td>
              <td>
                {!emp.is_owner && emp.status === "active" && (
                  <button className="btn btn-sm btn-danger-ghost" onClick={() => handleDisableEmployee(emp.id)}>Отключить</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: "2rem" }}>Должности и права доступа</h2>
      <form className="inline-form" onSubmit={handleCreatePosition}>
        <input placeholder="Название новой должности" value={newPositionTitle} onChange={(e) => setNewPositionTitle(e.target.value)} />
        <button type="submit" className="btn btn-primary">+ Добавить должность</button>
      </form>

      {positions.map((p) => (
        <div className="card" key={p.id} style={{ marginTop: "1rem" }}>
          <h3>{p.title}</h3>
          <table className="data-table compact">
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
                      <select value={current} onChange={(e) => handlePermissionChange(p.id, key, e.target.value as PermissionLevel)}>
                        {(Object.keys(LEVEL_LABEL) as PermissionLevel[]).map((lvl) => (
                          <option key={lvl} value={lvl}>{LEVEL_LABEL[lvl]}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
