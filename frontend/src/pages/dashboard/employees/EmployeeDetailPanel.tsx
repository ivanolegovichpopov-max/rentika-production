/**
 * Слайд-панель с деталями сотрудника (65-й проход, "делаем всё, включая
 * Журнал действий") — тот же структурный idiom, что и
 * clients/ClientDetailPanel.tsx: .slideover/.slideover-head/.slideover-section,
 * открывается по клику на строку таблицы в EmployeesTab.tsx (см. openEmployeeId
 * там). Раньше единственным способом узнать "чем конкретно занимался этот
 * человек" было вручную фильтровать общий журнал действий и общую таблицу
 * нагрузки по имени — здесь и то, и другое собрано на одном экране сразу
 * при открытии карточки, без похода на вкладку «Активность».
 */
import { useEffect, useState } from "react";
import { api } from "../../../api/client";
import type { ActivityLogEntry, ActivityLogPage, Employee, EmployeeWorkload } from "../../../api/types";
import { Badge, EMPLOYEE_STATUS_META } from "../../../lib/statusMeta";
import { initials } from "../../../lib/format";
import { IconClose, IconEdit, IconHistory, IconMail, IconRestore, IconTrendUp } from "../../../lib/icons";
import { activityDetails, activityLabel } from "./activityLabels";

const PERIODS: { key: "7" | "30" | "90" | "all"; label: string }[] = [
  { key: "7", label: "7 дней" },
  { key: "30", label: "30 дней" },
  { key: "90", label: "90 дней" },
  { key: "all", label: "Весь период" },
];

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("ru-RU")} · ${d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
}

export function EmployeeDetailPanel({
  businessId,
  employee,
  positionTitle,
  workload,
  onClose,
  onOpenEdit,
  onDisable,
  onReactivate,
}: {
  businessId: string;
  employee: Employee;
  positionTitle: string;
  // Сводка нагрузки этого сотрудника — передаётся уже загруженной родителем
  // (EmployeesTab.tsx уже запрашивает /workload для всей команды на
  // вкладке «Активность»), лишний персональный запрос за теми же данными
  // не нужен.
  workload: EmployeeWorkload | undefined;
  onClose: () => void;
  onOpenEdit: () => void;
  onDisable: () => void;
  onReactivate: () => void;
}) {
  const [period, setPeriod] = useState<"7" | "30" | "90" | "all">("30");
  const [activity, setActivity] = useState<ActivityLogEntry[] | null>(null);

  useEffect(() => {
    setActivity(null);
    const qs = new URLSearchParams({ employee_id: employee.id, limit: "50" });
    if (period !== "all") qs.set("days", period);
    api
      .get<ActivityLogPage>(`/businesses/${businessId}/employees/activity?${qs.toString()}`)
      .then((page) => setActivity(page.items))
      .catch(() => setActivity([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId, employee.id, period]);

  const statusMeta = EMPLOYEE_STATUS_META[employee.status];

  return (
    <div className="slideover">
      <div className="slideover-head">
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span
            className={"avatar avatar-emp-" + employee.status}
            style={{ width: 36, height: 36, fontSize: "14px" }}
          >
            {initials(employee.name)}
          </span>
          <div>
            <h3>{employee.name}</h3>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "4px" }}>
              {statusMeta && <Badge meta={statusMeta} />}
              <span className="muted" style={{ fontSize: "12.5px" }}>{positionTitle}</span>
            </div>
          </div>
        </div>
        <button className="icon-btn" onClick={onClose}>
          <IconClose />
        </button>
      </div>

      <div className="slideover-section" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <button className="btn btn-sm" onClick={onOpenEdit}>
          <IconEdit /> Редактировать
        </button>
        {employee.status === "disabled" ? (
          <button className="btn btn-sm" onClick={onReactivate}>
            <IconRestore /> Включить
          </button>
        ) : (
          <button className="btn btn-sm btn-danger-ghost" onClick={onDisable}>Отключить</button>
        )}
      </div>

      <div className="slideover-section">
        <h4>Профиль</h4>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <IconMail /> {employee.email ?? "—"}
          </div>
          <div className="muted">
            {/* См. Employee.last_login_at — null означает "ни разу не входил",
                а не "скрыто" (видимость самого поля уже решена на бэке тем
                же периметром, что и email, см. EmployeeOut). */}
            {employee.last_login_at ? `Последний вход: ${fmtDateTime(employee.last_login_at)}` : "Ещё ни разу не входил в систему"}
          </div>
          <div className="muted">В команде с {new Date(employee.created_at).toLocaleDateString("ru-RU")}</div>
        </div>
      </div>

      {workload && (
        <div className="slideover-section">
          <h4 style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <IconTrendUp /> Нагрузка
          </h4>
          <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: "18px", fontWeight: 700 }}>{workload.rentals_created}</div>
              <div className="muted" style={{ fontSize: "11.5px" }}>аренд оформлено</div>
            </div>
            <div>
              <div style={{ fontSize: "18px", fontWeight: 700 }}>{workload.client_notes}</div>
              <div className="muted" style={{ fontSize: "11.5px" }}>заметок клиентам</div>
            </div>
            <div>
              <div style={{ fontSize: "18px", fontWeight: 700 }}>{workload.rental_photos}</div>
              <div className="muted" style={{ fontSize: "11.5px" }}>фото аренд загружено</div>
            </div>
          </div>
        </div>
      )}

      <div className="slideover-section">
        <h4 style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <IconHistory /> Личная активность
        </h4>
        <div className="segmented segmented-sm" style={{ marginBottom: "10px" }}>
          {PERIODS.map((p) => (
            <button key={p.key} className={period === p.key ? "active" : ""} onClick={() => setPeriod(p.key)}>
              {p.label}
            </button>
          ))}
        </div>
        {activity === null ? (
          <div className="muted">Загрузка…</div>
        ) : activity.length === 0 ? (
          <div className="empty-note">За этот период действий не найдено</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {activity.map((entry) => {
              const details = activityDetails(entry);
              return (
                <div key={entry.id} style={{ fontSize: "12.5px", paddingLeft: "10px", borderLeft: "2px solid var(--border)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                    <span style={{ fontWeight: 600 }}>{activityLabel(entry)}</span>
                    <span style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{fmtDateTime(entry.created_at)}</span>
                  </div>
                  {details.map((line, i) => (
                    <div key={i} className="muted" style={{ marginTop: "1px" }}>{line}</div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
