import { useEffect, useState, type ReactElement, type SVGProps } from "react";
import { useAuth } from "../context/AuthContext";
import { useBusiness } from "../context/BusinessContext";
import { DataProvider, useData } from "../context/DataContext";
import { api } from "../api/client";
import type { Employee } from "../api/types";
import { DashboardTab } from "./dashboard/DashboardTab";
import { AdminOverviewTab } from "./dashboard/AdminOverviewTab";
import { EquipmentTab } from "./dashboard/EquipmentTab";
import { ClientsTab } from "./dashboard/ClientsTab";
import { RentalsTab } from "./dashboard/RentalsTab";
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
  IconFinance,
  IconEmployees,
  IconSecurity,
  IconAdmin,
} from "../lib/icons";

export type View = "dashboard" | "equipment" | "clients" | "rentals" | "finance" | "employees" | "security" | "admin";

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
  businesses: { id: string; name: string }[];
  setCurrentBusinessId: (id: string) => void;
}) {
  const { user, logout } = useAuth();
  const { equipment, clients, rentals, loading } = useData();
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

  useEffect(() => {
    api.get<Employee[]>(`/businesses/${businessId}/employees`).then(setEmployees).catch(() => {});
  }, [businessId]);

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
    { key: "finance", label: "Финансы", icon: IconFinance },
    { key: "employees", label: "Сотрудники", icon: IconEmployees, count: activeEmployees.length },
    { key: "security", label: "Безопасность", icon: IconSecurity },
    // Видно только платформенному админу — обзор ВСЕХ бизнесов на платформе
    // (для техподдержки), встроенный сюда же вместо отдельного экрана без
    // доступа к остальной CRM (см. историю решения в Home.tsx).
    ...(user?.is_platform_admin ? [{ key: "admin" as const, label: "Все бизнесы", icon: IconAdmin }] : []),
  ];

  const TITLES: Record<View, [string, string]> = {
    dashboard: ["Дашборд", "Сводка на сегодня"],
    equipment: ["Оборудование", equipment.length + " позиций в парке"],
    clients: ["Клиенты", clients.length + " в базе"],
    rentals: ["Аренды", overdueCount ? overdueCount + " просрочено — нужно связаться с клиентом" : "Все аренды под контролем"],
    finance: ["Финансы", "Доходы, депозиты и история возвратов"],
    employees: ["Сотрудники", "Должности и права доступа"],
    security: ["Безопасность", "Двухфакторная аутентификация"],
    admin: ["Все бизнесы", "Обзор платформы для техподдержки"],
  };

  const currentBusiness = businesses.find((b) => b.id === businessId);
  const [title, subtitle] = TITLES[view];
  const showSearch = view === "equipment" || view === "clients" || view === "rentals";
  const searchPlaceholder =
    view === "equipment" ? "Поиск по оборудованию…" : view === "clients" ? "Поиск по клиентам…" : "Поиск по клиентам и оборудованию…";

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
              {view === "dashboard" && <DashboardTab navigate={navigate} businessId={businessId} />}
              {view === "equipment" && (
                <EquipmentTab businessId={businessId} search={search} filter={equipmentFilter} setFilter={setEquipmentFilter} />
              )}
              {view === "clients" && <ClientsTab businessId={businessId} search={search} />}
              {view === "rentals" && (
                <RentalsTab businessId={businessId} search={search} filter={rentalFilter} setFilter={setRentalFilter} />
              )}
              {view === "finance" && <FinanceTab period={financePeriod} setPeriod={setFinancePeriod} />}
              {view === "employees" && <EmployeesTab businessId={businessId} />}
              {view === "security" && <TwoFactorSettings />}
              {view === "admin" && <AdminOverviewTab />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
