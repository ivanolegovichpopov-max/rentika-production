/**
 * Словари статус → визуал (тон/подпись) + вычисление ОТОБРАЖАЕМОГО статуса —
 * перенесено 1:1 из демо-прототипа (RENTAL_META/EQ_META/RATING_META,
 * rentalDisplayStatus/equipmentDisplayStatus).
 *
 * Важно: "просрочено" НЕ хранится backend'ом как статус аренды/оборудования —
 * это вычисляемое на лету свойство (active + end_date в прошлом), точно как
 * в демо. Поле Client.rating в проде называется "normal", а не "ok" как в
 * демо — это просто другое имя одного и того же значения enum на backend'е
 * (миграция схемы уже была сделана раньше, до этого переноса), пользователю
 * разницы не видно — везде показывается "Надёжный".
 */
import type { Equipment, Rental } from "../api/types";
import { dayDiff } from "./format";

export type Tone = "good" | "warning" | "critical" | "accent" | "info" | "muted";

export interface StatusMeta {
  label: string;
  tone: Tone;
}

export const RENTAL_META: Record<string, StatusMeta> = {
  booked: { label: "Забронировано", tone: "info" },
  active: { label: "В аренде", tone: "accent" },
  overdue: { label: "Просрочено", tone: "critical" },
  returned: { label: "Возвращено", tone: "good" },
  cancelled: { label: "Отменено", tone: "muted" },
};

export const EQ_META: Record<string, StatusMeta> = {
  available: { label: "Свободно", tone: "good" },
  rented: { label: "В аренде", tone: "accent" },
  overdue: { label: "Просрочено", tone: "critical" },
  maintenance: { label: "Обслуживание", tone: "warning" },
  retired: { label: "Списано", tone: "muted" },
};

export const RATING_META: Record<string, StatusMeta> = {
  normal: { label: "Надёжный", tone: "good" },
  watch: { label: "На контроле", tone: "warning" },
  blacklist: { label: "Чёрный список", tone: "critical" },
};

export function Badge({ meta }: { meta: StatusMeta }) {
  return (
    <span className={`badge tone-${meta.tone}`}>
      <span className="dot" />
      {meta.label}
    </span>
  );
}

/** booked/active/returned/cancelled с backend + "overdue" вычисляется здесь. */
export function rentalDisplayStatus(r: Pick<Rental, "status" | "end_date">): string {
  if (r.status === "active" && dayDiff(r.end_date) < 0) return "overdue";
  return r.status;
}

/** Активная (ещё не возвращённая) аренда для конкретной единицы оборудования. */
export function activeRentalFor(equipmentId: string, rentals: Rental[]): Rental | undefined {
  return rentals.find(
    (r) => r.status === "active" && r.items.some((it) => it.equipment_id === equipmentId)
  );
}

function isUnderMaintenanceOn(eq: Equipment, dateIso: string): boolean {
  if (eq.status !== "maintenance") return false;
  if (!eq.maintenance_until) return true;
  return dateIso <= eq.maintenance_until;
}

export function equipmentDisplayStatus(eq: Equipment, rentals: Rental[], todayIso: string): string {
  if (isUnderMaintenanceOn(eq, todayIso)) return "maintenance";
  if (eq.status === "retired") return "retired";
  const r = activeRentalFor(eq.id, rentals);
  if (r) return dayDiff(r.end_date) < 0 ? "overdue" : "rented";
  return "available";
}

/** Дата, с которой позиция освобождается — для строки "своб. с …" под бейджем. */
export function nextFreeDate(eq: Equipment, rentals: Rental[]): string | null {
  const r = activeRentalFor(eq.id, rentals);
  if (!r) return null;
  return r.end_date;
}
