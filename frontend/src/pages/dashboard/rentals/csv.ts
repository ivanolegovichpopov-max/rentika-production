/**
 * Экспорт аренд в CSV — по образцу exportClientsCsv (clients/csv.ts) и
 * exportEquipmentCsv (equipment/csv.ts). 39-й проход, доработки вкладки
 * "Аренды" по итогам обзора: у Клиентов/Оборудования экспорт уже был,
 * у Аренд — нет, хотя выгрузка в бухгалтерию/архив нужна ровно так же.
 * Импорта здесь намеренно нет (в отличие от Клиентов/Оборудования) — аренда
 * не заводится "россыпью" из внешнего файла, она всегда создаётся через
 * форму (выбор клиента+оборудования+дат с проверкой занятости), так что
 * пригодился бы только экспорт.
 */
import type { Client, Equipment, Rental } from "../../../api/types";
import { RENTAL_META, rentalDisplayStatus } from "../../../lib/statusMeta";
import { toCsv } from "../../../lib/csv";

const RENTAL_EXPORT_HEADER = [
  "client",
  "equipment",
  "status",
  "start_date",
  "end_date",
  "actual_return",
  "planned_days",
  "actual_days",
  "late_days",
  "base",
  "late_fee",
  "damage_fee",
  "discount",
  "total",
  "deposit_total",
  "created_at",
];

export function exportRentalsCsv(list: Rental[], clients: Client[], equipment: Equipment[]) {
  const rows = list.map((r) => {
    const client = clients.find((c) => c.id === r.client_id);
    const names = r.items.map((it) => equipment.find((e) => e.id === it.equipment_id)?.name ?? "—").join("; ");
    return [
      client?.name ?? "Клиент удалён",
      names,
      RENTAL_META[rentalDisplayStatus(r)].label,
      r.start_date,
      r.end_date,
      r.actual_return ?? "",
      r.planned_days,
      r.actual_days,
      r.late_days,
      Math.round(r.base),
      Math.round(r.late_fee),
      Math.round(r.damage_fee),
      Math.round(r.discount),
      Math.round(r.total),
      Math.round(r.deposit_total),
      r.created_at.slice(0, 10),
    ];
  });
  const csv = toCsv(RENTAL_EXPORT_HEADER, rows);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }); // BOM — см. exportClientsCsv в clients/csv.ts
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Аренды ${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
