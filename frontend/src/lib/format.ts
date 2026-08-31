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

export function fmtDateLong(iso: string): string {
  return parseLocal(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

/** Детерминированный цвет по строке (для аватаров сотрудников — в проде нет
 * поля "цвет" у сотрудника, как в демо с хардкод-палитрой участников, поэтому
 * цвет генерируется из id, а не берётся из данных — визуально то же самое,
 * но отличается конкретными оттенками между демо и продом). */
const AVATAR_PALETTE = ["#2E6F8E", "#8E5A2E", "#4A7A3E", "#7A3E6E", "#3E5A7A", "#7A5A3E", "#5A3E7A", "#2E8E7A"];
export function colorFromId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Маска ввода российского телефона — "+7 900 123-45-67" по мере набора
 * (26-й проход, «глазами обычного пользователя»: раньше поле телефона было
 * простым текстом, легко ввести номер в разном формате, что потом мешает и
 * поиску, и wa.me-ссылке — та берёт только цифры, опечатка молча уводит не
 * туда). Ведущая "8" — частый способ набора российского номера — приводится
 * к тому же коду страны "7". Не блокирует ввод произвольного текста жёстко
 * (это не regex-валидатор, а форматтер по мере печати), просто причёсывает
 * то, что уже выглядит как российский номер. */
export function formatPhoneInput(value: string): string {
  let digits = value.replace(/\D/g, "");
  if (!digits) return "";
  if (digits[0] === "8") digits = "7" + digits.slice(1);
  if (digits[0] !== "7") digits = "7" + digits;
  digits = digits.slice(0, 11);
  let out = "+7";
  if (digits.length > 1) out += " " + digits.slice(1, 4);
  if (digits.length > 4) out += " " + digits.slice(4, 7);
  if (digits.length > 7) out += "-" + digits.slice(7, 9);
  if (digits.length > 9) out += "-" + digits.slice(9, 11);
  return out;
}
