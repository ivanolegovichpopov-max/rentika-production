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
import type { ActivityLogEntry } from "../../../api/types";
import { toCsv } from "../../../lib/csv";
import { activityDetails, activityLabel } from "./activityLabels";

export const EMPLOYEE_IMPORT_TEMPLATE_HEADER = ["email", "name", "position", "temporary_password"];

const EMPLOYEE_IMPORT_TEMPLATE_EXAMPLE = ["ivan@example.com", "Иван Петров", "Менеджер", "another long enough password"];

export function downloadEmployeeImportTemplate() {
  const csv = toCsv(EMPLOYEE_IMPORT_TEMPLATE_HEADER, [EMPLOYEE_IMPORT_TEMPLATE_EXAMPLE]);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }); // BOM — чтобы Excel сразу открыл в UTF-8
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "employees-import-template.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
  const csv = toCsv(ACTIVITY_EXPORT_HEADER, rows);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filenamePrefix} ${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
