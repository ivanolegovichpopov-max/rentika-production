import { useEffect, useState, type ReactElement, type SVGProps } from "react";
import { useAuth } from "../context/AuthContext";
import { useBusiness } from "../context/BusinessContext";
import { DataProvider, useData } from "../context/DataContext";
import { api, ApiError } from "../api/client";
import type { Business, Employee, NotesMode } from "../api/types";
import { DashboardTab } from "./dashboard/DashboardTab";
import { AdminOverviewTab } from "./dashboard/AdminOverviewTab";
import { EquipmentTab, EquipmentDetailPanel } from "./dashboard/EquipmentTab";
import { ClientsTab, ClientDetailPanel } from "./dashboard/ClientsTab";
import { RentalsTab } from "./dashboard/RentalsTab";
import { CalendarTab } from "./dashboard/CalendarTab";
import { FinanceTab } from "./dashboard/FinanceTab";
import { EmployeesTab } from "./dashboard/EmployeesTab";
import { TwoFactorSettings } from "./TwoFactorSettings";
import { rentalDisplayStatus } from "../lib/statusMeta";
import { colorFromId, initials } from "../lib/format";
import { periodFor, type FinancePeriod } from "../lib/financeCalc";
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
  IconSecurity,
  IconAdmin,
} from "../lib/icons";

export type View = "dashboard" | "equipment" | "clients" | "rentals" | "calendar" | "finance" | "employees" | "security" | "admin";

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
  const { equipment, clients, rentals, loading, reloadClients } = useData();
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

  async function handleDashClientDelete(id: string) {
    if (!confirm("Удалить этого клиента?")) return;
    try {
      await api.delete(`/businesses/${businessId}/clients/${id}`);
      if (dashClientId === id) setDashClientId(null);
      await reloadClients();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Не удалось удалить");
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

  /** Переход между разделами со сбросом поиска и (опционально) выставлением
   * фильтра — аналог обработчика "dash-stat"/"filter-by-category" в демо. */
  function navigate(
    target: View,
    opts?: { equipmentFilter?: string; rentalFilter?: string; search?: string; finance30?: boolean }
  ) {
    setView(target);
    setSearch(opts?.search ?? "");
    if (opts?.equipmentFilter) setEquipmentFilter(opts.equipmentFilter);
    if (opts?.rentalFilter) setRentalFilter(opts.rentalFilter);
    if (opts?.finance30) setFinancePeriod(periodFor("30", rentals));
  }

  const activeEmployees = employees.filter((e) => e.status !== "disabled");
  const overdueCount = rentals.filter((r) => rentalDisplayStatus(r) === "overdue").length;

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
    { key: "security", label: "Безопасность", icon: IconSecurity },
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
    rentals: ["Аренды", overdueCount ? overdueCount + " просрочено — нужно связаться с клиентом" : "Все аренды под контролем"],
    calendar: ["Календарь занятости", "Занятость оборудования"],
    finance: ["Финансы", "Доходы, депозиты и история возвратов"],
    employees: ["Сотрудники", "Должности и права доступа"],
    security: ["Безопасность", "Двухфакторная аутентификация"],
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
            <div className="sh1" />
            <div className="sh2" />
          </div>
          <div>
            <div className="brand-name">
              RENTIKA<span className="brand-tag">CRM</span>
            </div>
            <div className="brand-sub">{currentBusiness?.name || "Прокат оборудования"}</div>
          </div>
        </button>

        {businesses.length > 1 && (
          <select value={businessId} onChange={(e) => setCurrentBusinessId(e.target.value)}>
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
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

        <div className="sidebar-spacer" />

        <div className="team-block">
          <div className="team-label">Команда</div>
          <div className="team-list">
            {activeEmployees.slice(0, 6).map((emp) => (
              <div className="team-row" key={emp.id} title={emp.name}>
                <span className="avatar" style={{ background: colorFromId(emp.id) }}>{initials(emp.name)}</span>
                <span className="team-name">{emp.name}</span>
              </div>
            ))}
          </div>
        </div>

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
          {(view === "rentals" || view === "dashboard") && (
            <button className="btn btn-primary" onClick={() => navigate("rentals", { rentalFilter: view === "dashboard" ? "active" : rentalFilter })}>
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
                <EquipmentTab businessId={businessId} search={search} filter={equipmentFilter} setFilter={setEquipmentFilter} />
              )}
              {view === "clients" && <ClientsTab businessId={businessId} search={search} />}
              {view === "rentals" && (
                <RentalsTab businessId={businessId} search={search} filter={rentalFilter} setFilter={setRentalFilter} />
              )}
              {view === "calendar" && <CalendarTab businessId={businessId} search={search} />}
              {view === "finance" && <FinanceTab period={financePeriod} setPeriod={setFinancePeriod} />}
              {view === "employees" && <EmployeesTab businessId={businessId} />}
              {view === "security" && <TwoFactorSettings />}
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
    </div>
  );
}
