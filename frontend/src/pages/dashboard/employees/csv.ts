/**
 * CSV для вкладки «Сотрудники» (66-й проход, "делаем всё"):
 * - шаблон + скачивание для упрощённого импорта сотрудников (см.
 *   EmployeeImportModal.tsx, POST .../employees/import на backend);
 * - экспорт журнала действий — тот же idiom, что exportRentalsCsv
 *   (rentals/csv.ts)/exportEquipmentCsv (equipment/csv.ts): полностью на
 *   клиенте, экспортируется ТЕКУЩИЙ загруженный список (с учётом периода и
 *   фильтров, применённых на вкладке «Активность» или в личной ленте
 *   EmployeeDetailPanel), отдельного backend-эндпоинта не заводим — тот же
 *   подход, что уже используется для остальных списков в проекте.
 */
import type { ActivityLogEntry, Employee, EmployeeWorkload } from "../../../api/types";
import { toCsv } from "../../../lib/csv";
import { activityDetails, activityLabel } from "./activityLabels";

function downloadCsv(csv: string, filename: string) {
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }); // BOM — чтобы Excel сразу открыл в UTF-8
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const EMPLOYEE_IMPORT_TEMPLATE_HEADER = ["email", "name", "position", "temporary_password"];

const EMPLOYEE_IMPORT_TEMPLATE_EXAMPLE = ["ivan@example.com", "Иван Петров", "Менеджер", "another long enough password"];

export function downloadEmployeeImportTemplate() {
  downloadCsv(toCsv(EMPLOYEE_IMPORT_TEMPLATE_HEADER, [EMPLOYEE_IMPORT_TEMPLATE_EXAMPLE]), "employees-import-template.csv");
}

const ACTIVITY_EXPORT_HEADER = ["date", "time", "employee", "action", "resource", "details"];

export function exportActivityCsv(items: ActivityLogEntry[], filenamePrefix: string) {
  const rows = items.map((entry) => {
    const d = new Date(entry.created_at);
    return [
      d.toLocaleDateString("ru-RU"),
      d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
      entry.employee_name ?? "—",
      activityLabel(entry),
      entry.resource,
      activityDetails(entry).join("; "),
    ];
  });
  downloadCsv(toCsv(ACTIVITY_EXPORT_HEADER, rows), `${filenamePrefix} ${new Date().toISOString().slice(0, 10)}.csv`);
}

const EMPLOYEE_STATUS_LABEL: Record<string, string> = { active: "Активен", invited: "Приглашён", disabled: "Отключён" };

// Экспорт списка команды (67-й проход — раньше CSV-экспорт был только у
// журнала действий, самого списка сотрудников выгрузить было нельзя, в
// отличие от оборудования/клиентов). Экспортируется ТЕКУЩИЙ отфильтрованный
// список (см. вызов из EmployeesTab.tsx — передаётся filteredEmployees, а
// не весь employees), тем же принципом, что и остальные CSV в проекте.
export function exportEmployeesCsv(employees: Employee[], positionTitle: (id: string | null) => string) {
  const header = ["name", "email", "phone", "position", "status", "last_login", "hired_at"];
  const rows = employees.map((e) => [
    e.name,
    e.email ?? "",
    e.phone ?? "",
    e.is_owner ? "Владелец" : positionTitle(e.position_id),
    EMPLOYEE_STATUS_LABEL[e.status] ?? e.status,
    e.last_login_at ? new Date(e.last_login_at).toLocaleString("ru-RU") : "",
    new Date(e.created_at).toLocaleDateString("ru-RU"),
  ]);
  downloadCsv(toCsv(header, rows), `Команда ${new Date().toISOString().slice(0, 10)}.csv`);
}

// Экспорт сводки нагрузки (67-й проход — до этого "Экспорт CSV" на вкладке
// «Активность» выгружал только журнал, саму таблицу нагрузки с трендом
// нельзя было сохранить отдельно).
export function exportWorkloadCsv(workload: EmployeeWorkload[], filenamePrefix: string) {
  const header = ["employee", "rentals_created", "client_notes", "rental_photos"];
  const rows = workload.map((w) => [w.employee_name, String(w.rentals_created), String(w.client_notes), String(w.rental_photos)]);
  downloadCsv(toCsv(header, rows), `${filenamePrefix} ${new Date().toISOString().slice(0, 10)}.csv`);
}
