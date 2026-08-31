import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { Employee, Position, PermissionLevel, ResourceType } from "../../api/types";
import { useConfirm } from "../../components/ConfirmDialog";
import { Dropdown } from "../../components/Dropdown";

const RESOURCES: { key: ResourceType; label: string }[] = [
  { key: "equipment", label: "Оборудование" },
  { key: "clients", label: "Клиенты" },
  { key: "rentals", label: "Аренды" },
  { key: "finance", label: "Финансы" },
  { key: "employees", label: "Сотрудники" },
];

const LEVEL_LABEL: Record<PermissionLevel, string> = { none: "Нет доступа", view: "Просмотр", edit: "Просмотр и редактирование" };

export function EmployeesTab({
  businessId,
  highlightEmployee,
}: {
  businessId: string;
  // Сотрудник, к строке которого нужно проскроллить и на секунду подсветить
  // при переходе сюда по клику из блока "Команда" в сайдбаре — signal
  // инкрементируется при каждом клике (даже повторном по тому же человеку),
  // чтобы useEffect ниже срабатывал каждый раз.
  highlightEmployee?: { id: string; signal: number } | null;
}) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showInvite, setShowInvite] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: "", name: "", position_id: "", temporary_password: "" });

  const [newPositionTitle, setNewPositionTitle] = useState("");
  const { confirm, dialog: confirmDialog } = useConfirm();
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const [flashId, setFlashId] = useState<string | null>(null);

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
    if (!(await confirm("Отключить доступ этого сотрудника?", { danger: true, confirmLabel: "Отключить" }))) return;
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
                      <Dropdown
                        value={current}
                        onChange={(v) => handlePermissionChange(p.id, key, v as PermissionLevel)}
                        placeholder={LEVEL_LABEL[current]}
                        options={(Object.keys(LEVEL_LABEL) as PermissionLevel[]).map((lvl) => ({
                          value: lvl,
                          label: LEVEL_LABEL[lvl],
                        }))}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      {confirmDialog}
    </div>
  );
}
