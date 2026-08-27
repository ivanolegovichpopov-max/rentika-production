import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useBusiness } from "../context/BusinessContext";
import { EquipmentTab } from "./dashboard/EquipmentTab";
import { ClientsTab } from "./dashboard/ClientsTab";
import { RentalsTab } from "./dashboard/RentalsTab";
import { EmployeesTab } from "./dashboard/EmployeesTab";
import { TwoFactorSettings } from "./TwoFactorSettings";

type Tab = "equipment" | "clients" | "rentals" | "employees" | "security";

export function Dashboard() {
  const { user, logout } = useAuth();
  const { businesses, currentBusinessId, setCurrentBusinessId, loading } = useBusiness();
  const [tab, setTab] = useState<Tab>("equipment");

  if (loading) return <div className="page-loading">Загрузка…</div>;

  if (!currentBusinessId) {
    return (
      <div className="page-loading">
        <p>У вас пока нет доступа ни к одному бизнесу.</p>
        <button onClick={() => void logout()}>Выйти</button>
      </div>
    );
  }

  const currentBusiness = businesses.find((b) => b.id === currentBusinessId);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">RENTIKA <span className="badge-tag">CRM</span></div>
        {businesses.length > 1 ? (
          <select value={currentBusinessId} onChange={(e) => setCurrentBusinessId(e.target.value)}>
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        ) : (
          <div className="business-name">{currentBusiness?.name}</div>
        )}
        <div className="topbar-spacer" />
        <span className="muted">{user?.email}</span>
        <button className="link" onClick={() => void logout()}>Выйти</button>
      </header>

      <nav className="tabs">
        <button className={tab === "equipment" ? "active" : ""} onClick={() => setTab("equipment")}>Оборудование</button>
        <button className={tab === "clients" ? "active" : ""} onClick={() => setTab("clients")}>Клиенты</button>
        <button className={tab === "rentals" ? "active" : ""} onClick={() => setTab("rentals")}>Аренды</button>
        <button className={tab === "employees" ? "active" : ""} onClick={() => setTab("employees")}>Сотрудники</button>
        <button className={tab === "security" ? "active" : ""} onClick={() => setTab("security")}>Безопасность</button>
      </nav>

      <main className="content">
        {tab === "equipment" && <EquipmentTab businessId={currentBusinessId} />}
        {tab === "clients" && <ClientsTab businessId={currentBusinessId} />}
        {tab === "rentals" && <RentalsTab businessId={currentBusinessId} />}
        {tab === "employees" && <EmployeesTab businessId={currentBusinessId} />}
        {tab === "security" && <TwoFactorSettings />}
      </main>
    </div>
  );
}
