/**
 * Общие функции форматирования дат/денег — перенесены 1:1 из демо-прототипа
 * (oborot-crm-prototype.html), включая тот же выбор именно ЛОКАЛЬНЫХ полей
 * Date вместо toISOString() при разборе строк "YYYY-MM-DD": toISOString()
 * отдаёт дату по UTC, и в часовых поясах восточнее UTC локальная полночь
 * превращается в "вчера" — это давало сдвиг дат на -1 день в самой первой
 * версии демо. Здесь та же проблема решается тем же способом: даты вида
 * "YYYY-MM-DD" разбираются как локальная полночь через "T00:00:00" (без Z).
 */

export function todayISO(): string {
  return ymd(new Date());
}

export function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}-${m < 10 ? "0" : ""}${m}-${day < 10 ? "0" : ""}${day}`;
}

function parseLocal(iso: string): Date {
  return new Date(iso + "T00:00:00");
}

export function isoAddDays(iso: string, n: number): string {
  const d = parseLocal(iso);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/** Сколько дней от "сегодня" до iso (отрицательное — в прошлом). */
export function dayDiff(iso: string): number {
  const d = parseLocal(iso);
  const t = parseLocal(todayISO());
  return Math.round((d.getTime() - t.getTime()) / 86400000);
}

/** Включительная длина периода в днях (1-29 сентября = 29 дней, не 28). */
export function spanDays(start: string, end: string): number {
  return Math.round((parseLocal(end).getTime() - parseLocal(start).getTime()) / 86400000) + 1;
}

export function money(n: number): string {
  return Math.round(n).toLocaleString("ru-RU") + " ₽";
}

export function fmtDate(iso: string): string {
  return parseLocal(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

/** Диапазон дат для карточки аренды (49-й проход, обратная связь по списку
 * "Аренды" — "диапазон дат без года... если аренда пересекает границу года
 * или пользователь листает архив за прошлые годы, будет неоднозначно").
 * Год добавляется к ОБЕИМ датам сразу, только если он реально нужен для
 * однозначности — период пересекает границу года (start/end в разных годах)
 * или сам целиком лежит не в текущем году; иначе — обычный fmtDate без года,
 * как и раньше, чтобы не удлинять диапазон на каждой карточке без нужды.
 * Отдельная функция, а не необязательный параметр у fmtDate — у fmtDate уже
 * много вызовов по всему приложению (документы, журнал, экспорт CSV), где
 * год не нужен никогда; расширять его сигнатуру ради одного места было бы
 * избыточным риском регрессии в местах, которые не просили ничего менять. */
export function fmtDateRange(start: string, end: string): string {
  const startYear = start.slice(0, 4);
  const endYear = end.slice(0, 4);
  const currentYear = String(new Date().getFullYear());
  const showYear = startYear !== endYear || startYear !== currentYear;
  if (!showYear) return `${fmtDate(start)} — ${fmtDate(end)}`;
  const withYear = (iso: string) => `${fmtDate(iso)} ${iso.slice(0, 4)}`;
  return `${withYear(start)} — ${withYear(end)}`;
}

export function fmtDateLong(iso: string): string {
  return parseLocal(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

/** Простое русское склонение числительного (1 / 2-4 / 5+, с исключением
 * 11-14) — 66-й проход, нужно и для "N месяцев" (EmployeeDetailPanel.tsx),
 * и для "N сотрудников" (EmployeesTab.tsx, карточки должностей). */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** "Стаж" сотрудника в месяцах от даты найма (Employee.created_at) до
 * сегодня (66-й проход, обзор страницы "Сотрудники" — раньше карточка
 * сотрудника показывала только саму дату найма, "В команде с ...", без
 * человекочитаемого "сколько это уже"). Меньше месяца — отдельная подпись,
 * не "0 месяцев". */
export function tenureLabel(createdAtIso: string): string {
  const start = new Date(createdAtIso);
  const now = new Date();
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months -= 1;
  months = Math.max(0, months);
  if (months === 0) return "меньше месяца";
  return `${months} ${pluralRu(months, "месяц", "месяца", "месяцев")}`;
}

/** Фиксированная палитра цветов должности (67-й проход, "Должности и права"
 * — карточки были визуально неотличимы кроме названия). Ключи должны точно
 * совпадать с POSITION_COLORS на бэке (app/schemas/business.py) — сервер
 * отклоняет любой другой ключ на create/PATCH должности. Переиспользуем уже
 * существующие тематические CSS-переменные (--accent/--good/... — те же,
 * что и у статус-бейджей/календаря), кроме "серого" и "розового", для
 * которых готового токена не было — так палитра остаётся согласованной с
 * остальным интерфейсом и уже адаптирована под тёмную тему без отдельной
 * работы. */
export const POSITION_COLORS: { key: string; label: string; cssVar: string }[] = [
  { key: "gray", label: "Серый", cssVar: "--muted" },
  { key: "blue", label: "Синий", cssVar: "--accent" },
  { key: "green", label: "Зелёный", cssVar: "--good" },
  { key: "purple", label: "Фиолетовый", cssVar: "--today" },
  { key: "orange", label: "Оранжевый", cssVar: "--warning" },
  { key: "red", label: "Красный", cssVar: "--critical" },
  { key: "teal", label: "Бирюзовый", cssVar: "--col-select" },
  { key: "pink", label: "Розовый", cssVar: "--pos-pink" },
];

/** Инлайн-стиль бейджа/карточки должности под её цвет — через color-mix()
 * поверх текущих --surface/--ink/--border, поэтому одна и та же формула
 * автоматически даёт читаемый результат в обеих темах, без дублирования
 * под каждую тему отдельно (как это сделано для остальных токенов в
 * styles.css). null/незнакомый ключ — нейтральный серый. */
export function positionColorStyle(color: string | null | undefined): { background: string; color: string; border: string } {
  const found = POSITION_COLORS.find((c) => c.key === color);
  const cssVar = found ? found.cssVar : "--muted";
  return {
    background: `color-mix(in srgb, var(${cssVar}) 16%, var(--surface))`,
    color: `color-mix(in srgb, var(${cssVar}) 70%, var(--ink))`,
    border: `1px solid color-mix(in srgb, var(${cssVar}) 32%, var(--border))`,
  };
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Маска ввода телефона — "+7 900 123-45-67" по мере набора для российских
 * номеров (26-й проход, «глазами обычного пользователя»), но БЕЗ слепого
 * принуждения любого номера к коду страны "7" (29-й проход, п.5 обзора —
 * реальный клиент из другой страны раньше не мог ввести свой номер: ранняя
 * версия функции подставляла "+7" вообще всегда, независимо от того, что
 * набрано). Компромисс: короткий ввод (до 10 цифр, без явного кода страны)
 * по-прежнему считается российским номером без кода — это по-прежнему самый
 * частый случай для этого бизнеса, набирают "900 123-45-67" не думая про код
 * страны — и получает маску "+7 …" сам. Ведущая "8" на месте кода страны
 * тоже по-прежнему приводится к "7" (частый способ набора российского
 * номера). Любой номер с уже указанным ДРУГИМ кодом страны (11+ цифр, не
 * начинается на "7") форматированию под российскую маску не подвергается —
 * просто ограничивается длиной E.164 (максимум 15 цифр) и получает "+"
 * впереди, сохраняя то, что реально набрал сотрудник. */
export function formatPhoneInput(value: string): string {
  let digits = value.replace(/\D/g, "");
  if (!digits) return "";
  if (digits[0] === "8" && digits.length <= 11) digits = "7" + digits.slice(1);
  if (digits[0] !== "7" && digits.length <= 10) digits = "7" + digits;
  if (digits[0] === "7" && digits.length <= 11) {
    digits = digits.slice(0, 11);
    let out = "+7";
    if (digits.length > 1) out += " " + digits.slice(1, 4);
    if (digits.length > 4) out += " " + digits.slice(4, 7);
    if (digits.length > 7) out += "-" + digits.slice(7, 9);
    if (digits.length > 9) out += "-" + digits.slice(9, 11);
    return out;
  }
  digits = digits.slice(0, 15);
  return "+" + digits;
}

/** Маска ввода паспорта РФ — "45 03 123456" (серия из двух пар цифр + номер
 * из шести цифр, 10 цифр всего) по мере набора, тем же принципом, что и
 * formatPhoneInput выше (46-й проход, форма быстрого добавления клиента —
 * маска на поле "Паспорт", которого раньше не было нигде в проекте: на
 * вкладке "Клиенты" поле "Документ" всегда было простым текстом без
 * форматирования, чтобы вмещать и загранпаспорт, и другие типы документов;
 * здесь же поле называется конкретно "Паспорт", так что предсказуемая маска
 * уместна). Не годится для не-цифровых документов (загранпаспорт с буквами
 * серии и т.п.) — используется только там, где поле явно про российский
 * паспорт, а не про "документ" в широком смысле. */
export function formatPassportInput(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 10);
  if (!digits) return "";
  let out = digits.slice(0, 2);
  if (digits.length > 2) out += " " + digits.slice(2, 4);
  if (digits.length > 4) out += " " + digits.slice(4, 10);
  return out;
}
