/**
 * Импорт/экспорт оборудования в CSV — вынесено из EquipmentTab.tsx в
 * отдельный модуль (двадцать второй проход, "разнести по отдельным
 * файлам"). IMPORT_TEMPLATE_HEADER и downloadImportTemplate используются
 * и здесь, и в EquipmentImportModal; exportEquipmentCsv — только в основном
 * списке (EquipmentTab).
 */
import type { Equipment, Rental } from "../../../api/types";
import { EQ_META, equipmentDisplayStatus } from "../../../lib/statusMeta";
import { toCsv } from "../../../lib/csv";

/* ============================================================
   Массовый импорт оборудования из CSV — по запросу пользователя в
   тринадцатом проходе ("обязательно нужно реализовать в лучшем виде, как
   считаешь ты"): скачиваемый шаблон → выбор файла → клиентский
   предпросмотр/лёгкая валидация (не ждём сети, чтобы показать явные
   проблемы вроде пустого имени) → отправка файла целиком на backend
   (там — вторая, настоящая валидация построчно, см.
   app/api/routes/equipment.py:import_equipment) → отчёт по каждой строке.
   ============================================================ */
export const IMPORT_TEMPLATE_HEADER = [
  "name",
  "category",
  // Склад — необязательная колонка (восемнадцатый проход), может быть
  // пустой в файле, тогда позиция создаётся без привязки к складу.
  "warehouse",
  "code",
  "daily_rate",
  "deposit",
  "period_days",
  "period_price",
  "period_price_after",
  // Длина шага "после" в днях (двадцатый проход) — необязательная колонка,
  // как и три соседних поля тарифа; см. Equipment.after_period_days.
  "after_period_days",
  "notes",
];

const IMPORT_TEMPLATE_EXAMPLE = [
  "Перфоратор Bosch GBH 5-40",
  "Инструмент",
  "Центральный склад",
  "INV-101",
  "500",
  "2000",
  "7",
  "2900",
  "350",
  "7",
  "Комплект полный, состояние хорошее",
];

export function downloadImportTemplate() {
  const csv = toCsv(IMPORT_TEMPLATE_HEADER, [IMPORT_TEMPLATE_EXAMPLE]);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }); // BOM — чтобы Excel сразу открыл в UTF-8, не спрашивая кодировку
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "equipment-import-template.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ============================================================
   Экспорт CSV — пункт 2 обзора вкладки «Оборудование» (пятнадцатый проход,
   "Согласен со всем. давай внесем изменения"): выгрузка ТЕКУЩЕГО видимого
   списка (с учётом поиска/фильтра статуса/категории и сортировки — то, что
   пользователь видит на экране, то и выгружается) в тот же CSV-формат, что
   и шаблон импорта, плюс колонка "status" для наглядности (при обратном
   импорте лишняя колонка просто игнорируется парсером — см. csvRowsToObjects).
   Полностью на клиенте, нового backend-эндпоинта не требуется.
   ============================================================ */
const EQUIPMENT_EXPORT_HEADER = [
  "name",
  "category",
  "warehouse",
  "code",
  "daily_rate",
  "deposit",
  "period_days",
  "period_price",
  "period_price_after",
  "after_period_days",
  "status",
  "notes",
];

export function exportEquipmentCsv(list: Equipment[], rentals: Rental[], today: string) {
  const rows = list.map((e) => [
    e.name,
    e.category,
    e.warehouse ?? "",
    e.code ?? "",
    e.daily_rate,
    e.deposit,
    e.period_days ?? "",
    e.period_price ?? "",
    e.period_price_after ?? "",
    e.after_period_days ?? "",
    EQ_META[equipmentDisplayStatus(e, rentals, today)].label,
    e.notes ?? "",
  ]);
  const csv = toCsv(EQUIPMENT_EXPORT_HEADER, rows);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }); // BOM — см. downloadImportTemplate выше
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Оборудование ${today}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
