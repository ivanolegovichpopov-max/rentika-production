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
  // Длина "шага после" ступенчатого тарифа в днях — двадцатый проход, п.4
  // обзора ("190₽ за любую часть недели сверху"): period_price_after теперь
  // взимается ЦЕЛИКОМ за каждый полный или начатый шаг этой длины (а не
  // размазывается линейно по дням, как раньше) — см.
  // app/services/pricing.py:item_cost_for_days и financeCalc.ts:itemCostForDays.
  after_period_days: number | null;
  // Склад/точка хранения (восемнадцатый проход) — необязательное поле, в
  // отличие от category.
  warehouse: string | null;
  status: "available" | "rented" | "maintenance" | "retired";
  maintenance_until: string | null;
  notes: string | null;
  created_at: string;
}

export interface EquipmentCategory {
  id: string;
  name: string;
  created_at: string;
  // Сколько позиций оборудования сейчас используют эту категорию — нужно
  // для управления справочником (пятнадцатый проход): решить, можно ли
  // удалить категорию, и просто как полезная информация в списке.
  equipment_count: number;
}

// Точная копия EquipmentCategory — справочник складов (восемнадцатый
// проход), та же механика управления и тот же смысл equipment_count.
export interface EquipmentWarehouse {
  id: string;
  name: string;
  created_at: string;
  equipment_count: number;
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
  // ---- 25-й проход (обзор «глазами обычного пользователя») ----
  client_type: "individual" | "company";
  contact_person: string | null;
  inn: string | null;
  default_discount_percent: number | null;
  tags: string | null;
  blacklist_reason: string | null;
  // ---- 26-й проход (проф. взгляд + «глазами обычного пользователя» на
  // вкладку «Клиенты» и карточку клиента, согласовано целиком) ----
  birthday: string | null; // "YYYY-MM-DD"
  additional_contacts: ClientContact[] | null;
  // ---- 29-й проход (20-пунктовый обзор живого прода, "реализовываем всё в
  // полном объёме") ----
  // Постоянная пометка "когда-то был в чёрном списке" — не сбрасывается
  // автоматически при смене рейтинга на другой (см. app/models/inventory.py).
  was_blacklisted: boolean;
}

// Клиент/позиция оборудования в корзине (29-й проход, п.14 обзора) — то же
// самое + когда и кем удалён. См. GET .../clients/trash, GET .../equipment/trash.
export interface Trashed {
  deleted_at: string;
  deleted_by_name: string | null;
}

export type TrashedClient = Client & Trashed;
export type TrashedEquipment = Equipment & Trashed;

export interface ClientContact {
  name: string;
  role: string | null;
  phone: string | null;
}

export interface ClientDocument {
  id: string;
  client_id: string;
  employee_id: string | null;
  employee_name: string | null;
  filename: string;
  content_type: string;
  size_bytes: number;
  data_base64: string;
  created_at: string;
  /** Короткая подпись к документу ("Разворот паспорта", "Прописка" и т.п.) —
   * 29-й проход, повторный обзор, п.12: чтобы несколько файлов не приходилось
   * различать только по имени с телефона. Может отсутствовать у файлов,
   * загруженных до появления этого поля. */
  label: string | null;
}

export interface ClientNote {
  id: string;
  client_id: string;
  employee_id: string | null;
  employee_name: string | null;
  text: string;
  created_at: string;
  // Может ли ТЕКУЩИЙ пользователь изменить/удалить именно эту запись —
  // считается на backend (автор + короткое окно по времени, либо владелец
  // бизнеса без ограничений), см. _note_can_modify в
  // app/api/routes/clients.py (37-й проход). Кнопки "Изменить"/"Удалить" в
  // ClientNotesJournal просто следуют этим флагам, не дублируя логику на
  // фронте.
  can_edit: boolean;
  can_delete: boolean;
}

export interface ClientImportRowResult {
  row: number;
  ok: boolean;
  name: string;
  error: string | null;
  client: Client | null;
  // Телефон строки совпал с уже существующим клиентом (либо с уже
  // импортированной ранее в этом же файле строкой) — строка всё равно
  // создаётся, это только сигнал сотруднику проверить и, возможно,
  // объединить карточки вручную после импорта (см. "Объединить с другим
  // клиентом" в ClientDetailPanel).
  duplicate_warning: boolean;
}

export interface ClientImportResult {
  total: number;
  created: number;
  failed: number;
  results: ClientImportRowResult[];
}

export interface RentalItem {
  equipment_id: string;
  daily_rate_snapshot: number;
  period_days_snapshot: number | null;
  period_price_snapshot: number | null;
  period_price_after_snapshot: number | null;
  // См. Equipment.after_period_days — снимок того же поля на момент
  // оформления аренды (двадцатый проход).
  after_period_days_snapshot: number | null;
  // Частичный возврат по позициям (41-й проход) — фактическая дата возврата
  // ИМЕННО этой позиции, если она вернулась раньше остальных. null — позиция
  // ещё у клиента (или аренда вообще не активна). См. app/models/inventory.py.
  returned_at: string | null;
}

// Фото состояния оборудования при выдаче/возврате (41-й проход) — GET/POST
// .../rentals/{id}/photos, DELETE .../photos/{photoId}. Тот же принцип
// хранения, что и у ClientDocument (base64 в TEXT-колонке, без отдельного
// файлового хранилища).
export interface RentalPhoto {
  id: string;
  rental_id: string;
  employee_id: string | null;
  employee_name: string | null;
  stage: "issue" | "return";
  filename: string;
  content_type: string;
  size_bytes: number;
  data_base64: string;
  created_at: string;
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
