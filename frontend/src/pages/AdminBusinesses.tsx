import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import type { Business } from "../api/types";

/**
 * Единственный экран, доступный только is_platform_admin (Ивану) — обзор
 * всех бизнесов на платформе для техподдержки. Управление их данными отсюда
 * сознательно не сделано: если понадобится "войти как" конкретный бизнес
 * для диагностики, это отдельная, более осторожная фича (impersonation с
 * обязательной записью в audit_log), не часть этой версии.
 */
export function AdminBusinesses() {
  const { user, logout } = useAuth();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<Business[]>("/businesses/admin/all").then(setBusinesses).finally(() => setLoading(false));
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">RENTIKA <span className="badge-tag">ADMIN</span></div>
        <div className="topbar-spacer" />
        <span className="muted">{user?.email}</span>
        <button className="btn btn-ghost" onClick={() => void logout()}>Выйти</button>
      </header>
      <main className="content">
        <h2>Все бизнесы на платформе</h2>
        {loading ? (
          <div className="muted">Загрузка…</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Название</th>
                <th>Статус</th>
                <th>Создан</th>
              </tr>
            </thead>
            <tbody>
              {businesses.map((b) => (
                <tr key={b.id}>
                  <td>{b.name}</td>
                  <td>{b.status === "active" ? "Активен" : "Приостановлен"}</td>
                  <td>{new Date(b.created_at).toLocaleDateString("ru-RU")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}
