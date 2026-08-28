export type ResourceType = "clients" | "equipment" | "rentals" | "finance" | "employees";
export type PermissionLevel = "none" | "view" | "edit";

export interface User {
  id: string;
  email: string;
  is_platform_admin: boolean;
  totp_enabled: boolean;
}

export interface Business {
  id: string;
  name: string;
  status: "active" | "suspended";
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
  created_at: string;
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

// Личная настройка дашборда текущего сотрудника (какие плашки/панели скрыты,
// какие переименованы) — GET/PUT /businesses/{id}/dashboard-prefs. Набор
// валидных id блоков объявлен рядом с использованием, в DashboardTab.tsx.
export interface DashboardPrefs {
  hidden: string[];
  labels: Record<string, string>;
}
