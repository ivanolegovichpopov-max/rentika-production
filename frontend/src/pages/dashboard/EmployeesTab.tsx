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
  EmployeeWorkloadTimeseries,
  EmployeeWorkloadTimeseriesPoint,
  Position,
  PermissionLevel,
  ResourceType,
} from "../../api/types";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { Dropdown } from "../../components/Dropdown";
import { IconAlert, IconCopy, IconEdit, IconGrip, IconHistory, IconMessages, IconRestore, IconSearch, IconTrash, IconTrendUp } from "../../lib/icons";
import { initials, pluralRu, positionColorStyle, POSITION_COLORS } from "../../lib/format";
import { Badge, EMPLOYEE_STATUS_META } from "../../lib/statusMeta";
import { activityDetails, activityLabel } from "./employees/activityLabels";
import { exportActivityCsv, exportEmployeesCsv, exportWorkloadCsv } from "./employees/csv";
import { EditEmployeeModal } from "./employees/EditEmployeeModal";
import { EmployeeDetailPanel } from "./employees/EmployeeDetailPanel";
import { EmployeeImportModal } from "./employees/EmployeeImportModal";
import { DEFAULT_ANOMALY_THRESHOLDS, WorkloadSparkline, trendBadge, workloadAnomaly } from "./employees/workloadTrend";

const RESOURCES: { key: ResourceType; label: string }[] = [
  { key: "equipment", label: "Оборудование" },
  { key: "clients", label: "Клиенты" },
  { key: "rentals", label: "Аренды" },
  { key: "finance", label: "Финансы" },
  { key: "employees", label: "Сотрудники" },
];

const LEVEL_LABEL: Record<PermissionLevel, string> = { none: "Нет доступа", view: "Просмотр", edit: "Просмотр и редактирование" };

// Пресеты прав (67-й проход — "пресеты прав одной кнопкой" вместо
// выставления каждого из пяти ресурсов вручную). Применяются через тот же
// PUT .../permissions, что и ручное изменение одного ресурса (см.
// handleApplyPreset) — отдельного backend-эндпоинта не требуется.
const PERMISSION_PRESETS: { key: string; label: string; levels: Partial<Record<ResourceType, PermissionLevel>> }[] = [
  { key: "none", label: "Без доступа", levels: {} },
  { key: "view_all", label: "Только просмотр", levels: { equipment: "view", clients: "view", rentals: "view", finance: "view", employees: "view" } },
  { key: "full_access", label: "Полный доступ", levels: { equipment: "edit", clients: "edit", rentals: "edit", finance: "edit", employees: "edit" } },
  {
    key: "sales_no_finance",
    label: "Продажи без финансов",
    levels: { equipment: "edit", clients: "edit", rentals: "edit", finance: "none", employees: "none" },
  },
];

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

// "Зависшее" приглашение (67-й проход) — статус "Приглашён" не подсвечивался
// никак, даже если человек неделями не подтверждал вход, хотя ровно этот
// случай стоит напомнить владельцу отдельно от "давно не заходил" (которое
// вообще не считается для ещё не принявших приглашение, см. isDormantEmployee
// выше). Employee.created_at ~ момент приглашения (строка Employee создаётся
// именно тогда, отдельного invited_at на бэке нет).
const PENDING_INVITE_DAYS = 7;

function isPendingTooLong(emp: Employee): boolean {
  if (emp.status !== "invited") return false;
  const days = (Date.now() - new Date(emp.created_at).getTime()) / 86400000;
  return days >= PENDING_INVITE_DAYS;
}

// Пресет "Критичные действия" в фильтре журнала (67-й проход) — одним
// кликом сузить журнал до действий, которые стоит проверить в первую
// очередь при разборе инцидента; бэкенд поддерживает список action через
// запятую (см. employee_activity в app/api/routes/employees.py).
const CRITICAL_ACTIONS = "delete,disable,update_permissions,update_require_2fa,reset_password,bulk_update";

// Настраиваемая чувствительность подсветки аномалий в сводке нагрузки (доп.
// проход после 67-го, п.13) — пресеты, а не свободный ввод числа: сама
// эвристика (workloadAnomaly в employees/workloadTrend.tsx) остаётся грубой
// прикидкой, а не точной аналитикой, так что три градации чувствительности
// достаточно и не требуют валидации произвольного значения от владельца.
const ANOMALY_SENSITIVITY: { key: string; label: string; growth: number; drop: number }[] = [
  { key: "low", label: "Низкая чувствительность", growth: 4, drop: 0.25 },
  { key: "normal", label: "Обычная чувствительность", growth: 2.5, drop: 0.3 },
  { key: "high", label: "Высокая чувствительность", growth: 1.8, drop: 0.5 },
];

export function EmployeesTab({
  businessId,
  highlightEmployee,
  isOwner,
  onMessageEmployee,
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
  // Открыть личный диалог с сотрудником на вкладке "Сообщения" (67-й
  // проход, "написать сообщение" из карточки сотрудника) — Dashboard.tsx
  // переключает вкладку и передаёт id дальше в MessagesTab.
  onMessageEmployee?: (employeeId: string) => void;
}) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [pageTab, setPageTab] = useState<"team" | "positions" | "activity">("team");

  const [showInvite, setShowInvite] = useState(false);
  const [inviteForm, setInviteForm] = useState({ email: "", name: "", position_id: "", temporary_password: "" });

  const [newPositionTitle, setNewPositionTitle] = useState("");
  const [newPositionColor, setNewPositionColor] = useState("");
  const [newPositionDescription, setNewPositionDescription] = useState("");
  // 67-й проход: рядом с переименованием теперь редактируются и цвет/
  // описание — одной формой, а не тремя отдельными.
  const [editingPosition, setEditingPosition] = useState<{ id: string; title: string; color: string; description: string } | null>(null);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  // Массовые действия в "Команде" (67-й проход) — набор выбранных строк +
  // состояние применения; выбор сбрасывается при смене фильтров/поиска,
  // чтобы случайно не задеть сотрудника, скрытого текущим фильтром.
  const [selectedTeamIds, setSelectedTeamIds] = useState<Set<string>>(new Set());
  const [bulkPositionId, setBulkPositionId] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  // Копирование прав на уже СУЩЕСТВУЮЩУЮ должность (67-й проход) — источник,
  // выбранный в мини-форме на конкретной карточке; ключ — id карточки, куда
  // копируем, значение — id карточки-источника.
  const [copyPermissionsTarget, setCopyPermissionsTarget] = useState<{ targetId: string; sourceId: string } | null>(null);
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
  // Дневная динамика для спарклайна в сводке нагрузки (67-й проход) — карта
  // employee_id -> дневные суммы (аренды+заметки+фото), подгружается отдельно
  // от /workload (у него нет постолбцовой разбивки по дням), по одному
  // запросу на сотрудника из уже показанной сводки (см. useEffect ниже).
  // Недоступно при периоде "весь" — сам /workload/timeseries принимает
  // только 1..90 дней.
  const [teamTrend, setTeamTrend] = useState<Record<string, number[]>>({});
  // Те же точки, но без предварительного сложения трёх метрик (доп. проход
  // после 67-го, п.12) — нужны CSV-экспорту сводки нагрузки для постолбцовой
  // разбивки по дням (см. exportWorkloadCsv), сам спарклайн по-прежнему
  // читает teamTrend выше.
  const [teamTrendPoints, setTeamTrendPoints] = useState<Record<string, EmployeeWorkloadTimeseriesPoint[]>>({});

  const { notify } = useToast();

  // «Команда» — поиск/фильтр/сортировка (66-й проход, "делаем всё"). Всё
  // клиентское: список сотрудников и так уже загружен целиком.
  const [teamSearch, setTeamSearch] = useState("");
  const [teamPositionFilter, setTeamPositionFilter] = useState(""); // "" — все, "none" — без должности, иначе id должности
  const [teamDormantOnly, setTeamDormantOnly] = useState(false);
  // "Зависшие приглашения" (доп. проход после 67-го, п.3) — отдельный чипс от
  // "Давно не заходил" выше: у ещё не принявших приглашение сотрудников
  // last_login_at всегда null, но isDormantEmployee() их сознательно не
  // считает (см. её докстринг) — здесь ровно обратный случай, только
  // "invited" и только "давно висит" (см. isPendingTooLong).
  const [teamPendingOnly, setTeamPendingOnly] = useState(false);
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
  // Поиск в обратной матрице "по сотрудникам" (доп. проход после 67-го, п.9)
  // — своё поле, отдельное от positionSearch выше (тот ищет по названию
  // должности и относится к списку карточек, не к матрице).
  const [reverseMatrixSearch, setReverseMatrixSearch] = useState("");
  // Свёрнутая мини-история изменений должности (доп. проход после 67-го,
  // п.11) — набор открытых карточек + подгруженные записи журнала по каждой
  // (лениво, по клику, отдельным запросом с фильтром resource_id).
  const [openPositionHistory, setOpenPositionHistory] = useState<Set<string>>(new Set());
  const [positionHistory, setPositionHistory] = useState<Record<string, ActivityLogEntry[]>>({});

  // «Активность» — фильтр журнала по разделу/действию, сортировка нагрузки
  // (66-й проход).
  const [activityResource, setActivityResource] = useState("");
  const [activityAction, setActivityAction] = useState("");
  const [workloadSort, setWorkloadSort] = useState<{ key: "name" | "rentals" | "notes" | "photos"; dir: "asc" | "desc" }>({
    key: "name",
    dir: "asc",
  });
  // Фильтр сводки нагрузки по должности (доп. проход после 67-го, п.14) —
  // тот же idiom значений, что и teamPositionFilter выше ("" — все, "none" —
  // без должности, иначе id).
  const [workloadPositionFilter, setWorkloadPositionFilter] = useState("");
  // Настраиваемая чувствительность подсветки аномалий (доп. проход после
  // 67-го, п.13) — см. ANOMALY_SENSITIVITY выше.
  const [anomalySensitivityKey, setAnomalySensitivityKey] = useState("normal");

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

  // Цветной бейдж должности (67-й проход) — в таблице «Команда» вместо
  // простого текста, если у должности выбран цвет (см. POSITION_COLORS в
  // lib/format.ts); без цвета — как и раньше, просто название.
  function positionBadge(id: string | null) {
    if (!id) return "—";
    const pos = positions.find((p) => p.id === id);
    if (!pos) return "—";
    if (!pos.color) return pos.title;
    return <span className="badge" style={positionColorStyle(pos.color)}>{pos.title}</span>;
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

  // Пробел в защите: должность требует обязательную 2FA, а у самого
  // аккаунта она не включена (доп. проход после 67-го, п.15). totp_enabled
  // === false — именно false, а не null/undefined ("скрыто" — но здесь
  // владелец видит вкладку целиком, так что это не должно происходить, кроме
  // разве что момента до первой загрузки).
  function position2faGap(emp: Employee): boolean {
    if (emp.is_owner || !emp.position_id) return false;
    const pos = positions.find((p) => p.id === emp.position_id);
    return !!pos?.require_2fa && emp.totp_enabled === false;
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
    // Поиск по телефону (доп. проход после 67-го, п.2) — по цифрам, без
    // учёта форматирования (+7 900 123-45-67 ищется и как "9001234567", и
    // как "900-123", и как введено полностью — formatPhoneInput в поле
    // редактирования всегда приводит номер к одному и тому же виду, но
    // владелец может искать частями без пробелов/дефисов).
    const qDigits = q.replace(/\D/g, "");
    let list = employees.filter((emp) => {
      if (q) {
        const matchesText = emp.name.toLowerCase().includes(q) || (emp.email ?? "").toLowerCase().includes(q);
        const matchesPhone = qDigits.length > 0 && (emp.phone ?? "").replace(/\D/g, "").includes(qDigits);
        if (!matchesText && !matchesPhone) return false;
      }
      if (teamPositionFilter === "none" && emp.position_id) return false;
      if (teamPositionFilter && teamPositionFilter !== "none" && emp.position_id !== teamPositionFilter) return false;
      if (teamDormantOnly && !isDormantEmployee(emp)) return false;
      if (teamPendingOnly && !isPendingTooLong(emp)) return false;
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
  }, [employees, teamSearch, teamPositionFilter, teamDormantOnly, teamPendingOnly, teamSort]);

  // Массовые действия (67-й проход) — выбор всегда сужается до того, что
  // реально видно под текущими фильтрами/поиском, иначе владелец мог бы
  // случайно применить действие к скрытому фильтром сотруднику, не видя его
  // в списке.
  useEffect(() => {
    setSelectedTeamIds((prev) => {
      const visible = new Set(filteredEmployees.map((e) => e.id));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [filteredEmployees]);

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
    // Фильтр по должности (доп. проход после 67-го, п.14) — чисто клиентский,
    // через employees (сам EmployeeWorkload должности не хранит).
    let list = workload;
    if (workloadPositionFilter) {
      list = workload.filter((w) => {
        const emp = employees.find((e) => e.id === w.employee_id);
        if (workloadPositionFilter === "none") return !!emp && !emp.position_id && !emp.is_owner;
        return emp?.position_id === workloadPositionFilter;
      });
    }
    const dir = workloadSort.dir === "desc" ? -1 : 1;
    return [...list].sort((a, b) => {
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
  }, [workload, workloadSort, workloadPositionFilter, employees]);

  // Спарклайн дневной динамики в сводке нагрузки (67-й проход) — один запрос
  // на сотрудника из текущей сводки (список обычно небольшой — это не
  // хот-путь, вкладка «Активность» открывается вручную владельцем). "Весь
  // период" не поддерживается самим /workload/timeseries (только 1..90
  // дней) — тогда спарклайн просто не показываем.
  useEffect(() => {
    if (!isOwner || !workload || period === "all") {
      setTeamTrend({});
      setTeamTrendPoints({});
      return;
    }
    let cancelled = false;
    Promise.all(
      workload.map((w) =>
        api
          .get<EmployeeWorkloadTimeseries>(`/businesses/${businessId}/employees/${w.employee_id}/workload/timeseries?days=${period}`)
          .then((res) => [w.employee_id, res.points] as const)
          .catch(() => [w.employee_id, [] as EmployeeWorkloadTimeseriesPoint[]] as const)
      )
    ).then((entries) => {
      if (cancelled) return;
      setTeamTrendPoints(Object.fromEntries(entries));
      setTeamTrend(
        Object.fromEntries(
          entries.map(([id, points]) => [id, points.map((pt) => pt.rentals_created + pt.client_notes + pt.rental_photos)])
        )
      );
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workload, period, isOwner, businessId]);

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
      // Цвет/описание (67-й проход) — необязательны уже при создании.
      color: newPositionColor || null,
      description: newPositionDescription.trim() || null,
    });
    setNewPositionTitle("");
    setCopyPermissionsFrom("");
    setNewPositionColor("");
    setNewPositionDescription("");
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
    // Подтверждение только на ВЫКЛЮЧЕНИЕ (67-й проход, "защита от
    // обнуления прав") — включить обязательную 2FA безопасно в любой
    // момент, а вот снять уже действующее требование стоит переспросить:
    // это осознанное понижение защиты, а не рутинная настройка.
    if (!nextValue) {
      const ok = await confirm(
        `Отключить обязательную двухфакторную аутентификацию для должности «${position.title}»? Сотрудники на этой должности смогут входить без второго фактора.`,
        { danger: true, confirmLabel: "Отключить" }
      );
      if (!ok) return;
    }
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

  async function handleSavePositionEdit(id: string, title: string, color: string, description: string) {
    if (!title.trim()) return;
    try {
      await api.patch(`/businesses/${businessId}/positions/${id}`, {
        title: title.trim(),
        color: color || null,
        description: description.trim() || null,
      });
      setEditingPosition(null);
      await load();
      loadActivity(activityFilter, period);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить изменения должности");
    }
  }

  async function handleCopyPermissionsOnto(targetId: string, sourceId: string) {
    if (!sourceId) return;
    try {
      await api.post(`/businesses/${businessId}/positions/${targetId}/copy-permissions`, { source_position_id: sourceId });
      setCopyPermissionsTarget(null);
      await load();
      loadActivity(activityFilter, period);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось скопировать права");
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

  async function handleApplyPreset(positionId: string, presetKey: string) {
    const preset = PERMISSION_PRESETS.find((p) => p.key === presetKey);
    if (!preset) return;
    const position = positions.find((p) => p.id === positionId);
    // Подтверждение (доп. проход после 67-го, п.7) — раньше пресет
    // применялся мгновенно и молча заменял текущие права должности целиком
    // (PUT .../permissions — не merge, см. handlePermissionChange рядом),
    // без возможности передумать в последний момент.
    if (
      !(await confirm(
        `Применить пресет «${preset.label}» к должности «${position?.title ?? ""}»? Текущие права этой должности будут заменены.`,
        { confirmLabel: "Применить" }
      ))
    )
      return;
    const updated = RESOURCES.map(({ key }) => ({ resource: key, level: preset.levels[key] ?? "none" }));
    try {
      await api.put(`/businesses/${businessId}/positions/${positionId}/permissions`, { permissions: updated });
      await load();
      loadActivity(activityFilter, period);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось применить пресет");
    }
  }

  // Полное дублирование должности (доп. проход после 67-го, п.8) — в
  // отличие от "скопировать права с другой должности" выше (переносит
  // только матрицу прав на УЖЕ существующую должность), здесь одной кнопкой
  // создаётся совершенно НОВАЯ должность — клон названия (с авто-суффиксом
  // "(копия)"/"(копия N)", см. duplicate_position на бэке), цвета, описания,
  // требования 2FA и всех прав источника разом.
  async function handleDuplicatePosition(id: string) {
    try {
      await api.post(`/businesses/${businessId}/positions/${id}/duplicate`);
      await load();
      loadActivity(activityFilter, period);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось дублировать должность");
    }
  }

  // Мини-история изменений одной должности (доп. проход после 67-го, п.11)
  // — сворачиваемая, подгружается лениво по первому раскрытию, отдельным
  // запросом с новым фильтром resource_id (см. employee_activity в
  // app/api/routes/employees.py), а не смешивается с общим журналом на
  // вкладке «Активность».
  function togglePositionHistory(id: string) {
    setOpenPositionHistory((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      next.add(id);
      if (!positionHistory[id]) {
        const qs = new URLSearchParams({ resource: "position", resource_id: id, limit: "10" });
        api
          .get<ActivityLogPage>(`/businesses/${businessId}/employees/activity?${qs.toString()}`)
          .then((page) => setPositionHistory((prevHistory) => ({ ...prevHistory, [id]: page.items })))
          .catch(() => setPositionHistory((prevHistory) => ({ ...prevHistory, [id]: [] })));
      }
      return next;
    });
  }

  function toggleTeamSelected(id: string) {
    setSelectedTeamIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkAssignPosition() {
    if (!bulkPositionId || selectedTeamIds.size === 0) return;
    // Предупреждение о 2FA (доп. проход после 67-го, п.4) — назначаемая
    // должность требует обязательную 2FA, а часть выбранных сотрудников её
    // не включили; сам бэкенд это не блокирует (require_2fa проверяется при
    // входе, а не при назначении должности), так что без предупреждения
    // владелец узнал бы об этом только когда сотрудник не смог войти.
    if (bulkPositionId !== "none") {
      const targetPosition = positions.find((p) => p.id === bulkPositionId);
      if (targetPosition?.require_2fa) {
        const without2fa = [...selectedTeamIds].filter((id) => {
          const emp = employees.find((e) => e.id === id);
          return emp && emp.totp_enabled === false;
        });
        if (without2fa.length > 0) {
          const ok = await confirm(
            `У ${pluralEmployees(without2fa.length)} из выбранных не включена двухфакторная аутентификация, а должность «${targetPosition.title}» требует её. Всё равно назначить должность?`,
            { confirmLabel: "Назначить" }
          );
          if (!ok) return;
        }
      }
    }
    setBulkBusy(true);
    try {
      const body =
        bulkPositionId === "none"
          ? { employee_ids: [...selectedTeamIds], clear_position: true }
          : { employee_ids: [...selectedTeamIds], position_id: bulkPositionId };
      await api.post(`/businesses/${businessId}/employees/bulk-update`, body);
      setSelectedTeamIds(new Set());
      setBulkPositionId("");
      await load();
      loadActivity(activityFilter, period);
      loadWorkload(period);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось применить массовое действие");
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleBulkDisable() {
    if (selectedTeamIds.size === 0) return;
    if (!(await confirm(`Отключить доступ ${pluralEmployees(selectedTeamIds.size)}?`, { danger: true, confirmLabel: "Отключить" }))) return;
    const ids = [...selectedTeamIds];
    setBulkBusy(true);
    try {
      await api.post(`/businesses/${businessId}/employees/bulk-update`, { employee_ids: ids, status: "disabled" });
      setSelectedTeamIds(new Set());
      await load();
      loadWorkload(period);
      loadActivity(activityFilter, period);
      // "Отменить" (доп. проход после 67-го, п.17) — то же массовое действие
      // в обратную сторону, тем же bulk-update; тост держится дольше обычного
      // именно для таких кнопок (см. AUTO_DISMISS_MS/action в Toast.tsx).
      notify(`Отключено ${pluralEmployees(ids.length)}`, "success", { label: "Отменить", onClick: () => void handleUndoBulkDisable(ids) });
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось отключить выбранных сотрудников");
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleUndoBulkDisable(ids: string[]) {
    try {
      await api.post(`/businesses/${businessId}/employees/bulk-update`, { employee_ids: ids, status: "active" });
      await load();
      loadWorkload(period);
      loadActivity(activityFilter, period);
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось отменить отключение");
    }
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
                placeholder="Поиск по имени, email или телефону…"
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
            {isOwner && (
              <button
                className={"btn btn-sm" + (teamPendingOnly ? " btn-primary" : "")}
                onClick={() => setTeamPendingOnly((v) => !v)}
                title={`Приглашение не подтверждено ${PENDING_INVITE_DAYS}+ дней`}
              >
                Зависшие приглашения
              </button>
            )}
            {isOwner && filteredEmployees.length > 0 && (
              // Экспорт СПИСКА команды (67-й проход) — экспортируется текущий
              // отфильтрованный список (см. exportEmployeesCsv), а не весь
              // employees, тем же принципом, что и остальные CSV в проекте.
              <button className="btn btn-sm" onClick={() => exportEmployeesCsv(filteredEmployees, positionTitle)}>
                Экспорт CSV
              </button>
            )}
            {isOwner && selectedTeamIds.size > 0 && (
              // Экспорт только выбранных (доп. проход после 67-го, п.1) —
              // отдельная кнопка рядом: экспорт списка выше по-прежнему берёт
              // весь filteredEmployees, эта — только отмеченные чекбоксом
              // строки (полезно, когда нужно выгрузить конкретную подборку, а
              // не подгонять фильтры под неё).
              <button
                className="btn btn-sm"
                onClick={() => exportEmployeesCsv(filteredEmployees.filter((e) => selectedTeamIds.has(e.id)), positionTitle)}
              >
                Экспорт выбранных ({selectedTeamIds.size})
              </button>
            )}
          </div>

          {isOwner && selectedTeamIds.size > 0 && (
            // Панель массовых действий (67-й проход) — появляется только
            // когда что-то выбрано, чтобы не занимать место постоянно.
            <div className="card" style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginBottom: "10px" }}>
              <strong style={{ fontSize: "13px" }}>{pluralEmployees(selectedTeamIds.size)} выбрано</strong>
              <div style={{ minWidth: "200px" }}>
                <Dropdown
                  value={bulkPositionId}
                  onChange={setBulkPositionId}
                  placeholder="Назначить должность…"
                  options={[
                    { value: "", label: "Назначить должность…" },
                    { value: "none", label: "Без должности" },
                    ...positions.map((p) => ({ value: p.id, label: p.title })),
                  ]}
                />
              </div>
              <button className="btn btn-sm btn-primary" onClick={handleBulkAssignPosition} disabled={!bulkPositionId || bulkBusy}>
                Применить
              </button>
              <button className="btn btn-sm btn-danger-ghost" onClick={handleBulkDisable} disabled={bulkBusy}>
                Отключить выбранных
              </button>
              <button className="btn btn-sm" onClick={() => setSelectedTeamIds(new Set())} disabled={bulkBusy}>
                Снять выбор
              </button>
            </div>
          )}

          <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                {isOwner && (
                  <th style={{ width: "30px" }}>
                    <input
                      type="checkbox"
                      checked={
                        filteredEmployees.filter((e) => !e.is_owner).length > 0 &&
                        filteredEmployees.filter((e) => !e.is_owner).every((e) => selectedTeamIds.has(e.id))
                      }
                      onChange={() => {
                        const selectable = filteredEmployees.filter((e) => !e.is_owner).map((e) => e.id);
                        const allSelected = selectable.length > 0 && selectable.every((id) => selectedTeamIds.has(id));
                        setSelectedTeamIds(allSelected ? new Set() : new Set(selectable));
                      }}
                    />
                  </th>
                )}
                <th className="sortable" onClick={() => toggleTeamSort("name")}>
                  Сотрудник
                  <span className={"sort-arrow" + (teamSort.key === "name" ? "" : " sort-arrow-idle")}>
                    {teamSort.key === "name" ? (teamSort.dir === "desc" ? "▼" : "▲") : "↕"}
                  </span>
                </th>
                {isOwner && <th>Email</th>}
                {isOwner && <th>Телефон</th>}
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
                  <td colSpan={isOwner ? 8 : 4} className="empty-note">Никого не найдено по текущим фильтрам</td>
                </tr>
              )}
              {filteredEmployees.map((emp) => {
                const clickable = isOwner && !emp.is_owner;
                const pendingTooLong = isPendingTooLong(emp);
                const gap2fa = position2faGap(emp);
                return (
                  <tr
                    key={emp.id}
                    ref={(el) => { rowRefs.current[emp.id] = el; }}
                    className={flashId === emp.id ? "row-flash" : undefined}
                    data-clickable={clickable ? "true" : undefined}
                    onClick={clickable ? () => setOpenEmployeeId(emp.id) : undefined}
                  >
                    {isOwner && (
                      <td onClick={(e) => e.stopPropagation()}>
                        {!emp.is_owner && (
                          <input type="checkbox" checked={selectedTeamIds.has(emp.id)} onChange={() => toggleTeamSelected(emp.id)} />
                        )}
                      </td>
                    )}
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        {emp.photo_url ? (
                          <img
                            src={emp.photo_url}
                            alt=""
                            style={{ width: 26, height: 26, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
                          />
                        ) : (
                          <span className={"avatar avatar-emp-" + emp.status} style={{ width: 26, height: 26, fontSize: "10.5px" }}>
                            {initials(emp.name)}
                          </span>
                        )}
                        {emp.name}
                        {emp.is_owner && <span className="badge badge-owner">владелец</span>}
                        {pendingTooLong && (
                          <span
                            className="badge tone-warning"
                            title={`Приглашение не подтверждено ${PENDING_INVITE_DAYS}+ дней`}
                            style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}
                          >
                            <IconAlert style={{ width: 11, height: 11 }} /> зависло
                          </span>
                        )}
                        {gap2fa && (
                          <span
                            className="badge tone-warning"
                            title="Должность требует обязательную 2FA, но у сотрудника она не включена"
                            style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}
                          >
                            <IconAlert style={{ width: 11, height: 11 }} /> нет 2FA
                          </span>
                        )}
                      </div>
                    </td>
                    {isOwner && <td className="muted">{emp.email ?? "—"}</td>}
                    {isOwner && <td className="muted">{emp.phone ?? "—"}</td>}
                    <td>{emp.is_owner ? "—" : positionBadge(emp.position_id)}</td>
                    <td><Badge meta={EMPLOYEE_STATUS_META[emp.status]} /></td>
                    {isOwner && (
                      <td className="muted">
                        {emp.last_login_at ? new Date(emp.last_login_at).toLocaleDateString("ru-RU") : "Ни разу не входил"}
                      </td>
                    )}
                    <td style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }} onClick={(e) => e.stopPropagation()}>
                      {isOwner && !emp.is_owner && onMessageEmployee && (
                        <button className="btn btn-sm" onClick={() => onMessageEmployee(emp.id)} title="Написать сообщение">
                          <IconMessages />
                        </button>
                      )}
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
          </div>
        </>
      )}

      {pageTab === "positions" && (
        <>
          {isOwner && (
            <form className="inline-form" onSubmit={handleCreatePosition} style={{ flexWrap: "wrap" }}>
              <input placeholder="Название новой должности" value={newPositionTitle} onChange={(e) => setNewPositionTitle(e.target.value)} />
              <div style={{ minWidth: "140px" }}>
                <Dropdown
                  value={newPositionColor}
                  onChange={setNewPositionColor}
                  placeholder="Без цвета"
                  options={[{ value: "", label: "Без цвета" }, ...POSITION_COLORS.map((c) => ({ value: c.key, label: c.label }))]}
                />
              </div>
              <input
                placeholder="Описание (необязательно)"
                style={{ minWidth: "180px" }}
                value={newPositionDescription}
                onChange={(e) => setNewPositionDescription(e.target.value)}
              />
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
            {reverseMatrix ? (
              // Поиск по сотрудникам в обратной матрице (доп. проход после
              // 67-го, п.9) — у списка карточек "по должностям" уже был свой
              // поиск (positionSearch ниже), у матрицы "по сотрудникам" его
              // не было вовсе, хотя команда может быть не меньше самого
              // списка должностей.
              <div style={{ position: "relative", maxWidth: "260px", flex: "1 1 200px" }}>
                <IconSearch style={{ position: "absolute", left: "9px", top: "50%", transform: "translateY(-50%)", width: 14, height: 14, color: "var(--muted)" }} />
                <input
                  style={{ paddingLeft: "28px", width: "100%" }}
                  placeholder="Поиск по имени сотрудника…"
                  value={reverseMatrixSearch}
                  onChange={(e) => setReverseMatrixSearch(e.target.value)}
                />
              </div>
            ) : (
              <div style={{ position: "relative", maxWidth: "260px", flex: "1 1 200px" }}>
                <IconSearch style={{ position: "absolute", left: "9px", top: "50%", transform: "translateY(-50%)", width: 14, height: 14, color: "var(--muted)" }} />
                <input
                  style={{ paddingLeft: "28px", width: "100%" }}
                  placeholder="Поиск по названию должности…"
                  value={positionSearch}
                  onChange={(e) => setPositionSearch(e.target.value)}
                />
              </div>
            )}
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
            <div className="table-wrap">
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>Сотрудник</th>
                  <th>Должность</th>
                  {RESOURCES.map(({ key, label }) => (
                    <th key={key}>
                      {label}
                      {key === "employees" && (
                        // Подсказка (67-й проход, "сквозное") — право на
                        // "Сотрудники" регулирует только видимость вкладки,
                        // не администрирование персонала (приглашение,
                        // отключение, права — везде отдельная проверка
                        // "только владелец", см. _require_owner в positions.py
                        // и employees.py). Без этой пометки легко подумать,
                        // что "edit" здесь даёт подчинённому право управлять
                        // командой.
                        <span
                          className="muted"
                          title="Только видимость вкладки «Сотрудники». Приглашать, отключать и менять права может только владелец — независимо от этого права."
                          style={{ marginLeft: "4px", cursor: "help" }}
                        >
                          <IconAlert style={{ width: 11, height: 11 }} />
                        </span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {employees
                  .filter((emp) => !reverseMatrixSearch.trim() || emp.name.toLowerCase().includes(reverseMatrixSearch.trim().toLowerCase()))
                  .map((emp) => {
                    const clickable = isOwner && !emp.is_owner;
                    return (
                      <tr
                        key={emp.id}
                        data-clickable={clickable ? "true" : undefined}
                        onClick={clickable ? () => setOpenEmployeeId(emp.id) : undefined}
                      >
                        <td>{emp.name}{emp.is_owner && <span className="badge badge-owner" style={{ marginLeft: "6px" }}>владелец</span>}</td>
                        <td className="muted">{emp.is_owner ? "—" : positionTitle(emp.position_id)}</td>
                        {RESOURCES.map(({ key }) => (
                          <td key={key} className="muted">{LEVEL_LABEL[employeeLevel(emp, key)]}</td>
                        ))}
                      </tr>
                    );
                  })}
              </tbody>
            </table>
            </div>
          ) : (
            <>
              {filteredPositions.length === 0 && <div className="empty-note">Ничего не найдено по запросу «{positionSearch}»</div>}
              {filteredPositions.map((p) => {
                // "Пустая" должность (доп. проход после 67-го, п.10) — все
                // пять разделов на "нет доступа": скорее всего, недооформленная
                // должность, которую забыли настроить, а не осознанное решение
                // (для осознанного "вообще без доступа" тоже есть готовый
                // пресет "Без доступа" — этот бейдж не мешает его применять).
                const isEmptyPosition = RESOURCES.every(({ key }) => (p.permissions.find((perm) => perm.resource === key)?.level ?? "none") === "none");
                return (
                <div
                  key={p.id}
                  className={"card dash-block-cell" + (dragPositionId === p.id ? " dragging" : "")}
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
                  {/* flexWrap на самой верхней строке карточки (доп. проход
                      после 67-го) — после добавления кнопок "Дублировать"/
                      "История" (п.8/п.11) группа из четырёх иконок перестала
                      помещаться рядом с названием+бейджами на узких экранах
                      и накладывалась на них; перенос кнопок на отдельную
                      строку вместо наложения — тот же принцип отзывчивости,
                      что и у формы редактирования ниже (см. п.18). */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1, minWidth: 0, flexWrap: "wrap" }}>
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
                      {editingPosition?.id === p.id ? (
                        // Отзывчивость на узком экране (доп. проход после
                        // 67-го, п.18) — .table-wrap ниже разворачивает
                        // горизонтальный скролл только для <table>, у этой
                        // формы своей обёртки не было: flexWrap на самой
                        // форме уже стоял, но minWidth:0 на полях не был
                        // задан, поэтому на узких экранах строка вылезала за
                        // пределы карточки вместо переноса на новую строку.
                        <form
                          className="inline-form"
                          style={{ flex: "1 1 260px", flexWrap: "wrap", minWidth: 0 }}
                          onSubmit={(e) => {
                            e.preventDefault();
                            handleSavePositionEdit(p.id, editingPosition.title, editingPosition.color, editingPosition.description);
                          }}
                        >
                          <input
                            autoFocus
                            style={{ flex: "1 1 140px", minWidth: 0 }}
                            value={editingPosition.title}
                            onChange={(e) => setEditingPosition({ ...editingPosition, title: e.target.value })}
                          />
                          <div style={{ flex: "1 1 140px", minWidth: 0 }}>
                            <Dropdown
                              value={editingPosition.color}
                              onChange={(v) => setEditingPosition({ ...editingPosition, color: v })}
                              placeholder="Без цвета"
                              options={[{ value: "", label: "Без цвета" }, ...POSITION_COLORS.map((c) => ({ value: c.key, label: c.label }))]}
                            />
                          </div>
                          <input
                            placeholder="Описание"
                            style={{ flex: "1 1 180px", minWidth: 0 }}
                            value={editingPosition.description}
                            onChange={(e) => setEditingPosition({ ...editingPosition, description: e.target.value })}
                          />
                          <button type="submit" className="btn btn-sm btn-primary">Сохранить</button>
                          <button type="button" className="btn btn-sm" onClick={() => setEditingPosition(null)}>Отмена</button>
                        </form>
                      ) : (
                        <>
                          {p.color && (
                            <span
                              title="Цвет должности"
                              style={{
                                width: 12,
                                height: 12,
                                borderRadius: "50%",
                                flexShrink: 0,
                                background: `var(${POSITION_COLORS.find((c) => c.key === p.color)?.cssVar ?? "--muted"})`,
                                border: "1px solid var(--border)",
                              }}
                            />
                          )}
                          <h3 style={{ margin: 0 }}>{p.title}</h3>
                          <span className="badge" title="Сколько сотрудников сейчас на этой должности">{pluralEmployees(p.employee_count)}</span>
                          {isEmptyPosition && (
                            <span className="badge tone-warning" title="Ни на один из пяти разделов нет доступа">без доступа ни к чему</span>
                          )}
                        </>
                      )}
                    </div>
                    {editingPosition?.id !== p.id && isOwner && (
                      <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                        <button
                          className={"btn btn-sm" + (openPositionHistory.has(p.id) ? " btn-primary" : "")}
                          onClick={() => togglePositionHistory(p.id)}
                          title="История изменений этой должности"
                        >
                          <IconHistory />
                        </button>
                        <button className="btn btn-sm" onClick={() => handleDuplicatePosition(p.id)} title="Дублировать должность целиком">
                          <IconCopy />
                        </button>
                        <button
                          className="btn btn-sm"
                          onClick={() => setEditingPosition({ id: p.id, title: p.title, color: p.color ?? "", description: p.description ?? "" })}
                          title="Редактировать"
                        >
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
                  {openPositionHistory.has(p.id) && (
                    // Мини-история должности (доп. проход после 67-го, п.11)
                    // — свои последние изменения прямо на карточке, без
                    // похода на общий журнал вкладки «Активность» и ручного
                    // выставления там фильтров по разделу/сотруднику.
                    <div className="form-note" style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "6px" }}>
                      {positionHistory[p.id] === undefined ? (
                        <span className="muted">Загрузка…</span>
                      ) : positionHistory[p.id].length === 0 ? (
                        <span className="muted">Изменений пока не было</span>
                      ) : (
                        positionHistory[p.id].map((entry) => (
                          <div key={entry.id} style={{ fontSize: "12px" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                              <span style={{ fontWeight: 600 }}>{activityLabel(entry)}</span>
                              <span className="muted" style={{ whiteSpace: "nowrap" }}>
                                {new Date(entry.created_at).toLocaleDateString("ru-RU")}
                              </span>
                            </div>
                            {activityDetails(entry).map((line, i) => (
                              <div key={i} className="muted" style={{ marginTop: "1px" }}>{line}</div>
                            ))}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                  {p.description && editingPosition?.id !== p.id && (
                    <div className="muted" style={{ fontSize: "12.5px", marginTop: "4px" }}>{p.description}</div>
                  )}
                  {isOwner && (
                    <label style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "10px", fontSize: "12.5px" }} className="muted">
                      <input type="checkbox" checked={p.require_2fa} onChange={() => handleToggleRequire2fa(p)} />
                      Обязательная двухфакторная аутентификация для этой должности
                    </label>
                  )}
                  {isOwner && (
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center", marginTop: "10px" }}>
                      {/* Пресеты прав (67-й проход) — одной кнопкой вместо
                          выставления каждого из пяти ресурсов вручную; PUT
                          применяется целиком (см. handleApplyPreset), поэтому
                          перед применением стоит предупредить, что текущие
                          права будут заменены. */}
                      {PERMISSION_PRESETS.map((preset) => (
                        <button
                          key={preset.key}
                          className="btn btn-sm"
                          title="Заменит текущие права этой должности"
                          onClick={() => handleApplyPreset(p.id, preset.key)}
                        >
                          {preset.label}
                        </button>
                      ))}
                      {copyPermissionsTarget?.targetId === p.id ? (
                        <>
                          <div style={{ minWidth: "180px" }}>
                            <Dropdown
                              value={copyPermissionsTarget.sourceId}
                              onChange={(v) => setCopyPermissionsTarget({ targetId: p.id, sourceId: v })}
                              placeholder="Выбрать должность…"
                              options={positions.filter((other) => other.id !== p.id).map((other) => ({ value: other.id, label: other.title }))}
                            />
                          </div>
                          <button
                            className="btn btn-sm btn-primary"
                            disabled={!copyPermissionsTarget.sourceId}
                            onClick={() => handleCopyPermissionsOnto(p.id, copyPermissionsTarget.sourceId)}
                          >
                            Скопировать
                          </button>
                          <button className="btn btn-sm" onClick={() => setCopyPermissionsTarget(null)}>Отмена</button>
                        </>
                      ) : (
                        positions.length > 1 && (
                          <button className="btn btn-sm" onClick={() => setCopyPermissionsTarget({ targetId: p.id, sourceId: "" })}>
                            Скопировать права с другой должности
                          </button>
                        )
                      )}
                    </div>
                  )}
                  <div className="table-wrap" style={{ marginTop: "10px" }}>
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
                            <td>
                              {label}
                              {key === "employees" && (
                                <span
                                  className="muted"
                                  title="Только видимость вкладки «Сотрудники». Приглашать, отключать и менять права может только владелец — независимо от этого права."
                                  style={{ marginLeft: "4px", cursor: "help" }}
                                >
                                  <IconAlert style={{ width: 11, height: 11 }} />
                                </span>
                              )}
                            </td>
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
                </div>
                );
              })}
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

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
            <h2 style={{ display: "flex", alignItems: "center", gap: "6px", margin: 0 }}>
              <IconTrendUp /> Нагрузка команды
            </h2>
            {workload && workload.length > 0 && (
              <button className="btn btn-sm" onClick={() => exportWorkloadCsv(workload, "Нагрузка команды", teamTrendPoints)}>
                Экспорт CSV
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", margin: "10px 0" }}>
            {/* Фильтр сводки по должности (доп. проход после 67-го, п.14) —
                тот же список опций, что и на «Команде» выше. */}
            <div style={{ minWidth: "180px" }}>
              <Dropdown value={workloadPositionFilter} onChange={setWorkloadPositionFilter} placeholder="Все должности" options={teamPositionOptions} />
            </div>
            {/* Настраиваемая чувствительность аномалий (доп. проход после
                67-го, п.13) — влияет только на подсветку ниже, сами числа в
                таблице не пересчитываются. */}
            <div style={{ minWidth: "220px" }}>
              <Dropdown
                value={anomalySensitivityKey}
                onChange={setAnomalySensitivityKey}
                placeholder="Обычная чувствительность"
                options={ANOMALY_SENSITIVITY.map((s) => ({ value: s.key, label: s.label }))}
              />
            </div>
          </div>
          {workload === null ? (
            <div className="muted">Загрузка…</div>
          ) : workload.length === 0 ? (
            <div className="empty-note">Активных сотрудников пока нет</div>
          ) : (
            <div className="table-wrap">
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
                  <th>Динамика по дням</th>
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
                  const thresholds = ANOMALY_SENSITIVITY.find((s) => s.key === anomalySensitivityKey) ?? DEFAULT_ANOMALY_THRESHOLDS;
                  const anomaly = workloadAnomaly(w, emp?.status === "active", thresholds);
                  const gap2fa = emp && position2faGap(emp);
                  const trend = teamTrend[w.employee_id];
                  return (
                    <tr
                      key={w.employee_id}
                      data-clickable={clickable ? "true" : undefined}
                      onClick={clickable ? () => setOpenEmployeeId(w.employee_id) : undefined}
                    >
                      <td>
                        {w.employee_name}
                        {anomaly && (
                          <span className="badge tone-warning" title={anomaly} style={{ marginLeft: "6px", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                            <IconAlert style={{ width: 11, height: 11 }} /> {anomaly}
                          </span>
                        )}
                        {gap2fa && (
                          <span
                            className="badge tone-warning"
                            title="Должность требует обязательную 2FA, но у сотрудника она не включена"
                            style={{ marginLeft: "6px", display: "inline-flex", alignItems: "center", gap: "4px" }}
                          >
                            <IconAlert style={{ width: 11, height: 11 }} /> нет 2FA
                          </span>
                        )}
                      </td>
                      <td>{w.rentals_created}{trendBadge(w.rentals_created, w.rentals_created_prev)}</td>
                      <td>{w.client_notes}{trendBadge(w.client_notes, w.client_notes_prev)}</td>
                      <td>{w.rental_photos}{trendBadge(w.rental_photos, w.rental_photos_prev)}</td>
                      <td>{trend && trend.length >= 2 ? <WorkloadSparkline values={trend} /> : <span className="muted">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
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
            {/* Пресет "Критичные действия" (67-й проход) — быстрый фильтр для
                разбора инцидентов: удаления/отключения/изменения прав/2FA/
                сброс пароля/массовые действия одним кликом, без ручного
                перебора action в поле выше. Бэкенд принимает список action
                через запятую (см. employee_activity в employees.py). */}
            <button
              className={"btn btn-sm" + (activityAction === CRITICAL_ACTIONS ? " btn-primary" : "")}
              onClick={() => changeActivityAction(activityAction === CRITICAL_ACTIONS ? "" : CRITICAL_ACTIONS)}
              title="Удаления, отключения, изменения прав/2FA, сброс пароля, массовые действия"
            >
              Критичные действия
            </button>
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
          positionRequires2fa={positions.find((p) => p.id === openEmployee.position_id)?.require_2fa}
          workload={workload?.find((w) => w.employee_id === openEmployee.id)}
          onClose={() => setOpenEmployeeId(null)}
          onOpenEdit={() => {
            setEditingEmployee(openEmployee);
          }}
          onDisable={() => handleDisableEmployee(openEmployee.id)}
          onReactivate={() => handleReactivateEmployee(openEmployee.id)}
          onMessage={onMessageEmployee ? () => onMessageEmployee(openEmployee.id) : undefined}
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
