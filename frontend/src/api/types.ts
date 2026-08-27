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
  status: "booked" | "active" | "overdue" | "returned" | "cancelled";
  damage_fee: number;
  created_at: string;
  amount: number;
  items: RentalItem[];
}
