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
import { useEffect, useMemo, useRef, useState } from "react";
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
import { useToast } from "../../components/Toast";
import { Dropdown } from "../../components/Dropdown";
import { IconEdit, IconGrip, IconHistory, IconRestore, IconSearch, IconTrash, IconTrendUp } from "../../lib/icons";
import { initials, pluralRu } from "../../lib/format";
import { Badge, EMPLOYEE_STATUS_META } from "../../lib/statusMeta";
import { activityDetails, activityLabel } from "./employees/activityLabels";
import { exportActivityCsv } from "./employees/csv";
import { EditEmployeeModal } from "./employees/EditEmployeeModal";
import { EmployeeDetailPanel } from "./employees/EmployeeDetailPanel";
import { EmployeeImportModal } from "./employees/EmployeeImportModal";
import { trendBadge } from "./employees/workloadTrend";

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

// Фильтр журнала по разделу (66-й проход) — action оставлен свободным текстом
// (см. поле ввода на вкладке «Активность»): у разных ресурсов действий
// слишком много (create/update/delete/rename/reorder/issue/return/cancel/…),
// выпадающий список пришлось бы либо обрезать, либо делать зависимым от
// выбранного раздела; свободный текст с примерами в подсказке проще и
// достаточно для разбора инцидентов, ради которого этот фильтр и просили.
const ACTIVITY_RESOURCE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Все разделы" },
  { value: "employee", label: "Сотрудники" },
  { value: "position", label: "Должности" },
  { value: "client", label: "Клиенты" },
  { value: "equipment", label: "Оборудование" },
  { value: "rental", label: "Аренды" },
  { value: "rental_photo", label: "Фото аренд" },
  { value: "client_note", label: "Заметки клиентов" },
  { value: "user", label: "Аккаунт" },
  { value: "business", label: "Бизнес" },
];

// "Давно не заходил" (66-й проход) — тот же смысл, что dormant-клиенты в
// ClientsTab.tsx, но по Employee.last_login_at; сотрудник, который вообще ни
// разу не входил, тоже считается "давно не заходил" (см. isDormantEmployee).
const DORMANT_LOGIN_DAYS = 30;

function isDormantEmployee(emp: Employee): boolean {
  if (emp.status !== "active") return false; // приглашённые/отключённые — отдельные статусы, не про "давно не заходил"
  if (!emp.last_login_at) return true;
  const days = (Date.now() - new Date(emp.last_login_at).getTime()) / 86400000;
  return days >= DORMANT_LOGIN_DAYS;
}

function pluralEmployees(n: number): string {
  return `${n} ${pluralRu(n, "сотрудник", "сотрудника", "сотрудников")}`;
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

  const { notify } = useToast();

  // «Команда» — поиск/фильтр/сортировка (66-й проход, "делаем всё"). Всё
  // клиентское: список сотрудников и так уже загружен целиком.
  const [teamSearch, setTeamSearch] = useState("");
  const [teamPositionFilter, setTeamPositionFilter] = useState(""); // "" — все, "none" — без должности, иначе id должности
  const [teamDormantOnly, setTeamDormantOnly] = useState(false);
  const [teamSort, setTeamSort] = useState<{ key: "name" | "status" | "created_at" | "last_login_at"; dir: "asc" | "desc" }>({
    key: "name",
    dir: "asc",
  });
  const [showImportModal, setShowImportModal] = useState(false);

  // «Должности и права» — поиск, ручной порядок карточек, копирование прав
  // при создании, обратная матрица "по сотрудникам" (66-й проход).
  const [positionSearch, setPositionSearch] = useState("");
  const [copyPermissionsFrom, setCopyPermissionsFrom] = useState("");
  const [dragPositionId, setDragPositionId] = useState<string | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  const [reverseMatrix, setReverseMatrix] = useState(false);

  // «Активность» — фильтр журнала по разделу/действию, сортировка нагрузки
  // (66-й проход).
  const [activityResource, setActivityResource] = useState("");
  const [activityAction, setActivityAction] = useState("");
  const [workloadSort, setWorkloadSort] = useState<{ key: "name" | "rentals" | "notes" | "photos"; dir: "asc" | "desc" }>({
    key: "name",
    dir: "asc",
  });

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

  function loadActivity(
    employeeId: string,
    p: "7" | "30" | "90" | "all",
    resource: string = activityResource,
    action: string = activityAction
  ) {
    if (!isOwner) return;
    setActivityItems(null);
    const qs = new URLSearchParams({ limit: String(ACTIVITY_PAGE_SIZE) });
    if (employeeId) qs.set("employee_id", employeeId);
    if (p !== "all") qs.set("days", p);
    if (resource) qs.set("resource", resource);
    if (action) qs.set("action", action);
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
      if (activityResource) qs.set("resource", activityResource);
      if (activityAction) qs.set("action", activityAction);
      const page = await api.get<ActivityLogPage>(`/businesses/${businessId}/employees/activity?${qs.toString()}`);
      setActivityItems([...activityItems, ...page.items]);
      setActivityHasMore(page.has_more);
    } finally {
      setActivityLoadingMore(false);
    }
  }

  function changeActivityResource(value: string) {
    setActivityResource(value);
    loadActivity(activityFilter, period, value, activityAction);
  }

  function changeActivityAction(value: string) {
    setActivityAction(value);
    loadActivity(activityFilter, period, activityResource, value);
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

  // Матрица прав "наоборот" — по сотрудникам, а не по должностям (66-й
  // проход, дополнительный пункт обзора). Чисто клиентское вычисление по уже
  // загруженным employees/positions — своего эндпоинта не требует. Владелец
  // — всегда "edit" на всё, независимо от должности (та же логика, что и
  // get_effective_permission на бэке).
  function employeeLevel(emp: Employee, resource: ResourceType): PermissionLevel {
    if (emp.is_owner) return "edit";
    if (!emp.position_id) return "none";
    return positions.find((p) => p.id === emp.position_id)?.permissions.find((perm) => perm.resource === resource)?.level ?? "none";
  }

  const teamPositionOptions = [
    { value: "", label: "Все должности" },
    { value: "none", label: "Без должности" },
    ...positions.map((p) => ({ value: p.id, label: p.title })),
  ];

  function toggleTeamSort(key: "name" | "status" | "created_at" | "last_login_at") {
    setTeamSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  }

  const filteredEmployees = useMemo(() => {
    const q = teamSearch.trim().toLowerCase();
    let list = employees.filter((emp) => {
      if (q && !emp.name.toLowerCase().includes(q) && !(emp.email ?? "").toLowerCase().includes(q)) return false;
      if (teamPositionFilter === "none" && emp.position_id) return false;
      if (teamPositionFilter && teamPositionFilter !== "none" && emp.position_id !== teamPositionFilter) return false;
      if (teamDormantOnly && !isDormantEmployee(emp)) return false;
      return true;
    });
    const dir = teamSort.dir === "desc" ? -1 : 1;
    list = [...list].sort((a, b) => {
      switch (teamSort.key) {
        case "status":
          return a.status.localeCompare(b.status) * dir;
        case "created_at":
          return (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) * dir;
        case "last_login_at": {
          // null ("ни разу не входил") — всегда в конце списка при сортировке
          // по убыванию (самые недавние входы первыми) и в начале при
          // возрастании, а не наравне с самой старой реальной датой.
          const av = a.last_login_at ? new Date(a.last_login_at).getTime() : null;
          const bv = b.last_login_at ? new Date(b.last_login_at).getTime() : null;
          if (av === null && bv === null) return 0;
          if (av === null) return 1;
          if (bv === null) return -1;
          return (av - bv) * dir;
        }
        default:
          return a.name.localeCompare(b.name, "ru") * dir;
      }
    });
    return list;
  }, [employees, teamSearch, teamPositionFilter, teamDormantOnly, teamSort]);

  const filteredPositions = useMemo(() => {
    const q = positionSearch.trim().toLowerCase();
    return q ? positions.filter((p) => p.title.toLowerCase().includes(q)) : positions;
  }, [positions, positionSearch]);
  const positionsDraggable = !positionSearch.trim() && !reorderBusy;

  function toggleWorkloadSort(key: "name" | "rentals" | "notes" | "photos") {
    setWorkloadSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  }

  const sortedWorkload = useMemo(() => {
    if (!workload) return null;
    const dir = workloadSort.dir === "desc" ? -1 : 1;
    return [...workload].sort((a, b) => {
      switch (workloadSort.key) {
        case "rentals":
          return (a.rentals_created - b.rentals_created) * dir;
        case "notes":
          return (a.client_notes - b.client_notes) * dir;
        case "photos":
          return (a.rental_photos - b.rental_photos) * dir;
        default:
          return a.employee_name.localeCompare(b.employee_name, "ru") * dir;
      }
    });
  }, [workload, workloadSort]);

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
    await api.post(`/businesses/${businessId}/positions`, {
      title: newPositionTitle,
      // Копирование прав с существующей должности (66-й проход) — вместо
      // того чтобы каждая новая похожая роль всегда начиналась с "чистого
      // листа" (все права none) и владелец вручную выставлял их заново.
      copy_permissions_from: copyPermissionsFrom || null,
    });
    setNewPositionTitle("");
    setCopyPermissionsFrom("");
    await load();
    loadActivity(activityFilter, period);
  }

  async function submitPositionReorder(order: string[]) {
    setReorderBusy(true);
    try {
      await api.post(`/businesses/${businessId}/positions/reorder`, { order });
      await load();
      loadActivity(activityFilter, period);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось изменить порядок должностей");
    } finally {
      setReorderBusy(false);
    }
  }

  function handlePositionDrop(targetId: string) {
    const dragged = dragPositionId;
    setDragPositionId(null);
    if (!dragged || dragged === targetId) return;
    const ids = positions.map((p) => p.id);
    const from = ids.indexOf(dragged);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragged);
    void submitPositionReorder(ids);
  }

  async function handleToggleRequire2fa(position: Position) {
    const nextValue = !position.require_2fa;
    // Оптимистичное обновление (66-й проход) — без него контролируемый
    // чекбокс визуально "откатывался" бы обратно сразу после клика: onChange
    // здесь асинхронный (await api.patch), а React пересобирает checked из
    // того же positions[], которое до ответа сервера ещё не изменилось.
    setPositions((prev) => prev.map((p) => (p.id === position.id ? { ...p, require_2fa: nextValue } : p)));
    try {
      await api.patch(`/businesses/${businessId}/positions/${position.id}/require-2fa`, { require_2fa: nextValue });
      await load();
      loadActivity(activityFilter, period);
    } catch (err) {
      setPositions((prev) => prev.map((p) => (p.id === position.id ? { ...p, require_2fa: position.require_2fa } : p)));
      notify(err instanceof ApiError ? err.message : "Не удалось изменить требование 2FA");
    }
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
          <div style={{ display: "flex", gap: "8px" }}>
            <button className="btn" onClick={() => setShowImportModal(true)}>Импорт из CSV</button>
            <button className="btn btn-primary" onClick={() => setShowInvite((v) => !v)}>{showInvite ? "Отмена" : "+ Добавить сотрудника"}</button>
          </div>
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

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", margin: "12px 0" }}>
            <div style={{ position: "relative", maxWidth: "260px", flex: "1 1 200px" }}>
              <IconSearch style={{ position: "absolute", left: "9px", top: "50%", transform: "translateY(-50%)", width: 14, height: 14, color: "var(--muted)" }} />
              <input
                style={{ paddingLeft: "28px", width: "100%" }}
                placeholder="Поиск по имени или email…"
                value={teamSearch}
                onChange={(e) => setTeamSearch(e.target.value)}
              />
            </div>
            <div style={{ minWidth: "180px" }}>
              <Dropdown value={teamPositionFilter} onChange={setTeamPositionFilter} placeholder="Все должности" options={teamPositionOptions} />
            </div>
            {isOwner && (
              <button
                className={"btn btn-sm" + (teamDormantOnly ? " btn-primary" : "")}
                onClick={() => setTeamDormantOnly((v) => !v)}
                title={`Не входил ${DORMANT_LOGIN_DAYS}+ дней или ни разу`}
              >
                Давно не заходил
              </button>
            )}
          </div>

          <table className="data-table">
            <thead>
              <tr>
                <th className="sortable" onClick={() => toggleTeamSort("name")}>
                  Сотрудник
                  <span className={"sort-arrow" + (teamSort.key === "name" ? "" : " sort-arrow-idle")}>
                    {teamSort.key === "name" ? (teamSort.dir === "desc" ? "▼" : "▲") : "↕"}
                  </span>
                </th>
                {isOwner && <th>Email</th>}
                <th>Должность</th>
                <th className="sortable" onClick={() => toggleTeamSort("status")}>
                  Статус
                  <span className={"sort-arrow" + (teamSort.key === "status" ? "" : " sort-arrow-idle")}>
                    {teamSort.key === "status" ? (teamSort.dir === "desc" ? "▼" : "▲") : "↕"}
                  </span>
                </th>
                {isOwner && (
                  <th className="sortable" onClick={() => toggleTeamSort("last_login_at")}>
                    Последний вход
                    <span className={"sort-arrow" + (teamSort.key === "last_login_at" ? "" : " sort-arrow-idle")}>
                      {teamSort.key === "last_login_at" ? (teamSort.dir === "desc" ? "▼" : "▲") : "↕"}
                    </span>
                  </th>
                )}
                <th />
              </tr>
            </thead>
            <tbody>
              {filteredEmployees.length === 0 && (
                <tr>
                  <td colSpan={isOwner ? 6 : 4} className="empty-note">Никого не найдено по текущим фильтрам</td>
                </tr>
              )}
              {filteredEmployees.map((emp) => {
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
                    {isOwner && (
                      <td className="muted">
                        {emp.last_login_at ? new Date(emp.last_login_at).toLocaleDateString("ru-RU") : "Ни разу не входил"}
                      </td>
                    )}
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
              {positions.length > 0 && (
                <div style={{ minWidth: "220px" }}>
                  <Dropdown
                    value={copyPermissionsFrom}
                    onChange={setCopyPermissionsFrom}
                    placeholder="Не копировать права"
                    options={[{ value: "", label: "Не копировать права" }, ...positions.map((p) => ({ value: p.id, label: `Как у «${p.title}»` }))]}
                  />
                </div>
              )}
              <button type="submit" className="btn btn-primary">+ Добавить должность</button>
            </form>
          )}

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", margin: "12px 0" }}>
            <div style={{ position: "relative", maxWidth: "260px", flex: "1 1 200px" }}>
              <IconSearch style={{ position: "absolute", left: "9px", top: "50%", transform: "translateY(-50%)", width: 14, height: 14, color: "var(--muted)" }} />
              <input
                style={{ paddingLeft: "28px", width: "100%" }}
                placeholder="Поиск по названию должности…"
                value={positionSearch}
                onChange={(e) => setPositionSearch(e.target.value)}
              />
            </div>
            <button className={"btn btn-sm" + (reverseMatrix ? " btn-primary" : "")} onClick={() => setReverseMatrix((v) => !v)}>
              {reverseMatrix ? "Показать по должностям" : "Показать по сотрудникам"}
            </button>
          </div>

          {reverseMatrix ? (
            // Матрица прав "наоборот" (66-й проход, дополнительный пункт
            // обзора) — что реально доступно каждому конкретному человеку,
            // не перепрыгивая между карточками должностей. Только просмотр —
            // редактирование прав по-прежнему происходит в обычном виде "по
            // должностям" ниже, чтобы не заводить два места с одной и той же
            // логикой записи.
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>Сотрудник</th>
                  <th>Должность</th>
                  {RESOURCES.map(({ key, label }) => (
                    <th key={key}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {employees.map((emp) => (
                  <tr key={emp.id}>
                    <td>{emp.name}{emp.is_owner && <span className="badge badge-owner" style={{ marginLeft: "6px" }}>владелец</span>}</td>
                    <td className="muted">{emp.is_owner ? "—" : positionTitle(emp.position_id)}</td>
                    {RESOURCES.map(({ key }) => (
                      <td key={key} className="muted">{LEVEL_LABEL[employeeLevel(emp, key)]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <>
              {filteredPositions.length === 0 && <div className="empty-note">Ничего не найдено по запросу «{positionSearch}»</div>}
              {filteredPositions.map((p) => (
                <div
                  className={"card dash-block-cell" + (dragPositionId === p.id ? " dragging" : "")}
                  key={p.id}
                  style={{ marginTop: "1rem" }}
                  onDragOver={
                    positionsDraggable
                      ? (e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          e.currentTarget.classList.add("drag-over");
                        }
                      : undefined
                  }
                  onDragLeave={positionsDraggable ? (e) => e.currentTarget.classList.remove("drag-over") : undefined}
                  onDrop={
                    positionsDraggable
                      ? (e) => {
                          e.preventDefault();
                          e.currentTarget.classList.remove("drag-over");
                          handlePositionDrop(p.id);
                        }
                      : undefined
                  }
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1, minWidth: 0 }}>
                      {isOwner && (
                        <span
                          draggable={positionsDraggable}
                          title={positionsDraggable ? "Перетащите, чтобы изменить порядок" : "Очистите поиск, чтобы перетаскивать"}
                          style={{ color: "var(--muted)", cursor: positionsDraggable ? "grab" : "not-allowed", display: "flex" }}
                          onDragStart={
                            positionsDraggable
                              ? (e) => {
                                  e.dataTransfer.setData("text/plain", p.id);
                                  e.dataTransfer.effectAllowed = "move";
                                  setDragPositionId(p.id);
                                }
                              : undefined
                          }
                          onDragEnd={positionsDraggable ? () => setDragPositionId(null) : undefined}
                        >
                          <IconGrip />
                        </span>
                      )}
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
                          <span className="badge" title="Сколько сотрудников сейчас на этой должности">{pluralEmployees(p.employee_count)}</span>
                        </>
                      )}
                    </div>
                    {renamingPosition?.id !== p.id && isOwner && (
                      <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                        <button className="btn btn-sm" onClick={() => setRenamingPosition({ id: p.id, value: p.title })} title="Переименовать">
                          <IconEdit />
                        </button>
                        <button
                          className="btn btn-sm btn-danger-ghost"
                          onClick={() => handleDeletePosition(p.id, p.title)}
                          title={p.employee_count > 0 ? "Сотрудники останутся без должности" : "Удалить должность"}
                        >
                          <IconTrash />
                        </button>
                      </div>
                    )}
                  </div>
                  {isOwner && (
                    <label style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "10px", fontSize: "12.5px" }} className="muted">
                      <input type="checkbox" checked={p.require_2fa} onChange={() => handleToggleRequire2fa(p)} />
                      Обязательная двухфакторная аутентификация для этой должности
                    </label>
                  )}
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
                  <th className="sortable" onClick={() => toggleWorkloadSort("name")}>
                    Сотрудник
                    <span className={"sort-arrow" + (workloadSort.key === "name" ? "" : " sort-arrow-idle")}>
                      {workloadSort.key === "name" ? (workloadSort.dir === "desc" ? "▼" : "▲") : "↕"}
                    </span>
                  </th>
                  <th className="sortable" onClick={() => toggleWorkloadSort("rentals")}>
                    Аренд оформлено
                    <span className={"sort-arrow" + (workloadSort.key === "rentals" ? "" : " sort-arrow-idle")}>
                      {workloadSort.key === "rentals" ? (workloadSort.dir === "desc" ? "▼" : "▲") : "↕"}
                    </span>
                  </th>
                  <th className="sortable" onClick={() => toggleWorkloadSort("notes")}>
                    Заметок клиентам
                    <span className={"sort-arrow" + (workloadSort.key === "notes" ? "" : " sort-arrow-idle")}>
                      {workloadSort.key === "notes" ? (workloadSort.dir === "desc" ? "▼" : "▲") : "↕"}
                    </span>
                  </th>
                  <th className="sortable" onClick={() => toggleWorkloadSort("photos")}>
                    Фото аренд загружено
                    <span className={"sort-arrow" + (workloadSort.key === "photos" ? "" : " sort-arrow-idle")}>
                      {workloadSort.key === "photos" ? (workloadSort.dir === "desc" ? "▼" : "▲") : "↕"}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(sortedWorkload ?? []).map((w) => {
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
                      <td>{w.rentals_created}{trendBadge(w.rentals_created, w.rentals_created_prev)}</td>
                      <td>{w.client_notes}{trendBadge(w.client_notes, w.client_notes_prev)}</td>
                      <td>{w.rental_photos}{trendBadge(w.rental_photos, w.rental_photos_prev)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <div style={{ marginTop: "2rem", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
            <h2 style={{ display: "flex", alignItems: "center", gap: "6px", margin: 0 }}>
              <IconHistory /> Журнал действий
            </h2>
            {activityItems && activityItems.length > 0 && (
              <button className="btn btn-sm" onClick={() => exportActivityCsv(activityItems, "Журнал действий")}>
                Экспорт CSV
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", margin: "10px 0" }}>
            <div style={{ maxWidth: "260px", flex: "1 1 200px" }}>
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
            <div style={{ maxWidth: "220px", flex: "1 1 180px" }}>
              <Dropdown value={activityResource} onChange={changeActivityResource} placeholder="Все разделы" options={ACTIVITY_RESOURCE_OPTIONS} />
            </div>
            <input
              style={{ maxWidth: "200px", flex: "1 1 160px" }}
              placeholder="Действие, например create"
              value={activityAction}
              onChange={(e) => changeActivityAction(e.target.value)}
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

      <EmployeeImportModal
        open={showImportModal}
        businessId={businessId}
        onClose={() => setShowImportModal(false)}
        onImported={() => {
          void load();
          loadWorkload(period);
          loadActivity(activityFilter, period);
        }}
      />

      {confirmDialog}
    </div>
  );
}
