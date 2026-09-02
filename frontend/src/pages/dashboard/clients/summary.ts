/**
 * Текстовая сводка по аренде для кнопок "Отправить сводку" (wa.me/mailto) —
 * вынесено из ClientsTab.tsx в отдельный модуль (38-й проход, "прибраться в
 * коде"). Используется только в ClientDetailPanel.
 */
import type { Client, Equipment, Rental } from "../../../api/types";
import { RENTAL_META, rentalDisplayStatus } from "../../../lib/statusMeta";
import { money, fmtDate } from "../../../lib/format";

/** Аренда для кнопок "Отправить сводку" — открытая (в работе/забронирована),
 * если есть, иначе последняя завершённая. Открытая аренда важнее показать
 * клиенту (что и когда вернуть), чем произвольную из прошлого. */
export function pickSummaryRental(history: Rental[]): Rental | null {
  const open = history.filter((r) => r.status === "active" || r.status === "booked");
  if (open.length > 0) return open[0]; // history уже отсортирована новые→старые
  const closed = history.filter((r) => r.status === "returned");
  return closed[0] ?? null;
}

/** Текстовая сводка по аренде — для wa.me/mailto (ни один из двух протоколов
 * не умеет вкладывать файл, это не ограничение проекта, а самих ссылок
 * wa.me/mailto:, поэтому сводка — только текст, не PDF/документ). */
export function buildRentalSummaryText(rental: Rental, client: Client, equipment: Equipment[]): string {
  const items = rental.items.map((it) => equipment.find((eq) => eq.id === it.equipment_id)?.name ?? "—").join(", ");
  const statusLabel = RENTAL_META[rentalDisplayStatus(rental)].label;
  return [
    `Здравствуйте, ${client.name}!`,
    `Оборудование: ${items}`,
    `Период: ${fmtDate(rental.start_date)}—${fmtDate(rental.end_date)}`,
    `Статус: ${statusLabel}`,
    `Сумма: ${money(rental.total)}`,
  ].join("\n");
}
