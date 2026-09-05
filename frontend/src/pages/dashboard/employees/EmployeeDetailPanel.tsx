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
import type { ActivityLogEntry, ActivityLogPage, Employee, EmployeeWorkload, EmployeeWorkloadTimeseries } from "../../../api/types";
import { Badge, EMPLOYEE_STATUS_META } from "../../../lib/statusMeta";
import { initials, tenureLabel } from "../../../lib/format";
import { WorkloadSparkline, trendBadge } from "./workloadTrend";
import { IconAlert, IconClose, IconEdit, IconHistory, IconMail, IconMessages, IconRestore, IconTrendUp } from "../../../lib/icons";
import { activityDetails, activityLabel } from "./activityLabels";
import { exportActivityCsv } from "./csv";

const PERIODS: { key: "7" | "30" | "90" | "all"; label: string }[] = [
  { key: "7", label: "7 дней" },
  { key: "30", label: "30 дней" },
  { key: "90", label: "90 дней" },
  { key: "all", label: "Весь период" },
];

// Мини-индикатор процесса найма (доп. проход после 67-го, п.6) — три шага,
// каждый — просто производная от уже имеющихся полей Employee, без нового
// состояния на бэке: "приглашён" верно всегда (иначе карточки бы не было),
// "2FA включена"/"первый вход" — по totp_enabled/last_login_at. Раньше,
// чтобы понять, на каком шаге застрял конкретный человек, приходилось
// сопоставлять статус и "последний вход" в голове.
const ONBOARDING_STEPS: { key: string; label: string; done: (e: Employee) => boolean }[] = [
  { key: "invited", label: "Приглашён", done: () => true },
  { key: "2fa", label: "2FA включена", done: (e) => e.totp_enabled === true },
  { key: "login", label: "Первый вход", done: (e) => !!e.last_login_at },
];

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("ru-RU")} · ${d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
}

export function EmployeeDetailPanel({
  businessId,
  employee,
  positionTitle,
  positionRequires2fa,
  workload,
  onClose,
  onOpenEdit,
  onDisable,
  onReactivate,
  onMessage,
}: {
  businessId: string;
  employee: Employee;
  positionTitle: string;
  // Требует ли текущая должность сотрудника обязательную 2FA (доп. проход
  // после 67-го, п.15 "подсветка пробела в защите") — передаётся родителем
  // (у него уже загружен весь список positions, здесь второго запроса не
  // заводим). undefined для владельца/без должности — там принудительная
  // 2FA не применяется.
  positionRequires2fa?: boolean;
  // Сводка нагрузки этого сотрудника — передаётся уже загруженной родителем
  // (EmployeesTab.tsx уже запрашивает /workload для всей команды на
  // вкладке «Активность»), лишний персональный запрос за теми же данными
  // не нужен.
  workload: EmployeeWorkload | undefined;
  onClose: () => void;
  onOpenEdit: () => void;
  onDisable: () => void;
  onReactivate: () => void;
  // "Написать сообщение" (67-й проход) — переключает вкладку на «Сообщения»
  // и открывает/находит личный диалог с этим сотрудником (см. onMessageEmployee
  // в EmployeesTab.tsx / navigate(messageEmployeeId) в Dashboard.tsx).
  // Отсутствует, если владелец открыл карточку не из основного дашборда.
  onMessage?: () => void;
}) {
  const [period, setPeriod] = useState<"7" | "30" | "90" | "all">("30");
  const [activity, setActivity] = useState<ActivityLogEntry[] | null>(null);
  // Дневная динамика для спарклайна (67-й проход) — свой отдельный запрос,
  // т.к. /workload (переданный родителем через проп workload) не содержит
  // постолбцовой разбивки по дням, только итог за период и предыдущий.
  const [trend, setTrend] = useState<number[] | null>(null);

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

  useEffect(() => {
    if (period === "all") {
      setTrend(null);
      return;
    }
    api
      .get<EmployeeWorkloadTimeseries>(`/businesses/${businessId}/employees/${employee.id}/workload/timeseries?days=${period}`)
      .then((res) => setTrend(res.points.map((pt) => pt.rentals_created + pt.client_notes + pt.rental_photos)))
      .catch(() => setTrend(null));
  }, [businessId, employee.id, period]);

  const statusMeta = EMPLOYEE_STATUS_META[employee.status];

  return (
    <div className="slideover">
      <div className="slideover-head">
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          {employee.photo_url ? (
            <img
              src={employee.photo_url}
              alt=""
              style={{ width: 36, height: 36, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
            />
          ) : (
            <span
              className={"avatar avatar-emp-" + employee.status}
              style={{ width: 36, height: 36, fontSize: "14px" }}
            >
              {initials(employee.name)}
            </span>
          )}
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
        {onMessage && (
          <button className="btn btn-sm" onClick={onMessage}>
            <IconMessages /> Написать сообщение
          </button>
        )}
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
        {!employee.is_owner && (
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px", marginBottom: "10px", fontSize: "11.5px" }}>
            {ONBOARDING_STEPS.map((step, i) => {
              const done = step.done(employee);
              return (
                <span key={step.key} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  {i > 0 && <span className="muted" style={{ opacity: 0.6 }}>→</span>}
                  <span className={done ? undefined : "muted"} style={{ color: done ? "var(--good-ink)" : undefined, fontWeight: done ? 600 : 400 }}>
                    {done ? "✓" : "○"} {step.label}
                  </span>
                </span>
              );
            })}
          </div>
        )}
        {positionRequires2fa && employee.totp_enabled === false && (
          // Пробел в защите (доп. проход после 67-го, п.15) — должность
          // требует обязательную 2FA, но у самого аккаунта она не включена;
          // на бэке это не блокируется задним числом (require_2fa проверяется
          // при входе, а не ретроактивно для уже действующих сессий/паролей),
          // поэтому владельцу стоит явно показать разрыв, а не полагаться на
          // то, что он сам сопоставит два разных экрана.
          <div className="form-note" style={{ marginBottom: "10px", display: "flex", alignItems: "center", gap: "6px" }}>
            <IconAlert style={{ width: 13, height: 13, flexShrink: 0 }} />
            Должность требует обязательную 2FA, но у сотрудника она не включена
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <IconMail /> {employee.email ?? "—"}
          </div>
          {employee.phone && <div>{employee.phone}</div>}
          <div className="muted">
            {/* См. Employee.last_login_at — null означает "ни разу не входил",
                а не "скрыто" (видимость самого поля уже решена на бэке тем
                же периметром, что и email, см. EmployeeOut). */}
            {employee.last_login_at ? `Последний вход: ${fmtDateTime(employee.last_login_at)}` : "Ещё ни разу не входил в систему"}
          </div>
          <div className="muted">
            В команде с {new Date(employee.created_at).toLocaleDateString("ru-RU")} ({tenureLabel(employee.created_at)})
          </div>
          {employee.notes && (
            // Заметка владельца о сотруднике (67-й проход) — видна только
            // владельцу/платформенному админу (та же видимость, что email/
            // телефон, см. _employee_out на бэке), поэтому показываем прямо
            // здесь без дополнительного скрытия на фронте.
            <div className="form-note" style={{ marginTop: "4px", whiteSpace: "pre-wrap" }}>{employee.notes}</div>
          )}
        </div>
      </div>

      {workload && (
        <div className="slideover-section">
          <h4 style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <IconTrendUp /> Нагрузка
          </h4>
          {trend && trend.length >= 2 && (
            <div style={{ margin: "4px 0 10px" }}>
              <WorkloadSparkline values={trend} />
            </div>
          )}
          <div style={{ display: "flex", gap: "14px", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: "18px", fontWeight: 700 }}>
                {workload.rentals_created}
                {trendBadge(workload.rentals_created, workload.rentals_created_prev)}
              </div>
              <div className="muted" style={{ fontSize: "11.5px" }}>аренд оформлено</div>
            </div>
            <div>
              <div style={{ fontSize: "18px", fontWeight: 700 }}>
                {workload.client_notes}
                {trendBadge(workload.client_notes, workload.client_notes_prev)}
              </div>
              <div className="muted" style={{ fontSize: "11.5px" }}>заметок клиентам</div>
            </div>
            <div>
              <div style={{ fontSize: "18px", fontWeight: 700 }}>
                {workload.rental_photos}
                {trendBadge(workload.rental_photos, workload.rental_photos_prev)}
              </div>
              <div className="muted" style={{ fontSize: "11.5px" }}>фото аренд загружено</div>
            </div>
          </div>
        </div>
      )}

      <div className="slideover-section">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <h4 style={{ display: "flex", alignItems: "center", gap: "6px", margin: 0 }}>
            <IconHistory /> Личная активность
          </h4>
          {/* Персональный CSV-экспорт (66-й проход) — полностью на клиенте,
              тот же idiom, что exportRentalsCsv/exportEquipmentCsv: экспортируется
              ТЕКУЩИЙ загруженный список (с учётом периода выше), без отдельного
              backend-эндпоинта. */}
          {activity && activity.length > 0 && (
            <button
              className="btn btn-sm"
              onClick={() => exportActivityCsv(activity, `Активность ${employee.name}`)}
            >
              Экспорт CSV
            </button>
          )}
        </div>
        <div className="segmented segmented-sm" style={{ margin: "10px 0" }}>
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
