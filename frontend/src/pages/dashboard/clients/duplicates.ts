/**
 * Обнаружение возможного дубля при создании клиента — вынесено из
 * ClientsTab.tsx в отдельный модуль (38-й проход, "прибраться в коде").
 * Найдено при обзоре вкладки «Клиенты» (24-й проход, п.3): ни фронт, ни
 * backend раньше никак не предупреждали, что клиент с таким же телефоном
 * или именем уже есть в базе, хотя при нескольких сотрудниках один и тот же
 * человек легко заводится дважды. Это мягкое предупреждение (см.
 * ClientsTab.handleSubmitForm), а не запрет — окончательное решение
 * остаётся за сотрудником, который лучше знает, один это человек или
 * тёзка/однофамилец с похожим номером. Используется только в ClientsTab
 * (форма добавления) — ни ClientFormModal, ни ClientDetailPanel сами дубли
 * не ищут.
 */
import type { Client } from "../../../api/types";
import type { ClientFormState } from "./formHelpers";
import { normalizePhoneDigits } from "./helpers";

/** Расстояние Левенштейна — стандартный алгоритм редакционного расстояния
 * (число вставок/удалений/замен символов, чтобы превратить одну строку в
 * другую), используется ниже для нечёткого сравнения имён (25-й проход,
 * п.9 обзора: точное совпадение из 24-го прохода не ловит опечатки —
 * "Иванов Иван" и "Иваннов Иван" считались разными клиентами). Классическая
 * динамика с одной "текущей" строкой вместо полной O(n·m) матрицы —
 * достаточно быстро для сравнения с базой в несколько сотен клиентов на
 * каждое нажатие клавиши, не нужна отдельная библиотека ради одной функции. */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[b.length];
}

/** Похожи ли два имени с учётом опечаток — расстояние Левенштейна,
 * нормализованное по длине более длинной строки (порог 0.2, т.е. до ~20%
 * символов может отличаться), плюс отдельный порог для совсем коротких
 * имён (1-2 отличающихся символа на коротком имени — уже, скорее всего,
 * другой человек, не опечатка). */
function namesLookSimilar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen < 4) return false; // слишком короткие имена — риск ложных срабатываний выше пользы
  const distance = levenshteinDistance(a, b);
  return distance <= Math.max(1, Math.floor(maxLen * 0.2));
}

export interface DuplicateMatch {
  client: Client;
  reason: "phone" | "name" | "fuzzy_name";
}

export function findPossibleDuplicate(form: ClientFormState, clients: Client[]): DuplicateMatch | null {
  const phone = normalizePhoneDigits(form.phone);
  const name = form.name.trim().toLowerCase();
  for (const c of clients) {
    if (phone && normalizePhoneDigits(c.phone) === phone) return { client: c, reason: "phone" };
  }
  for (const c of clients) {
    if (name && c.name.trim().toLowerCase() === name) return { client: c, reason: "name" };
  }
  // Нечёткое сравнение — вторым проходом, ПОСЛЕ точных совпадений (точное
  // совпадение всегда более уверенный сигнал, чем похожесть по опечатке).
  for (const c of clients) {
    if (name && namesLookSimilar(name, c.name.trim().toLowerCase())) return { client: c, reason: "fuzzy_name" };
  }
  return null;
}
