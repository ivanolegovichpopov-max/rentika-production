/**
 * Импорт/экспорт клиентов в CSV — вынесено из ClientsTab.tsx в отдельный
 * модуль (38-й проход, "прибраться в коде"), по образцу equipment/csv.ts.
 */
import type { Client, Rental } from "../../../api/types";
import { RATING_META, rentalDisplayStatus } from "../../../lib/statusMeta";
import { toCsv } from "../../../lib/csv";
import { clientDisplayRating, clientLifetimeRevenue } from "./helpers";

/* ============================================================
   Экспорт CSV — по образцу exportEquipmentCsv (equipment/csv.ts): выгрузка
   ТЕКУЩЕГО видимого списка (с учётом поиска/фильтра рейтинга/просрочки и
   сортировки) плюс пара расчётных колонок (аренды всего/просрочено сейчас/
   выручка за всё время), которых нет в самой таблице, но которые
   пригодятся для выгрузки в бухгалтерию или для архива.
   ============================================================ */
const CLIENT_EXPORT_HEADER = [
  "name",
  "phone",
  "email",
  "doc",
  "rating",
  "notes",
  "tags",
  "rentals_total",
  "overdue_now",
  "lifetime_revenue",
  "created_at",
];

export function exportClientsCsv(list: Client[], rentals: Rental[]) {
  const rows = list.map((c) => {
    const clientRentals = rentals.filter((r) => r.client_id === c.id);
    const overdueNow = clientRentals.filter((r) => rentalDisplayStatus(r) === "overdue").length;
    const lifetimeRevenue = clientLifetimeRevenue(c.id, rentals);
    return [
      c.name,
      c.phone ?? "",
      c.email ?? "",
      c.doc ?? "",
      RATING_META[clientDisplayRating(c, rentals)].label,
      c.notes ?? "",
      c.tags ?? "",
      clientRentals.length,
      overdueNow,
      Math.round(lifetimeRevenue),
      c.created_at.slice(0, 10),
    ];
  });
  const csv = toCsv(CLIENT_EXPORT_HEADER, rows);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }); // BOM — см. downloadImportTemplate в equipment/csv.ts
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Клиенты ${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ============================================================
   Импорт CSV — по образцу EquipmentImportModal (equipment/EquipmentImportModal.tsx):
   шаблон → выбор файла → клиентский предпросмотр/лёгкая валидация → отправка
   файла на backend (там настоящая построчная валидация, см.
   app/api/routes/clients.py:import_clients) → отчёт по каждой строке.
   Найдено при обзоре вкладки «Клиенты» (24-й проход, п.2): экспорт уже был
   реализован, импорта не было, хотя у Оборудования есть оба.
   ============================================================ */
export const CLIENT_IMPORT_TEMPLATE_HEADER = ["name", "phone", "email", "doc", "rating", "notes", "tags"];
const CLIENT_IMPORT_TEMPLATE_EXAMPLE = ["Иванов Иван", "+7 900 000-00-00", "ivan@example.com", "", "normal", "", ""];

export function downloadClientImportTemplate() {
  const csv = toCsv(CLIENT_IMPORT_TEMPLATE_HEADER, [CLIENT_IMPORT_TEMPLATE_EXAMPLE]);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "clients-import-template.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface ClientImportPreviewRow {
  row: number;
  values: Record<string, string>;
  problems: string[];
}

export function validateClientImportRow(obj: Record<string, string>): string[] {
  const problems: string[] = [];
  if (!obj.name) problems.push("нет имени/названия");
  const rating = obj.rating.trim().toLowerCase();
  if (rating && !["normal", "watch", "blacklist", "надёжный", "надежный", "на контроле", "чёрный список", "черный список"].includes(rating)) {
    problems.push("неизвестный рейтинг");
  }
  return problems;
}
