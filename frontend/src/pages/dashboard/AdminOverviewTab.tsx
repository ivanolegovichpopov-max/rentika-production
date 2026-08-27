import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { Business } from "../../api/types";

/**
 * Обзор всех бизнесов платформы для is_platform_admin — встроен внутрь
 * обычного Dashboard-шелла (сайдбар/топбар) как ещё один пункт навигации,
 * видимый только платформенному админу, а не отдельный экран без доступа
 * к остальной CRM (см. Home.tsx для истории этого решения). Read-only —
 * управлять данными чужих бизнесов отсюда по-прежнему нельзя.
 */
export function AdminOverviewTab() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<Business[]>("/businesses/admin/all")
      .then(setBusinesses)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="muted">Загрузка…</div>;

  return (
    <div className="table-wrap">
      <table>
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
              <td><div className="cell-name">{b.name}</div></td>
              <td>{b.status === "active" ? "Активен" : "Приостановлен"}</td>
              <td>{new Date(b.created_at).toLocaleDateString("ru-RU")}</td>
            </tr>
          ))}
          {businesses.length === 0 && (
            <tr>
              <td colSpan={3} className="muted">Бизнесов пока нет.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
