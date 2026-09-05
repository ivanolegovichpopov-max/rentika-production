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
  // Ручной порядок карточек для перетаскивания в UI (66-й проход) — см.
  // Position.sort_order на бэке.
  sort_order: number;
  // Обязательная 2FA для этой должности (66-й проход) — см.
  // Position.require_2fa на бэке; сотрудник без включённой у себя 2FA не
  // пройдёт ни на один business-scoped запрос, пока не должность не снимут
  // с него или он сам не включит 2FA в профиле.
  require_2fa: boolean;
  // Сколько сотрудников сейчас на этой должности (66-й проход).
  employee_count: number;
  // Цвет карточки (67-й проход) — один из ключей POSITION_COLORS (lib/format.ts),
  // не произвольный CSS-цвет. null — цвет не задан, показываем нейтральный.
  color: string | null;
  // Короткое описание обязанностей должности (67-й проход) — чисто
  // информационное поле.
  description: string | null;
}

export interface Employee {
  id: string;
  user_id: string;
  name: string;
  // Email сотрудника (64-й проход) — приходит только владельцу/платформенному
  // админу (см. EmployeeOut на бэке); для остальных, кто тоже видит список
  // команды, всегда null.
  email: string | null;
  // Момент последнего успешного входа (65-й проход) — та же видимость, что
  // и email: null для всех, КРОМЕ владельца/платформенного админа. У самого
  // владельца null означает не "скрыто", а "сотрудник ни разу не входил" —
  // различать эти два случая (скрыто/не заходил) фронту приходится по тому,
  // видит ли он вообще email в том же ответе (см. EmployeesTab.tsx).
  last_login_at: string | null;
  position_id: string | null;
  is_owner: boolean;
  status: "invited" | "active" | "disabled";
  created_at: string;
  // Телефон (67-й проход) — та же видимость, что email/last_login_at:
  // null для всех, кроме владельца/платформенного админа.
  phone: string | null;
  // Заметки владельца о сотруднике (67-й проход) — видны ТОЛЬКО
  // владельцу/платформенному админу, строже даже email.
  notes: string | null;
  // Фото/аватар (67-й проход) — в отличие от phone/notes/email, видно
  // ВСЕЙ команде: data: URL или null (тогда в UI — инициалы).
  photo_url: string | null;
}

// Одна запись общего журнала действий по бизнесу (64-й проход) — см.
// ActivityLogEntry на бэке. Только владелец/платформенный админ.
export interface ActivityLogEntry {
  id: string;
  action: string;
  resource: string;
  resource_id: string | null;
  employee_name: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
}

// Страница журнала действий (65-й проход) — см. ActivityLogPage на бэке.
export interface ActivityLogPage {
  items: ActivityLogEntry[];
  has_more: boolean;
}

// Сводка нагрузки сотрудника (64-й проход) — см. EmployeeWorkloadOut на
// бэке. Только владелец/платформенный админ.
export interface EmployeeWorkload {
  employee_id: string;
  employee_name: string;
  rentals_created: number;
  client_notes: number;
  rental_photos: number;
  // Сравнение с предыдущим периодом такой же длины (66-й проход) — null,
  // когда сравнение недоступно (период "весь", а не days=N), а не "было 0".
  rentals_created_prev: number | null;
  client_notes_prev: number | null;
  rental_photos_prev: number | null;
}

// Одна строка отчёта об импорте сотрудников из CSV (66-й проход) — см.
// EmployeeImportRowResult на бэке.
export interface EmployeeImportRowResult {
  row: number;
  ok: boolean;
  name: string;
  error: string | null;
  employee: Employee | null;
}

export interface EmployeeImportResult {
  total: number;
  created: number;
  failed: number;
  results: EmployeeImportRowResult[];
}

// Результат массового действия над несколькими сотрудниками (67-й проход) —
// см. EmployeeBulkUpdateResult на бэке.
export interface EmployeeBulkUpdateResult {
  updated: Employee[];
  // Сколько id из запроса пропущено (владелец бизнеса или не найден).
  skipped: number;
}

// Ответ на генерацию нового временного пароля (67-й проход) — показывается
// владельцу ОДИН раз, дальше не хранится и не запрашивается повторно.
export interface EmployeeResetPasswordResult {
  temporary_password: string;
}

// Одна точка дневной динамики нагрузки сотрудника (67-й проход) — см.
// EmployeeWorkloadTimeseriesOut на бэке, используется для мини-графика в
// EmployeeDetailPanel.tsx.
export interface EmployeeWorkloadTimeseriesPoint {
  date: string;
  rentals_created: number;
  client_notes: number;
  rental_photos: number;
}

export interface EmployeeWorkloadTimeseries {
  points: EmployeeWorkloadTimeseriesPoint[];
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
  // Дата, когда депозит фактически отдан клиенту обратно (42-й проход) —
  // независимый факт от закрытия самой аренды: deposit_total выше считается
  // "вживую" по текущим Equipment.deposit позиций и никогда не хранится
  // суммой на аренде, поэтому "возвращён" — отдельная дата, не производная
  // от status==="returned". null = ещё не отмечен возвращённым.
  deposit_returned_at: string | null;
  // Учёт оплаты (46-й проход) — накопительная сумма всех платежей по аренде,
  // см. Rental.paid_amount в app/models/inventory.py. Остаток к оплате
  // (total - paid_amount) не приходит отдельным полем — считается здесь же,
  // тем же принципом, что и deposit_total.
  paid_amount: number;
  // Доп. услуги (46-й проход) — ОДНО значение, заменяемое целиком (как
  // discount), а не накопительная сумма (как paid_amount/damage_fee). См.
  // Rental.extra_fee в app/models/inventory.py. extra_fee_note — короткая
  // подпись, за что взята сумма ("Доставка", "Накачка SUP") — может быть
  // null, если extra_fee тоже 0 (или сумму взяли без подписи).
  extra_fee: number;
  extra_fee_note: string | null;
  items: RentalItem[];
}

// Одна запись журнала изменений аренды (42-й проход) — GET
// .../rentals/{id}/history, переиспользует существующий AuditLog (пишется
// всеми действиями по аренде — create/issue/edit/return/return_items/cancel/
// deposit_return, см. log_action(...) в app/api/routes/rentals.py). meta —
// произвольный набор полей "было/стало", зависящий от action, интерпретация
// каждого — в RentalHistorySection.tsx.
export interface RentalHistoryEntry {
  // 49-й проход — id записи журнала, нужен чтобы сослаться на неё из
  // POST .../history/{entry_id}/correct (исправление опечатки в платеже).
  id: string;
  action: string;
  employee_name: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
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
