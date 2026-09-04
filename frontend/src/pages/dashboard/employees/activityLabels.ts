/**
 * Человекочитаемые подписи и детали для общего журнала действий бизнеса
 * (64-й/65-й проходы) — вынесено из EmployeesTab.tsx в отдельный модуль
 * (65-й проход, split на sub-tabs), потому что теперь читается из двух
 * мест: общего журнала на вкладке «Активность» и персональной ленты в
 * EmployeeDetailPanel.
 */
import type { ActivityLogEntry } from "../../../api/types";
import { EMPLOYEE_STATUS_META } from "../../../lib/statusMeta";

// Набор совпадает 1:1 со всеми log_action(...) вызовами по бэкенду
// (AuditLog пишется на каждое значимое действие уже давно, просто раньше
// нигде не читался обратно владельцу бизнеса за пределами одной конкретной
// аренды, см. RentalHistorySection.tsx). Формулировки, как и там,
// пассивные/безличные ("Аренда создана") — не нужно выбирать род глагола
// под сотрудника, автор указывается отдельной строкой.
export const ACTIVITY_LABELS: Record<string, string> = {
  "business:register": "Бизнес зарегистрирован",
  "user:change_password": "Пароль аккаунта изменён",
  "user:2fa_enabled": "Включена двухфакторная аутентификация",
  "user:2fa_disabled": "Отключена двухфакторная аутентификация",
  "client:create": "Клиент создан",
  "client:update": "Клиент изменён",
  "client:delete": "Клиент удалён",
  "client:restore": "Клиент восстановлен",
  "client:merge": "Клиенты объединены",
  "client:import": "Импортированы клиенты",
  "client_note:create": "Добавлена заметка о клиенте",
  "client_note:update": "Заметка о клиенте изменена",
  "client_note:delete": "Заметка о клиенте удалена",
  "client_document:create": "Загружен документ клиента",
  "client_document:delete": "Документ клиента удалён",
  "employee:invite": "Сотрудник приглашён",
  "employee:update": "Данные сотрудника изменены",
  "employee:disable": "Сотрудник отключён",
  "employee:reset_password": "Сотруднику сброшен пароль",
  // activate (66-й проход) — реальный переход invited -> active при первом
  // входе (см. _activate_invited_employees в app/api/routes/auth.py); import
  // — итог массового CSV-импорта (см. import_employees в employees.py).
  "employee:activate": "Сотрудник подтвердил приглашение (первый вход)",
  "employee:import": "Импортированы сотрудники",
  "position:create": "Должность создана",
  "position:rename": "Должность переименована",
  "position:delete": "Должность удалена",
  "position:update_permissions": "Изменены права должности",
  // reorder/update_require_2fa — 66-й проход, "Должности и права".
  "position:reorder": "Изменён порядок должностей",
  "position:update_require_2fa": "Изменено требование двухфакторной аутентификации для должности",
  "equipment:create": "Оборудование добавлено",
  "equipment:update": "Оборудование изменено",
  "equipment:delete": "Оборудование удалено",
  "equipment:restore": "Оборудование восстановлено",
  "equipment:import": "Импортировано оборудование",
  "equipment_category:create": "Категория оборудования создана",
  "equipment_category:rename": "Категория оборудования переименована",
  "equipment_category:delete": "Категория оборудования удалена",
  "equipment_category:reorder": "Изменён порядок категорий оборудования",
  "equipment_warehouse:create": "Склад создан",
  "equipment_warehouse:rename": "Склад переименован",
  "equipment_warehouse:delete": "Склад удалён",
  "equipment_warehouse:reorder": "Изменён порядок складов",
  "rental:create": "Аренда создана",
  "rental:issue": "Оборудование выдано",
  "rental:edit": "Аренда изменена",
  "rental:return": "Аренда закрыта (возврат)",
  "rental:return_items": "Частичный возврат позиций",
  "rental:cancel": "Аренда отменена",
  "rental:deposit_return": "Депозит отмечен возвращённым",
  "rental:deposit_return_undo": "Отметка о возврате депозита снята",
  "rental:payment": "Записан платёж",
  "rental:payment_correction": "Платёж исправлен",
  "rental_photo:create": "Загружено фото аренды",
  "rental_photo:delete": "Фото аренды удалено",
  "conversation:create": "Создана беседа",
  "message:create": "Отправлено сообщение",
  "dashboard_note:create": "Добавлена заметка на дашборд",
  "dashboard_note:update": "Заметка на дашборде изменена",
  "dashboard_note:delete": "Заметка на дашборде удалена",
};

export function activityLabel(entry: ActivityLogEntry): string {
  return ACTIVITY_LABELS[`${entry.resource}:${entry.action}`] ?? `${entry.resource} · ${entry.action}`;
}

function statusLabel(value: unknown): string {
  if (typeof value !== "string") return "—";
  return EMPLOYEE_STATUS_META[value]?.label ?? value;
}

// Та же карта разделов, что RESOURCES в EmployeesTab.tsx — продублирована
// здесь маленьким объектом, а не импортирована оттуда, чтобы не заводить
// циклический импорт (EmployeesTab.tsx сам импортирует этот модуль).
const RESOURCE_LABELS: Record<string, string> = {
  equipment: "Оборудование",
  clients: "Клиенты",
  rentals: "Аренды",
  finance: "Финансы",
  employees: "Сотрудники",
};

const PERMISSION_LEVEL_LABELS: Record<string, string> = { none: "нет доступа", view: "просмотр", edit: "просмотр и редактирование" };

function levelLabel(value: unknown): string {
  if (typeof value !== "string") return "—";
  return PERMISSION_LEVEL_LABELS[value] ?? value;
}

// "было → стало" из meta (65-й проход) — тот же idiom "<поле>_before"/
// "<поле>_after", что и editDetails() в RentalHistorySection.tsx, теперь
// заведён и для action="update" на resource="employee" (см. update_employee
// в app/api/routes/employees.py) и action="rename" на resource="position"
// (см. rename_position в app/api/routes/positions.py). Раньше запись
// журнала показывала только сам факт "Данные сотрудника изменены"/
// "Должность переименована" без каких-либо подробностей.
export function activityDetails(entry: ActivityLogEntry): string[] {
  const meta = entry.meta;
  if (!meta) return [];
  const lines: string[] = [];
  if (entry.resource === "employee" && entry.action === "update") {
    if ("name_before" in meta) lines.push(`имя: ${String(meta.name_before)} → ${String(meta.name_after)}`);
    if ("position_before" in meta) {
      lines.push(`должность: ${meta.position_before ? String(meta.position_before) : "без должности"} → ${
        meta.position_after ? String(meta.position_after) : "без должности"
      }`);
    }
    if ("status_before" in meta) lines.push(`статус: ${statusLabel(meta.status_before)} → ${statusLabel(meta.status_after)}`);
  }
  if (entry.resource === "position" && entry.action === "rename" && "title_before" in meta) {
    lines.push(`название: ${String(meta.title_before)} → ${String(meta.title_after)}`);
  }
  // update_permissions (66-й проход) — meta.changes: список только
  // ИЗМЕНИВШИХСЯ ресурсов с {resource, level_before, level_after} (см.
  // update_permissions в app/api/routes/positions.py); раньше meta хранила
  // только полный список permissions ПОСЛЕ изменения, без "было", так что
  // журнал не мог показать реальную разницу для этого действия.
  if (entry.resource === "position" && entry.action === "update_permissions" && Array.isArray(meta.changes)) {
    for (const change of meta.changes as Record<string, unknown>[]) {
      const resource = typeof change.resource === "string" ? change.resource : "";
      lines.push(
        `${RESOURCE_LABELS[resource] ?? resource}: ${levelLabel(change.level_before)} → ${levelLabel(change.level_after)}`
      );
    }
  }
  if (entry.resource === "position" && entry.action === "update_require_2fa" && "require_2fa_before" in meta) {
    const before = meta.require_2fa_before ? "включена" : "выключена";
    const after = meta.require_2fa_after ? "включена" : "выключена";
    lines.push(`обязательная 2FA: ${before} → ${after}`);
  }
  if (entry.resource === "position" && entry.action === "create" && "copied_permissions_from" in meta) {
    lines.push("права скопированы с другой должности");
  }
  return lines;
}
