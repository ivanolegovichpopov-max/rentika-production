export type ResourceType = "clients" | "equipment" | "rentals" | "finance" | "employees";
export type PermissionLevel = "none" | "view" | "edit";

export interface User {
  id: string;
  email: string;
  is_platform_admin: boolean;
  totp_enabled: boolean;
}

export type NotesMode = "owner_only" | "everyone";

// Кто кому может писать личные сообщения (см. MessagesTab.tsx) — отдельная
// от notes_mode настройка, тоже owner_only по умолчанию. НЕ путать с ACL-правом
// "employees" (доступ к разделу «Сотрудники») — это разные вопросы.
export type MessagingPermission = "owner_only" | "everyone";

export interface Business {
  id: string;
  name: string;
  status: "active" | "suspended";
  notes_mode: NotesMode;
  messaging_permission: MessagingPermission;
  // Логотип бизнеса — либо ссылка на изображение, либо data: URL (см.
  // AccountSettings.tsx — загрузка читает файл через FileReader и шлёт его
  // как data: URL, отдельного файлового хранилища у проекта нет). null —
  // логотип не задан, тогда сайдбар рисует дефолтную геометрическую марку.
  logo_url: string | null;
  created_at: string;
}

export interface Position {
  id: string;
  title: string;
  permissions: { resource: ResourceType; level: PermissionLevel }[];
}

export interface Employee {
  id: string;
  user_id: string;
  name: string;
  position_id: string | null;
  is_owner: boolean;
  status: "invited" | "active" | "disabled";
  created_at: string;
}

export interface Equipment {
  id: string;
  name: string;
  category: string;
  code: string | null;
  daily_rate: number;
  deposit: number;
  period_days: number | null;
  period_price: number | null;
  period_price_after: number | null;
  status: "available" | "rented" | "maintenance" | "retired";
  maintenance_until: string | null;
  notes: string | null;
  created_at: string;
}

export interface EquipmentCategory {
  id: string;
  name: string;
  created_at: string;
}

export interface EquipmentImportRowResult {
  row: number;
  ok: boolean;
  name: string;
  error: string | null;
  equipment: Equipment | null;
}

export interface EquipmentImportResult {
  total: number;
  created: number;
  failed: number;
  results: EquipmentImportRowResult[];
}

export interface Client {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  doc: string | null;
  rating: "normal" | "watch" | "blacklist";
  notes: string | null;
  created_at: string;
}

export interface RentalItem {
  equipment_id: string;
  daily_rate_snapshot: number;
  period_days_snapshot: number | null;
  period_price_snapshot: number | null;
  period_price_after_snapshot: number | null;
}

export interface Rental {
  id: string;
  client_id: string;
  start_date: string;
  end_date: string;
  actual_return: string | null;
  // "overdue" в этом статусе backend никогда не хранит явно (см. financeCalc.ts /
  // rentalDisplayStatus) — реальные значения в БД только booked/active/returned/
  // cancelled, "просрочено" вычисляется на фронте по датам, как в демо-прототипе.
  status: "booked" | "active" | "overdue" | "returned" | "cancelled";
  damage_fee: number;
  discount: number;
  // Свободный текст состояния при выдаче/возврате (демо: r.issueNotes/
  // r.returnNotes) — печатается в актах приёма-передачи и возврата.
  issue_notes: string | null;
  return_notes: string | null;
  created_at: string;
  // Финансовая разбивка — считается backend'ом (см. app/services/pricing.py
  // compute_rental_breakdown), 1:1 повторяет формулы демо-прототипа.
  planned_days: number;
  actual_days: number;
  late_days: number;
  base: number;
  late_fee: number;
  total: number;
  amount: number; // алиас total, для обратной совместимости
  deposit_total: number; // сумма ТЕКУЩИХ deposit оборудования в позициях (не снимок на момент брони — см. заметки о деплое)
  items: RentalItem[];
}

// Личная настройка дашборда текущего сотрудника — GET/PUT
// /businesses/{id}/dashboard-prefs. Набор валидных id блоков объявлен рядом
// с использованием, в DashboardTab.tsx. hidden — скрытые блоки; stat_order —
// порядок стат-плашек верхнего ряда (только горизонтальный reorder);
// panel_rows — раскладка панелей построчно сверху вниз, 1 или 2 id в строке
// (2 id = панели показаны рядом на одном уровне). Переименования (rename)
// больше нет — заменено перетаскиванием блоков по прямой просьбе пользователя.
export interface DashboardPrefs {
  hidden: string[];
  stat_order: string[];
  panel_rows: string[][];
}

// Одна запись доски «Заметки/новости» дашборда — GET/POST/DELETE
// /businesses/{id}/notes, режим — PUT /businesses/{id}/notes/mode.
export interface DashboardNote {
  id: string;
  author_name: string;
  text: string;
  created_at: string;
  can_delete: boolean;
  // Отметка "выполнено" — простой чекбокс на записи, НЕ полноценный
  // чек-лист/трекер задач (см. app/models/business.py::DashboardNote).
  // Переключать может тот же, кому доступно удаление (can_delete).
  done: boolean;
}

// Личные сообщения — GET /businesses/{id}/messaging-directory (кому можно
// написать), GET/POST /businesses/{id}/conversations, GET/POST
// .../conversations/{id}/messages, PUT /businesses/{id}/messaging-mode.
export type ConversationType = "dm" | "group";

export interface DirectoryEmployee {
  id: string;
  name: string;
  is_owner: boolean;
}

export interface ChatMessage {
  id: string;
  author_name: string;
  text: string;
  created_at: string;
  is_mine: boolean;
}

export interface Conversation {
  id: string;
  type: ConversationType;
  // Для group — название группы; для dm — имя собеседника (уже вычислено
  // бэкендом — фронту не нужно самому разбирать участников).
  display_name: string;
  participant_count: number;
  last_message_preview: string | null;
  last_message_at: string | null;
  unread_count: number;
  created_at: string;
}
