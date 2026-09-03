import { useEffect, useState, type ReactElement, type SVGProps } from "react";
import { useAuth } from "../context/AuthContext";
import { useBusiness } from "../context/BusinessContext";
import { DataProvider, useData } from "../context/DataContext";
import { api, ApiError } from "../api/client";
import type { Business, Conversation, Employee, MessagingPermission, NotesMode } from "../api/types";
import { DashboardTab } from "./dashboard/DashboardTab";
import { AdminOverviewTab } from "./dashboard/AdminOverviewTab";
import { EquipmentTab, EquipmentDetailPanel } from "./dashboard/EquipmentTab";
import { ClientsTab, ClientDetailPanel } from "./dashboard/ClientsTab";
import { RentalsTab, CreateRentalModal } from "./dashboard/RentalsTab";
import { CalendarTab } from "./dashboard/CalendarTab";
import { FinanceTab } from "./dashboard/FinanceTab";
import { EmployeesTab } from "./dashboard/EmployeesTab";
import { MessagesTab } from "./dashboard/MessagesTab";
import { AccountSettings } from "./AccountSettings";
import { rentalDisplayStatus } from "../lib/statusMeta";
import { initials, money } from "../lib/format";
import { isUnpaid } from "./dashboard/rentals/helpers";
import { periodFor, type FinancePeriod } from "../lib/financeCalc";
import { useConfirm } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";
import { Dropdown } from "../components/Dropdown";
import {
  IconSearch,
  IconPlus,
  IconSun,
  IconMoon,
  IconDashboard,
  IconEquipment,
  IconClients,
  IconRentals,
  IconCalendar,
  IconFinance,
  IconEmployees,
  IconMessages,
  IconUser,
  IconAdmin,
} from "../lib/icons";

export type View = "dashboard" | "equipment" | "clients" | "rentals" | "calendar" | "finance" | "employees" | "messages" | "profile" | "admin";

// Как часто опрашивать бэкенд на предмет непрочитанных сообщений для
// значка в навигации (когда пользователь НЕ находится на вкладке
// "Сообщения" — там своя, более частая логика внутри MessagesTab).
// Лёгкий polling, а не WebSocket — осознанное решение (см. заметки проекта):
// для внутренней CRM-переписки нескольких сотрудников это достаточно
// отзывчиво и сильно проще в поддержке на free-tier хостинге.
const UNREAD_POLL_MS = 20000;

const THEME_KEY = "rentika_theme_v1";

export function Dashboard() {
  const { loading: authLoading, logout } = useAuth();
  const { businesses, currentBusinessId, setCurrentBusinessId, loading } = useBusiness();

  if (loading || authLoading) return <div className="page-loading">Загрузка…</div>;

  if (!currentBusinessId) {
    return (
      <div className="page-loading">
        <p>У вас пока нет доступа ни к одному бизнесу.</p>
        <button className="btn" onClick={() => void logout()}>Выйти</button>
      </div>
    );
  }

  return (
    <DataProvider businessId={currentBusinessId}>
      <DashboardShell
        businessId={currentBusinessId}
        businesses={businesses}
        setCurrentBusinessId={setCurrentBusinessId}
      />
    </DataProvider>
  );
}

function DashboardShell({
  businessId,
  businesses,
  setCurrentBusinessId,
}: {
  businessId: string;
  businesses: Business[];
  setCurrentBusinessId: (id: string) => void;
}) {
  const { user, logout } = useAuth();
  const { equipment, clients, rentals, loading, reloadClients, reloadRentals, reloadEquipment } = useData();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [view, setView] = useState<View>("dashboard");
  const [search, setSearch] = useState("");
  const [equipmentFilter, setEquipmentFilter] = useState("all");
  const [rentalFilter, setRentalFilter] = useState("active");
  const [financePeriod, setFinancePeriod] = useState<FinancePeriod>(() => periodFor("30", []));
  const [theme, setTheme] = useState<"light" | "dark" | null>(() => {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : null;
  });

  // Карточки клиента/оборудования, открытые ПРЯМО С ДАШБОРДА — тот же
  // слайдовер-компонент, что и в "Клиенты"/"Оборудование" (переиспользован,
  // не задублирован), но со своим независимым состоянием здесь наверху, на
  // уровне общей оболочки, а не внутри DashboardTab: так карточка не
  // требует перехода на другую вкладку, ровно то, о чём просил пользователь.
  const [dashClientId, setDashClientId] = useState<string | null>(null);
  const [dashEquipmentId, setDashEquipmentId] = useState<string | null>(null);

  const { confirm, dialog: confirmDialog } = useConfirm();
  const { notify } = useToast();

  useEffect(() => {
    api.get<Employee[]>(`/businesses/${businessId}/employees`).then(setEmployees).catch(() => {});
  }, [businessId]);

  const myEmployee = employees.find((e) => e.user_id === user?.id) ?? null;
  const isOwner = myEmployee?.is_owner ?? false;

  // Режим доски "Заметки/новости" — хранится на Business, но держим его
  // отдельным локальным состоянием (не читаем прямо из объекта businesses[])
  // чтобы владелец видел смену режима мгновенно, не дожидаясь перезагрузки
  // списка бизнесов через BusinessContext.
  const currentBusiness = businesses.find((b) => b.id === businessId);
  const [notesMode, setNotesMode] = useState<NotesMode>(currentBusiness?.notes_mode ?? "owner_only");
  useEffect(() => {
    setNotesMode(currentBusiness?.notes_mode ?? "owner_only");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId]);

  // Режим личных сообщений ("кто кому может писать") — тот же паттерн, что и
  // notesMode выше: хранится на Business, держим отдельным локальным
  // состоянием, чтобы владелец видел смену режима мгновенно.
  const [messagingPermission, setMessagingPermission] = useState<MessagingPermission>(
    currentBusiness?.messaging_permission ?? "owner_only"
  );
  useEffect(() => {
    setMessagingPermission(currentBusiness?.messaging_permission ?? "owner_only");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId]);

  // Логотип бизнеса — тот же паттерн, что notesMode/messagingPermission выше:
  // хранится на Business, держим отдельным локальным состоянием, чтобы
  // владелец видел смену логотипа мгновенно после загрузки в "Профиле".
  const [logoUrl, setLogoUrl] = useState<string | null>(currentBusiness?.logo_url ?? null);
  useEffect(() => {
    setLogoUrl(currentBusiness?.logo_url ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId]);

  // Значок непрочитанных сообщений в навигации — лёгкий polling списка
  // диалогов (нужен только unread_count, но отдельного "облегчённого"
  // эндпоинта не заводили — список диалогов у сотрудника обычно небольшой).
  // Не опрашиваем, пока сама вкладка "Сообщения" открыта — там счётчик и так
  // обновляется актуальнее собственным polling'ом MessagesTab.
  const [unreadTotal, setUnreadTotal] = useState(0);
  useEffect(() => {
    let cancelled = false;
    function poll() {
      if (view === "messages") return;
      api
        .get<Conversation[]>(`/businesses/${businessId}/conversations`)
        .then((list) => {
          if (!cancelled) setUnreadTotal(list.reduce((s, c) => s + c.unread_count, 0));
        })
        .catch(() => {});
    }
    poll();
    const interval = setInterval(poll, UNREAD_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId, view]);

  async function handleDashClientDelete(id: string) {
    if (!(await confirm("Удалить этого клиента?", { danger: true }))) return;
    try {
      await api.delete(`/businesses/${businessId}/clients/${id}`);
      if (dashClientId === id) setDashClientId(null);
      await reloadClients();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось удалить");
    }
  }

  useEffect(() => {
    if (theme) document.documentElement.setAttribute("data-theme", theme);
    else document.documentElement.removeAttribute("data-theme");
  }, [theme]);

  function toggleTheme() {
    const effective = theme || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = effective === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem(THEME_KEY, next);
  }

  // Форма "Новая аренда" из шапки — теперь рендерится прямо здесь, на
  // уровне общей оболочки (тем же приёмом, что и карточки клиента/
  // оборудования с дашборда выше), а не через переход на вкладку "Аренды":
  // по итогам обзора это лучше, чем прыгать на другую вкладку ради формы,
  // которая и так открывается поверх всего интерфейса.
  const [showCreateRental, setShowCreateRental] = useState(false);
  // Клиент, для которого открыта "Новая аренда" из его же карточки (25-й
  // проход, п.1 обзора) — null означает обычное открытие кнопкой в шапке
  // (без предзаполненного клиента), см. openCreateRentalForClient ниже.
  const [createRentalClientId, setCreateRentalClientId] = useState<string | null>(null);
  function openCreateRentalForClient(clientId: string) {
    // Закрываем карточку клиента перед открытием формы — та же логика, что
    // и при переходе "Изменить" (см. onEdit у ClientsTab): поверх слайдовера
    // модалка технически рендерится нормально, но так чище.
    setDashClientId(null);
    setCreateRentalClientId(clientId);
    setShowCreateRental(true);
  }
  // Сотрудник, на строку которого нужно проскроллить и подсветить при
  // переходе на вкладку "Сотрудники" по клику из блока "Команда" в сайдбаре —
  // тем же счётчиковым паттерном, чтобы повторный клик по уже подсвеченной
  // строке срабатывал снова.
  const [highlightEmployee, setHighlightEmployee] = useState<{ id: string; signal: number } | null>(null);
  // Дата, на которую нужно перепрыгнуть при переходе на "Календарь" из
  // карточки/панели аренды (42-й проход, п.5 обзора) — тот же счётчиковый
  // паттерн, что и highlightEmployee выше (см. докстринг пропа focus в
  // CalendarTab.tsx).
  const [calendarFocus, setCalendarFocus] = useState<{ date: string; signal: number } | null>(null);

  /** Переход между разделами со сбросом поиска и (опционально) выставлением
   * фильтра — аналог обработчика "dash-stat"/"filter-by-category" в демо. */
  function navigate(
    target: View,
    opts?: {
      equipmentFilter?: string;
      rentalFilter?: string;
      search?: string;
      finance30?: boolean;
      highlightEmployeeId?: string;
      calendarFocusDate?: string;
    }
  ) {
    setView(target);
    setSearch(opts?.search ?? "");
    if (opts?.equipmentFilter) setEquipmentFilter(opts.equipmentFilter);
    if (opts?.rentalFilter) setRentalFilter(opts.rentalFilter);
    if (opts?.finance30) setFinancePeriod(periodFor("30", rentals));
    if (opts?.highlightEmployeeId) setHighlightEmployee((prev) => ({ id: opts.highlightEmployeeId!, signal: (prev?.signal ?? 0) + 1 }));
    if (opts?.calendarFocusDate) setCalendarFocus((prev) => ({ date: opts.calendarFocusDate!, signal: (prev?.signal ?? 0) + 1 }));
  }

  const activeEmployees = employees.filter((e) => e.status !== "disabled");
  const overdueCount = rentals.filter((r) => rentalDisplayStatus(r) === "overdue").length;
  // Итоговая сводка долга (49-й проход, по итогам обзора списка "Аренды" —
  // "хочется видеть общую картину, не листая карточки"), тем же принципом,
  // что и overdueCount выше: считается по всем арендам бизнеса, независимо
  // от текущего фильтра/поиска внутри самой вкладки "Аренды".
  const unpaidRentals = rentals.filter(isUnpaid);
  const unpaidSum = unpaidRentals.reduce((s, r) => s + (r.total - r.paid_amount), 0);

  const NAV: { key: View; label: string; icon: (p: SVGProps<SVGSVGElement>) => ReactElement; count?: number }[] = [
    { key: "dashboard", label: "Дашборд", icon: IconDashboard },
    { key: "equipment", label: "Оборудование", icon: IconEquipment, count: equipment.length },
    { key: "clients", label: "Клиенты", icon: IconClients, count: clients.length },
    {
      key: "rentals",
      label: "Аренды",
      icon: IconRentals,
      count: rentals.filter((r) => { const s = rentalDisplayStatus(r); return s === "active" || s === "overdue"; }).length,
    },
    { key: "calendar", label: "Календарь", icon: IconCalendar },
    { key: "finance", label: "Финансы", icon: IconFinance },
    { key: "employees", label: "Сотрудники", icon: IconEmployees, count: activeEmployees.length },
    { key: "messages", label: "Сообщения", icon: IconMessages, count: unreadTotal || undefined },
    { key: "profile", label: "Профиль", icon: IconUser },
    // Видно только платформенному админу — обзор ВСЕХ бизнесов на платформе
    // (для техподдержки), встроенный сюда же вместо отдельного экрана без
    // доступа к остальной CRM (см. историю решения в Home.tsx).
    ...(user?.is_platform_admin ? [{ key: "admin" as const, label: "Все бизнесы", icon: IconAdmin }] : []),
  ];

  const todayLabel = new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });

  const TITLES: Record<View, [string, string]> = {
    dashboard: ["Дашборд", `Сводка · ${todayLabel}`],
    equipment: ["Оборудование", equipment.length + " позиций в парке"],
    clients: ["Клиенты", clients.length + " в базе"],
    rentals: [
      "Аренды",
      [
        overdueCount ? `${overdueCount} просрочено — нужно связаться с клиентом` : "",
        unpaidRentals.length ? `не оплачено: ${unpaidRentals.length} на ${money(unpaidSum)}` : "",
      ]
        .filter(Boolean)
        .join(" · ") || "Все аренды под контролем",
    ],
    calendar: ["Календарь занятости", "Занятость оборудования"],
    finance: ["Финансы", "Доходы, депозиты и история возвратов"],
    employees: ["Сотрудники", "Должности и права доступа"],
    messages: ["Сообщения", "Личная переписка с коллегами"],
    profile: ["Профиль", "Личные данные, пароль и безопасность"],
    admin: ["Все бизнесы", "Обзор платформы для техподдержки"],
  };

  const [title, subtitle] = TITLES[view];
  const showSearch = view === "equipment" || view === "clients" || view === "rentals" || view === "calendar";
  const searchPlaceholder =
    view === "equipment" || view === "calendar"
      ? "Поиск по оборудованию…"
      : view === "clients"
      ? "Поиск по клиентам…"
      : "Поиск по клиентам и оборудованию…";

  return (
    <div className="app">
      <aside className="sidebar">
        <button
          type="button"
          className="brand"
          title="На дашборд"
          onClick={() => navigate("dashboard")}
        >
          <div className="brand-mark">
            {logoUrl ? (
              <img className="brand-logo-img" src={logoUrl} alt="" />
            ) : (
              <>
                <div className="sh1" />
                <div className="sh2" />
              </>
            )}
          </div>
          <div>
            <div className="brand-name">
              RENTIKA<span className="brand-tag">CRM</span>
            </div>
            <div className="brand-sub">{currentBusiness?.name || "Прокат оборудования"}</div>
          </div>
        </button>

        {businesses.length > 1 && (
          <Dropdown
            value={businessId}
            onChange={setCurrentBusinessId}
            placeholder={currentBusiness?.name ?? ""}
            style={{ width: "100%" }}
            options={businesses.map((b) => ({ value: b.id, label: b.name }))}
          />
        )}

        <nav className="nav">
          {NAV.map((n) => (
            <button
              key={n.key}
              className={"nav-item" + (view === n.key ? " active" : "")}
              onClick={() => navigate(n.key)}
            >
              <n.icon />
              <span className="nav-label">{n.label}</span>
              {n.count !== undefined && <span className="nav-count">{n.count}</span>}
            </button>
          ))}
        </nav>

        <div className="team-block">
          <div className="team-label">Команда</div>
          <div className="team-list">
            {activeEmployees.slice(0, 6).map((emp) => {
              // 16-й проход (обзор вкладки «Оборудование», п.9): собственная
              // строка пользователя в «Команде» раньше вела в «Сотрудники»
              // (как и строки коллег) — логичнее открыть свой же «Профиль».
              const isSelf = emp.user_id === user?.id;
              return (
                <button
                  type="button"
                  className="team-row team-row-clickable"
                  key={emp.id}
                  title={isSelf ? "Открыть мой профиль" : `Открыть ${emp.name} в разделе «Сотрудники»`}
                  onClick={() => (isSelf ? navigate("profile") : navigate("employees", { highlightEmployeeId: emp.id }))}
                >
                  <span className="avatar">{initials(emp.name)}</span>
                  <span className="team-name">{emp.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Раньше здесь был sidebar-spacer, прижимавший "Выйти" к самому низу
            страницы — тем же способом, что раньше прижимал блок "Команда"
            (см. коммент выше про team-block). Убрано по тому же принципу:
            кнопка выхода теперь идёт сразу за списком команды, без
            вынужденного пустого места на высоких экранах. */}
        <button className="reset-link" onClick={() => void logout()}>Выйти ({user?.email})</button>
      </aside>

      <div className="main">
        <div className="topbar">
          <div className="topbar-titles">
            <h1>{title}</h1>
            {view === "rentals" && overdueCount > 0 ? (
              <button
                type="button"
                className="subtitle critical"
                title="Показать просроченные"
                onClick={() => navigate("rentals", { rentalFilter: "overdue" })}
              >
                {subtitle}
              </button>
            ) : (
              <div className="subtitle">{subtitle}</div>
            )}
          </div>
          <div className="topbar-spacer" />
          {showSearch && (
            <div className="search-box">
              <IconSearch />
              <input
                type="text"
                placeholder={searchPlaceholder}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          )}
          {/* Только на дашборде (44-й проход, по итогам обзора верхней части
              "Аренды") — раньше кнопка дублировалась и на вкладке "Аренды":
              там уже есть точно такая же "+ Новая аренда" в собственном
              тулбаре вкладки (RentalsTab.tsx, tab-toolbar-grid), и на экране
              одновременно висели две одинаковые синие кнопки — искажение
              общего принципа шапки: "Оборудование"/"Клиенты" вообще не
              показывают кнопку создания в topbar, она у них ровно одна,
              внутри своего тулбара. На дашборде своего тулбара нет, поэтому
              здесь кнопка остаётся — это единственный способ создать аренду
              с этого экрана. */}
          {view === "dashboard" && (
            <button className="btn btn-primary" onClick={() => setShowCreateRental(true)}>
              <IconPlus /> Новая аренда
            </button>
          )}
          <button className="icon-btn" title="Сменить тему" onClick={toggleTheme}>
            {(theme || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark" ? <IconMoon /> : <IconSun />}
          </button>
        </div>

        <main className="view">
          {loading ? (
            <div className="muted">Загрузка…</div>
          ) : (
            <>
              {view === "dashboard" && (
                <DashboardTab
                  navigate={navigate}
                  businessId={businessId}
                  isOwner={isOwner}
                  notesMode={notesMode}
                  onNotesModeChange={setNotesMode}
                  onOpenClient={setDashClientId}
                  onOpenEquipment={setDashEquipmentId}
                />
              )}
              {view === "equipment" && (
                <EquipmentTab
                  businessId={businessId}
                  search={search}
                  filter={equipmentFilter}
                  setFilter={setEquipmentFilter}
                  isOwner={isOwner}
                />
              )}
              {view === "clients" && (
                <ClientsTab businessId={businessId} search={search} onCreateRental={openCreateRentalForClient} />
              )}
              {view === "rentals" && (
                <RentalsTab
                  businessId={businessId}
                  search={search}
                  filter={rentalFilter}
                  setFilter={setRentalFilter}
                  onOpenClient={setDashClientId}
                  onOpenEquipment={setDashEquipmentId}
                  onOpenCalendar={(date) => navigate("calendar", { calendarFocusDate: date })}
                />
              )}
              {view === "calendar" && <CalendarTab businessId={businessId} search={search} focus={calendarFocus} />}
              {view === "finance" && <FinanceTab period={financePeriod} setPeriod={setFinancePeriod} />}
              {view === "employees" && <EmployeesTab businessId={businessId} highlightEmployee={highlightEmployee} />}
              {view === "messages" && (
                <MessagesTab
                  businessId={businessId}
                  isOwner={isOwner}
                  messagingPermission={messagingPermission}
                  onMessagingPermissionChange={setMessagingPermission}
                  onUnreadTotalChange={setUnreadTotal}
                />
              )}
              {view === "profile" && (
                <AccountSettings
                  myEmployee={myEmployee}
                  isOwner={isOwner}
                  businessName={currentBusiness?.name ?? null}
                  businessId={businessId}
                  logoUrl={logoUrl}
                  onLogoChange={setLogoUrl}
                />
              )}
              {view === "admin" && <AdminOverviewTab />}
            </>
          )}
        </main>
      </div>

      {/* Карточки клиента/оборудования, открытые с дашборда — тот же
          слайдовер-компонент, что и во вкладках "Клиенты"/"Оборудование",
          рендерится здесь, поверх всей оболочки (тот же приём, что и у
          самих вкладок), чтобы открывался БЕЗ перехода на другую вкладку. */}
      {dashClientId && <div className="slideover-backdrop" onClick={() => setDashClientId(null)} />}
      {dashClientId && (
        <ClientDetailPanel
          businessId={businessId}
          clientId={dashClientId}
          onClose={() => setDashClientId(null)}
          onDelete={(id) => void handleDashClientDelete(id)}
          onCreateRental={openCreateRentalForClient}
        />
      )}
      {dashEquipmentId && <div className="slideover-backdrop" onClick={() => setDashEquipmentId(null)} />}
      {dashEquipmentId && (
        <EquipmentDetailPanel
          businessId={businessId}
          equipmentId={dashEquipmentId}
          onClose={() => setDashEquipmentId(null)}
          // Полноценная форма редактирования живёт во вкладке "Оборудование"
          // (модалка EquipmentFormModal, локальная для EquipmentTab.tsx) — с
          // дашборда просто переходим туда с этой позицией в поиске, тем же
          // временным паттерном, что уже применялся для панели "Топ
          // оборудования по доходу" до этого раунда.
          onEdit={(id) => {
            setDashEquipmentId(null);
            const item = equipment.find((e) => e.id === id);
            navigate("equipment", { equipmentFilter: "all", search: item?.name ?? "" });
          }}
          onDeleted={() => setDashEquipmentId(null)}
        />
      )}

      {/* "Новая аренда" из шапки — тот же приём: рендерится здесь, поверх
          оболочки, доступна с любой вкладки, где видна кнопка (дашборд и
          "Аренды"), без setView. Своя отдельная кнопка "+ Новая аренда"
          внутри самой вкладки "Аренды" использует такую же модалку локально
          (см. RentalsTab.tsx) — они не конфликтуют, каждая ведёт своим
          независимым state. */}
      {showCreateRental && (
        <CreateRentalModal
          businessId={businessId}
          clients={clients}
          equipment={equipment}
          rentals={rentals}
          initialClientId={createRentalClientId ?? undefined}
          onClose={() => {
            setShowCreateRental(false);
            setCreateRentalClientId(null);
          }}
          onCreated={async () => {
            await Promise.all([reloadRentals(), reloadEquipment()]);
          }}
        />
      )}

      {confirmDialog}
    </div>
  );
}
