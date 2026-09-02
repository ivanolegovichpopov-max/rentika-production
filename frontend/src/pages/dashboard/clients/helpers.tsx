/**
 * Фильтрация/сортировка/расчётные хелперы вокруг Client/Rental, вынесенные
 * из ClientsTab.tsx в отдельный модуль (38-й проход, "прибраться в коде") —
 * используются и в основном списке клиентов (ClientsTab), и в детальной
 * панели (ClientDetailPanel), и при экспорте CSV (clients/csv.ts). Тот же
 * приём, что и equipment/helpers.ts у «Оборудования».
 */
import type { Client, Rental } from "../../../api/types";
import { RATING_META, Badge, rentalDisplayStatus } from "../../../lib/statusMeta";
import { money, fmtDate } from "../../../lib/format";

/* ============================================================
   Фильтр по надёжности + настраиваемые столбцы таблицы — по образцу
   FILTERS/EQUIPMENT_SORT_COLUMNS из EquipmentTab.tsx. Рейтингов всего три и
   они закрытые (enum на backend), так что сегментированный переключатель
   подходит лучше, чем мультивыбор-дропдаун, каким сделан фильтр категорий
   у оборудования (тот нужен именно из-за открытого списка категорий).
   ============================================================ */
export const RATING_FILTERS: { id: string; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "normal", label: "Надёжные" },
  { id: "watch", label: "На контроле" },
  { id: "blacklist", label: "Чёрный список" },
];

export const CLIENT_SORT_COLUMNS: { key: string; label: string }[] = [
  { key: "name", label: "Имя" },
  { key: "doc", label: "Документ" },
  { key: "rating", label: "Рейтинг" },
  { key: "rentals", label: "Аренды" },
  { key: "lastRental", label: "Последняя аренда" },
  // 26-й проход, проф. обзор, п.1: раньше "кто мои самые ценные клиенты"
  // можно было узнать только через CSV-экспорт (там выручка уже считалась,
  // exportClientsCsv в clients/csv.ts) — в самой таблице отсортировать
  // было нельзя.
  { key: "revenue", label: "Выручка" },
];

/* ============================================================
   Настройка столбцов таблицы (29-й проход, п.11 обзора: "то же самое, что у
   Оборудования, добавить и Клиентам") — 1:1 перенесённая механика из
   EquipmentTab.tsx (EQUIPMENT_TOGGLEABLE_COLUMN_IDS/visibleEquipmentColumns/
   moveColumn/toggleColumnHidden). Столбец "Имя" (name) — как и "Оборудование"
   там — всегда первый и всегда виден, настраиваются только пять оставшихся.
   ============================================================ */
export const CLIENT_TOGGLEABLE_COLUMN_IDS = CLIENT_SORT_COLUMNS.filter((c) => c.key !== "name").map((c) => c.key);

export interface ClientColumnsPrefs {
  order: string[];
  hidden: string[];
}

export const DEFAULT_CLIENT_COLUMNS_PREFS: ClientColumnsPrefs = {
  order: CLIENT_TOGGLEABLE_COLUMN_IDS,
  hidden: [],
};

export function visibleClientColumns(prefs: ClientColumnsPrefs): { key: string; label: string }[] {
  const known = prefs.order.filter((id) => CLIENT_TOGGLEABLE_COLUMN_IDS.includes(id));
  const extra = CLIENT_TOGGLEABLE_COLUMN_IDS.filter((id) => !known.includes(id));
  return known
    .concat(extra)
    .filter((id) => !prefs.hidden.includes(id))
    .map((id) => CLIENT_SORT_COLUMNS.find((c) => c.key === id)!);
}

export interface ClientCellContext {
  clientRentals: Rental[];
  activeCount: number;
  overdueNow: number;
  lastRental: string;
  displayRating: Client["rating"];
  revenue: number;
}

/** Содержимое ячейки одного из настраиваемых столбцов — тот же приём, что и
 * renderEquipmentCell в EquipmentTab.tsx: порядок/видимость столбцов
 * управляются данными, а не жёстким списком <td> в JSX. */
export function renderClientCell(key: string, c: Client, ctx: ClientCellContext) {
  switch (key) {
    case "doc":
      return c.doc ?? "—";
    case "rating":
      return <Badge meta={RATING_META[ctx.displayRating]} />;
    case "rentals":
      return (
        <>
          {ctx.clientRentals.length} всего{ctx.activeCount > 0 ? `, ${ctx.activeCount} сейчас` : ""}
          {ctx.overdueNow > 0 && (
            <div style={{ marginTop: "4px" }}>
              <Badge meta={{ label: `Просрочено × ${ctx.overdueNow}`, tone: "critical" }} />
            </div>
          )}
        </>
      );
    case "lastRental":
      return ctx.lastRental ? fmtDate(ctx.lastRental) : "—";
    case "revenue":
      return money(ctx.revenue);
    default:
      return null;
  }
}

// Приоритет при сортировке по рейтингу — проблемные клиенты первые, тем же
// принципом, что и EQUIPMENT_STATUS_PRIORITY (overdue впереди available).
export const CLIENT_RATING_PRIORITY: Record<string, number> = { blacklist: 0, watch: 1, normal: 2 };

export interface ClientSort {
  key: string | null;
  dir: "asc" | "desc";
}

/** Дата начала самой свежей аренды клиента (по всей истории, не только
 * активной) — "" для клиента, который ни разу не арендовал, что при
 * сортировке по возрастанию корректно ставит его первым, рядом с самыми
 * "спящими" (25-й проход, п.6 обзора: сортировка/фильтр для возврата
 * клиентов, которые давно не арендовали). */
export function lastRentalDate(clientId: string, rentals: Rental[]): string {
  let latest = "";
  for (const r of rentals) {
    if (r.client_id === clientId && r.start_date > latest) latest = r.start_date;
  }
  return latest;
}

export const DORMANT_DAYS_THRESHOLD = 90;

/** "Спящий" клиент — арендовал хотя бы раз, но не в последние
 * DORMANT_DAYS_THRESHOLD дней (25-й проход, п.6): клиентов, которые ни разу
 * не арендовали, в этот фильтр намеренно не включаем — это отдельная
 * категория "новый, ещё не сдавали", возврат интересен именно для тех, кто
 * уже был активен и затих. */
export function isDormantClient(clientId: string, rentals: Rental[]): boolean {
  const last = lastRentalDate(clientId, rentals);
  if (!last) return false;
  const daysSince = (Date.now() - new Date(last).getTime()) / (1000 * 60 * 60 * 24);
  return daysSince >= DORMANT_DAYS_THRESHOLD;
}

/** День рождения клиента приходится на ближайшие 7 дней (включая сегодня) —
 * 26-й проход, «глазами обычного пользователя»: повод напомнить о себе
 * скидкой/поздравлением. Сравнение по месяцу/дню, год рождения не важен
 * (Client.birthday хранит полную дату только потому, что так проще всего
 * ввести — см. app/models/inventory.py). Оборачивает год (например, у
 * клиента ДР 2 января, а сегодня 29 декабря) — проверяется явно, а не через
 * вычитание миллисекунд, которое эту границу года не учло бы. */
export function isBirthdayThisWeek(birthday: string | null): boolean {
  if (!birthday) return false;
  const [, mStr, dStr] = birthday.split("-");
  const bMonth = Number(mStr) - 1;
  const bDay = Number(dStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    if (d.getMonth() === bMonth && d.getDate() === bDay) return true;
  }
  return false;
}

/** "Неполный профиль" — нет ни телефона, ни документа (26-й проход, проф.
 * обзор, п.6): для арендного бизнеса это риск — отдать технику клиенту, с
 * которым потом не связаться и предъявить нечего. Пока указано хотя бы
 * что-то одно, профиль неполным не считается — это мягкая подсказка "стоит
 * дозаполнить", а не жёсткий запрет создавать таких клиентов. */
export function isIncompleteProfile(c: Client): boolean {
  return !c.phone && !c.doc;
}

/** Выручка клиента за всё время — только по ЗАВЕРШЁННЫМ (returned) арендам,
 * тот же расчёт, что и lifetimeRevenue в ClientDetailPanel и exportClientsCsv
 * (clients/csv.ts) (26-й проход: вынесено в отдельную функцию, чтобы
 * использовать ещё и для сортировки колонки "Выручка", и для вычисления
 * уровня клиента — см. computeClientValueTiers). */
export function clientLifetimeRevenue(clientId: string, rentals: Rental[]): number {
  return rentals
    .filter((r) => r.client_id === clientId && r.status === "returned")
    .reduce((s, r) => s + r.total, 0);
}

export function clientSortValue(c: Client, key: string, rentals: Rental[]): string | number {
  if (key === "name") return c.name.toLowerCase();
  if (key === "doc") return (c.doc ?? "").toLowerCase();
  if (key === "rating") return CLIENT_RATING_PRIORITY[clientDisplayRating(c, rentals)] ?? 99;
  if (key === "rentals") return rentals.filter((r) => r.client_id === c.id).length;
  if (key === "lastRental") return lastRentalDate(c.id, rentals);
  if (key === "revenue") return clientLifetimeRevenue(c.id, rentals);
  return 0;
}

/** Уровень "ценности" клиента по выручке за всё время — отдельная ось от
 * рейтинга надёжности (тот про проблемность, этот про то, сколько клиент
 * реально принёс денег). 26-й проход, «глазами обычного пользователя»:
 * вместо произвольных фиксированных порогов в рублях (которые не подошли бы
 * ни маленькому, ни крупному бизнесу без ручной настройки) — перцентиль
 * СРЕДИ клиентов ЭТОГО бизнеса: топ-10% по выручке — "top", следующие до
 * ~35% — "active". Считается по ВСЕМ клиентам бизнеса, не по отфильтрованному
 * списку — иначе бейдж прыгал бы при смене фильтра. При малом числе платящих
 * клиентов (< MIN_CLIENTS_FOR_TIERS) бейджи не показываются вовсе — на
 * выборке в 2-3 клиента "топ-10%" не несёт смысла, только шумит. */
export const MIN_CLIENTS_FOR_TIERS = 5;

export function computeClientValueTiers(clients: Client[], rentals: Rental[]): Map<string, "top" | "active"> {
  const withRevenue = clients
    .map((c) => ({ id: c.id, revenue: clientLifetimeRevenue(c.id, rentals) }))
    .filter((r) => r.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue);
  const tiers = new Map<string, "top" | "active">();
  if (withRevenue.length < MIN_CLIENTS_FOR_TIERS) return tiers;
  const topCount = Math.max(1, Math.round(withRevenue.length * 0.1));
  const activeCount = Math.max(topCount, Math.round(withRevenue.length * 0.35));
  withRevenue.forEach((r, idx) => {
    if (idx < topCount) tiers.set(r.id, "top");
    else if (idx < activeCount) tiers.set(r.id, "active");
  });
  return tiers;
}

export const VALUE_TIER_META: Record<"top" | "active", { label: string; tone: "accent" | "info" }> = {
  top: { label: "Топ клиент", tone: "accent" },
  active: { label: "Активный клиент", tone: "info" },
};

export function sortClientList(list: Client[], sort: ClientSort, rentals: Rental[]): Client[] {
  if (!sort.key) return list;
  const key = sort.key;
  const dir = sort.dir === "desc" ? -1 : 1;
  return [...list].sort((a, b) => {
    const va = clientSortValue(a, key, rentals);
    const vb = clientSortValue(b, key, rentals);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return a.name.localeCompare(b.name, "ru");
  });
}

/** Есть ли у клиента незакрытая аренда (в работе или забронирована) — тот
 * же смысл и та же механика, что у equipmentHasOpenRentals в
 * equipment/helpers.ts: определяется на фронте из уже загруженного списка
 * аренд, без отдельного запроса. "overdue" backend никогда не хранит как
 * реальный статус (см. rentalDisplayStatus) — просроченная аренда это
 * всегда status==="active" в базе, так что отдельно её проверять не нужно. */
export function clientHasOpenRental(clientId: string, rentals: Rental[]): boolean {
  return rentals.some((r) => r.client_id === clientId && (r.status === "active" || r.status === "booked"));
}

/** Есть ли у клиента ПРЯМО СЕЙЧАС просроченная аренда — используется и для
 * бейджа в таблице, и для быстрого фильтра "Только с просрочкой" (24-й
 * проход, п.5 обзора: "просроченный клиент — это сигнал, который владелец
 * хочет видеть первым делом, не открывая карточку каждого"). */
export function clientHasOverdueNow(clientId: string, rentals: Rental[]): boolean {
  return rentals.some((r) => r.client_id === clientId && rentalDisplayStatus(r) === "overdue");
}

/** ОТОБРАЖАЕМЫЙ рейтинг клиента — вычисляется на фронте, тем же принципом,
 * что и rentalDisplayStatus (см. lib/statusMeta.tsx: "overdue" тоже никогда
 * не хранится backend'ом как есть). 29-й проход, п.6 обзора: раньше "На
 * контроле" был третьим ручным значением рейтинга рядом с "Надёжный"/"Чёрный
 * список" — сотрудник сам решал, когда его выставить, и по факту почти никто
 * не снимал пометку, когда просрочка закрывалась (в поле осталось только
 * "выставить", а "снять" не превратилось в привычку). Теперь "На контроле" —
 * не ручное состояние, а всегда актуальный расчёт: клиент "на контроле" ровно
 * пока у него есть просрочка ПРЯМО СЕЙЧАС (см. clientHasOverdueNow выше), без
 * отдельного действия что-то включить или выключить. Чёрный список
 * по-прежнему ручной — это осознанное решение команды, а не побочный эффект
 * дат аренды. Хранимое в базе значение "watch" (могло остаться от старых
 * записей, до этого прохода) этой функцией намеренно игнорируется — только
 * "blacklist" читается из данных как есть, "watch"/"normal" всегда считаются
 * заново. */
export function clientDisplayRating(c: Client, rentals: Rental[]): Client["rating"] {
  if (c.rating === "blacklist") return "blacklist";
  if (clientHasOverdueNow(c.id, rentals)) return "watch";
  return "normal";
}

/** Нормализация телефона до одних цифр — общая мелкая функция, используется
 * и при поиске дублей (clients/duplicates.ts), и в ссылках на WhatsApp
 * (ClientDetailPanel). */
export function normalizePhoneDigits(phone: string | null | undefined): string {
  return (phone ?? "").replace(/\D/g, "");
}
