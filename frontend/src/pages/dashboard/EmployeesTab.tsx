/**
 * Вкладка «Сотрудники» (64-й/65-й проходы, по итогам двух раундов
 * консультативного обзора страницы — "что должна содержать", "чего не
 * хватает"). С 65-го прохода разбита на три под-вкладки (тот же idiom
 * .segmented, что и период в FinanceTab.tsx / вкладки в
 * clients/ClientDetailPanel.tsx):
 *   - «Команда» — список сотрудников, приглашение, редактирование;
 *   - «Должности и права» — справочник должностей и ACL-матрица;
 *   - «Активность» — сводка нагрузки + общий журнал действий, оба с
 *     фильтром по периоду (тот же PRESETS-idiom, что и в FinanceTab.tsx).
 * Клик по строке сотрудника (только для владельца — то же самое множество,
 * что уже могло видеть email/журнал/нагрузку до этого прохода) открывает
 * EmployeeDetailPanel — комбинированную карточку профиль+личная
 * активность+личная нагрузка, тем же слайдовер-паттерном, что и у клиента
 * (см. clients/ClientDetailPanel.tsx, открывается через data-clickable).
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import type {
  ActivityLogEntry,
  ActivityLogPage,
  Employee,
  EmployeeWorkload,
  Position,
  PermissionLevel,
  ResourceType,
} from "../../api/types";
import { useConfirm } from "../../components/ConfirmDialog";
import { Dropdown } from "../../components/Dropdown";
import { IconEdit, IconHistory, IconRestore, IconTrash, IconTrendUp } from "../../lib/icons";
import { initials } from "../../lib/format";
import { Badge, EMPLOYEE_STATUS_META } from "../../lib/statusMeta";
import { activityDetails, activityLabel } from "./employees/activityLabels";
import { EditEmployeeModal } from "./employees/EditEmployeeModal";
import { EmployeeDetailPanel } from "./employees/EmployeeDetailPanel";

const RESOURCES: { key: ResourceType; label: string }[] = [
  { key: "equipment", label: "Оборудование" },
  { key: "clients", label: "Клиенты" },
  { key: "rentals", label: "Аренды" },
  { key: "finance", label: "Финансы" },
  { key: "employees", label: "Сотрудники" },
];

const LEVEL_LABEL: Record<PermissionLevel, string> = { none: "Нет доступа", view: "Просмотр", edit: "Просмотр и редактирование" };

const PAGE_TABS: { key: "team" | "positions" | "activity"; label: string }[] = [
  { key: "team", label: "Команда" },
  { key: "positions", label: "Должности и права" },
  { key: "activity", label: "Активность" },
];

const PERIODS: { key: "7" | "30" | "90" | "all"; label: string }[] = [
  { key: "7", label: "7 дней" },
  { key: "30", label: "30 дней" },
  { key: "90", label: "90 дней" },
  { key: "all", label: "Весь период" },
];

const ACTIVITY_PAGE_SIZE = 50;

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

  const [pageTab, setPageTab] = useState<"team" | "positions" | "activity">("team");

  const [showInvite, setShowInvite] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: "", name: "", position_id: "", temporary_password: "" });

  const [newPositionTitle, setNewPositionTitle] = useState("");
  const [renamingPosition, setRenamingPosition] = useState<{ id: string; value: string } | null>(null);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const [flashId, setFlashId] = useState<string | null>(null);

  // Карточка сотрудника (65-й проход) — открывается кликом по строке в
  // таблице «Команда», только для владельца (см. data-clickable ниже).
  const [openEmployeeId, setOpenEmployeeId] = useState<string | null>(null);

  // Журнал действий и сводка нагрузки (64-й проход, доработано 65-м —
  // период и пагинация) — только для владельца, оба эндпоинта на бэке
  // отвечают 403 кому-либо ещё, поэтому и не запрашиваем их зря для
  // остальных.
  const [period, setPeriod] = useState<"7" | "30" | "90" | "all">("30");
  const [activityItems, setActivityItems] = useState<ActivityLogEntry[] | null>(null);
  const [activityHasMore, setActivityHasMore] = useState(false);
  const [activityLoadingMore, setActivityLoadingMore] = useState(false);
  const [activityFilter, setActivityFilter] = useState("");
  const [workload, setWorkload] = useState<EmployeeWorkload[] | null>(null);

  useEffect(() => {
    if (!highlightEmployee || loading) return;
    setPageTab("team");
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

  function loadWorkload(p: "7" | "30" | "90" | "all") {
    if (!isOwner) return;
    const qs = p === "all" ? "" : `?days=${p}`;
    api
      .get<EmployeeWorkload[]>(`/businesses/${businessId}/employees/workload${qs}`)
      .then(setWorkload)
      .catch(() => setWorkload([]));
  }

  function loadActivity(employeeId: string, p: "7" | "30" | "90" | "all") {
    if (!isOwner) return;
    setActivityItems(null);
    const qs = new URLSearchParams({ limit: String(ACTIVITY_PAGE_SIZE) });
    if (employeeId) qs.set("employee_id", employeeId);
    if (p !== "all") qs.set("days", p);
    api
      .get<ActivityLogPage>(`/businesses/${businessId}/employees/activity?${qs.toString()}`)
      .then((page) => {
        setActivityItems(page.items);
        setActivityHasMore(page.has_more);
      })
      .catch(() => {
        setActivityItems([]);
        setActivityHasMore(false);
      });
  }

  async function loadMoreActivity() {
    if (!isOwner || !activityItems) return;
    setActivityLoadingMore(true);
    try {
      const qs = new URLSearchParams({ limit: String(ACTIVITY_PAGE_SIZE), offset: String(activityItems.length) });
      if (activityFilter) qs.set("employee_id", activityFilter);
      if (period !== "all") qs.set("days", period);
      const page = await api.get<ActivityLogPage>(`/businesses/${businessId}/employees/activity?${qs.toString()}`);
      setActivityItems([...activityItems, ...page.items]);
      setActivityHasMore(page.has_more);
    } finally {
      setActivityLoadingMore(false);
    }
  }

  useEffect(() => {
    void load();
    if (isOwner) {
      loadActivity("", period);
      loadWorkload(period);
    }
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
      // Сводка нагрузки (65-й проход) — свежеприглашённого сотрудника в ней
      // ещё нет (загружена ДО его появления), без обновления его карточка
      // (EmployeeDetailPanel) молча теряла бы блок «Нагрузка» целиком, пока
      // владелец не сменит период вручную.
      loadWorkload(period);
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
    loadActivity(activityFilter, period);
  }

  async function handleRenamePosition(id: string, title: string) {
    if (!title.trim()) return;
    try {
      await api.patch(`/businesses/${businessId}/positions/${id}`, { title: title.trim() });
      setRenamingPosition(null);
      await load();
      loadActivity(activityFilter, period);
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
    loadActivity(activityFilter, period);
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
    loadActivity(activityFilter, period);
  }

  async function handleDisableEmployee(id: string) {
    if (!(await confirm("Отключить доступ этого сотрудника?", { danger: true, confirmLabel: "Отключить" }))) return;
    await api.delete(`/businesses/${businessId}/employees/${id}`);
    if (openEmployeeId === id) setOpenEmployeeId(null);
    await load();
    // /workload на бэке сам исключает disabled-сотрудников (см.
    // employee_workload в employees.py) — без перезагрузки отключённый
    // только что сотрудник продолжал бы висеть строкой в таблице нагрузки
    // до следующей смены периода.
    loadWorkload(period);
    loadActivity(activityFilter, period);
  }

  async function handleReactivateEmployee(id: string) {
    await api.patch(`/businesses/${businessId}/employees/${id}`, { status: "active" });
    await load();
    loadWorkload(period);
    loadActivity(activityFilter, period);
  }

  async function saveEmployeeEdit() {
    await load();
    loadActivity(activityFilter, period);
    // Имя/должность могли измениться — обе колонки видны в таблице нагрузки
    // (employee_name) и в персональной сводке EmployeeDetailPanel.
    loadWorkload(period);
  }

  function changePeriod(p: "7" | "30" | "90" | "all") {
    setPeriod(p);
    loadActivity(activityFilter, p);
    loadWorkload(p);
  }

  function changeActivityFilter(employeeId: string) {
    setActivityFilter(employeeId);
    loadActivity(employeeId, period);
  }

  if (loading) return <div className="muted">Загрузка…</div>;

  const openEmployee = openEmployeeId ? employees.find((e) => e.id === openEmployeeId) ?? null : null;

  return (
    <div>
      <div className="tab-toolbar">
        <div className="segmented">
          {PAGE_TABS.map((t) => (
            <button key={t.key} className={pageTab === t.key ? "active" : ""} onClick={() => setPageTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        {pageTab === "team" && isOwner && (
          <button className="btn btn-primary" onClick={() => setShowInvite((v) => !v)}>{showInvite ? "Отмена" : "+ Добавить сотрудника"}</button>
        )}
      </div>

      {pageTab === "team" && (
        <>
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
                <th>Сотрудник</th>
                {isOwner && <th>Email</th>}
                <th>Должность</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {employees.map((emp) => {
                const clickable = isOwner && !emp.is_owner;
                return (
                  <tr
                    key={emp.id}
                    ref={(el) => { rowRefs.current[emp.id] = el; }}
                    className={flashId === emp.id ? "row-flash" : undefined}
                    data-clickable={clickable ? "true" : undefined}
                    onClick={clickable ? () => setOpenEmployeeId(emp.id) : undefined}
                  >
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span className={"avatar avatar-emp-" + emp.status} style={{ width: 26, height: 26, fontSize: "10.5px" }}>
                          {initials(emp.name)}
                        </span>
                        {emp.name}
                        {emp.is_owner && <span className="badge badge-owner">владелец</span>}
                      </div>
                    </td>
                    {isOwner && <td className="muted">{emp.email ?? "—"}</td>}
                    <td>{emp.is_owner ? "—" : positionTitle(emp.position_id)}</td>
                    <td><Badge meta={EMPLOYEE_STATUS_META[emp.status]} /></td>
                    <td style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }} onClick={(e) => e.stopPropagation()}>
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
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {pageTab === "positions" && (
        <>
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
        </>
      )}

      {pageTab === "activity" && isOwner && (
        <>
          <div className="segmented" style={{ marginBottom: "14px" }}>
            {PERIODS.map((p) => (
              <button key={p.key} className={period === p.key ? "active" : ""} onClick={() => changePeriod(p.key)}>
                {p.label}
              </button>
            ))}
          </div>

          <h2 style={{ display: "flex", alignItems: "center", gap: "6px" }}>
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
                {workload.map((w) => {
                  // Владелец тоже попадает в сводку нагрузки (бэк не
                  // исключает его из /workload, только disabled-сотрудников),
                  // но у его записи Employee нет ни редактирования, ни
                  // отключения (см. is_owner-гейты в таблице «Команда»
                  // выше) — карточку для него не открываем по той же причине.
                  const emp = employees.find((e) => e.id === w.employee_id);
                  const clickable = emp && !emp.is_owner;
                  return (
                    <tr
                      key={w.employee_id}
                      data-clickable={clickable ? "true" : undefined}
                      onClick={clickable ? () => setOpenEmployeeId(w.employee_id) : undefined}
                    >
                      <td>{w.employee_name}</td>
                      <td>{w.rentals_created}</td>
                      <td>{w.client_notes}</td>
                      <td>{w.rental_photos}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <h2 style={{ marginTop: "2rem", display: "flex", alignItems: "center", gap: "6px" }}>
            <IconHistory /> Журнал действий
          </h2>
          <div style={{ maxWidth: "320px", marginBottom: "10px" }}>
            <Dropdown
              value={activityFilter}
              onChange={changeActivityFilter}
              placeholder="Все сотрудники"
              options={[
                { value: "", label: "Все сотрудники" },
                ...employees.map((e) => ({ value: e.id, label: e.name })),
              ]}
            />
          </div>
          {activityItems === null ? (
            <div className="muted">Загрузка…</div>
          ) : activityItems.length === 0 ? (
            <div className="empty-note">Записей за этот период не найдено</div>
          ) : (
            <>
              <div className="card" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {activityItems.map((entry) => {
                  const details = activityDetails(entry);
                  return (
                    <div key={entry.id} style={{ fontSize: "12.5px", paddingLeft: "10px", borderLeft: "2px solid var(--border)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                        <span style={{ fontWeight: 600 }}>{activityLabel(entry)}</span>
                        <span style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>
                          {new Date(entry.created_at).toLocaleDateString("ru-RU")} ·{" "}
                          {new Date(entry.created_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                      <div style={{ color: "var(--muted)", marginTop: "1px" }}>{entry.employee_name ?? "Сотрудник не определён"}</div>
                      {details.map((line, i) => (
                        <div key={i} style={{ color: "var(--muted)", marginTop: "1px" }}>{line}</div>
                      ))}
                    </div>
                  );
                })}
              </div>
              {activityHasMore && (
                <div style={{ marginTop: "10px", textAlign: "center" }}>
                  <button className="btn btn-sm" onClick={loadMoreActivity} disabled={activityLoadingMore}>
                    {activityLoadingMore ? "Загрузка…" : "Показать ещё"}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {editingEmployee && (
        <EditEmployeeModal
          businessId={businessId}
          employee={editingEmployee}
          positions={positions}
          onClose={() => setEditingEmployee(null)}
          onSaved={saveEmployeeEdit}
        />
      )}

      {openEmployee && <div className="slideover-backdrop" onClick={() => setOpenEmployeeId(null)} />}
      {openEmployee && (
        <EmployeeDetailPanel
          businessId={businessId}
          employee={openEmployee}
          positionTitle={positionTitle(openEmployee.position_id)}
          workload={workload?.find((w) => w.employee_id === openEmployee.id)}
          onClose={() => setOpenEmployeeId(null)}
          onOpenEdit={() => {
            setEditingEmployee(openEmployee);
          }}
          onDisable={() => handleDisableEmployee(openEmployee.id)}
          onReactivate={() => handleReactivateEmployee(openEmployee.id)}
        />
      )}

      {confirmDialog}
    </div>
  );
}
