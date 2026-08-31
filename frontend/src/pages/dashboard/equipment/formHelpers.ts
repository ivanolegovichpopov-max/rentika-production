/**
 * Тип состояния формы добавления/изменения оборудования и связанные с ним
 * чистые функции (перевод в/из Equipment, парсинг числовых полей, сборка
 * тела запроса) — вынесено из EquipmentTab.tsx в отдельный модуль (двадцать
 * второй проход, "разнести по отдельным файлам"), потому что используется
 * и в EquipmentFormModal (сама форма), и в родительской вкладке
 * EquipmentTab (готовит `initial` при открытии формы и тело запроса при
 * сохранении).
 */
import type { Equipment } from "../../../api/types";

export interface EquipmentFormState {
  name: string;
  category: string;
  // Склад/точка хранения (восемнадцатый проход) — в отличие от category
  // необязательное поле, поэтому пустая строка здесь означает "не указан",
  // а не ошибку валидации (см. formToPayload — конвертируется в null).
  warehouse: string;
  code: string;
  daily_rate: string;
  deposit: string;
  period_days: string;
  period_price: string;
  period_price_after: string;
  // Длина "шага после" ступенчатого тарифа в днях (двадцатый проход, п.4
  // обзора) — см. докстринг Equipment.after_period_days. Значение по
  // умолчанию "1" (посуточно) подставляется при открытии секции тарифа
  // (см. кнопку "+ Добавить ступенчатый тариф" ниже), чтобы в самом частом
  // случае (надбавка за сутки) пользователю вообще не нужно было это поле
  // трогать.
  after_period_days: string;
  notes: string;
  // Количество одинаковых позиций для создания разом (двадцатый проход, п.3
  // обзора — "30 пар одной модели костылей"). Имеет смысл только в режиме
  // добавления/копирования (см. allowAddAnother у EquipmentFormModal); при
  // редактировании существующей позиции поле не показывается и не читается.
  quantity: string;
}

export const EMPTY_FORM: EquipmentFormState = {
  name: "",
  category: "",
  warehouse: "",
  code: "",
  daily_rate: "",
  deposit: "0",
  period_days: "",
  period_price: "",
  period_price_after: "",
  after_period_days: "",
  notes: "",
  quantity: "1",
};

export function formFromEquipment(e: Equipment): EquipmentFormState {
  return {
    name: e.name,
    category: e.category,
    warehouse: e.warehouse ?? "",
    code: e.code ?? "",
    daily_rate: String(e.daily_rate),
    deposit: String(e.deposit),
    period_days: e.period_days != null ? String(e.period_days) : "",
    period_price: e.period_price != null ? String(e.period_price) : "",
    // Двадцатый проход: period_price_after теперь хранится и вводится как
    // цена за один шаг напрямую (без скрытой конвертации через period_days,
    // см. историю periodPriceAfterPerDay в git — убрана вместе с
    // одновременным добавлением своей длины шага, after_period_days).
    period_price_after: e.period_price_after != null ? String(e.period_price_after) : "",
    after_period_days: e.after_period_days != null ? String(e.after_period_days) : "",
    notes: e.notes ?? "",
    quantity: "1",
  };
}

/** Форма для кнопки "Копировать" на слайдовере (см. EquipmentDetailPanel) —
 * то же, что formFromEquipment, но с очищенным инвентарным номером: копия
 * позиции с тем же № была бы источником путаницы (см. согласование с
 * пользователем в тринадцатом проходе — "Полностью согласен, делаем!" про
 * саму фичу дублирования). Название получает суффикс "(копия)", чтобы в
 * списке сразу было видно, что это новая, ещё не отредактированная позиция.
 */
export function formFromEquipmentAsCopy(e: Equipment): EquipmentFormState {
  return { ...formFromEquipment(e), name: e.name + " (копия)", code: "" };
}

/** Парсинг числового поля, введённого пользователем как текст — принимает и
 * точку, и запятую как десятичный разделитель (16-й проход, п.5 обзора: на
 * русской раскладке/цифровой клавиатуре запятая — стандартный десятичный
 * знак, а нативный `<input type="number">` такой ввод просто не принимает
 * вовсе, без объяснения причины). `empty` отличает "не заполнено" (пусто —
 * нормально для необязательных полей) от `valid: false` ("заполнено
 * нечисловым мусором" — настоящая ошибка, которую раньше маскировал
 * `Number(...) || 0`, тихо превращая любой мусор в ноль). */
export function parseDecimalField(raw: string): { value: number | null; empty: boolean; valid: boolean } {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null, empty: true, valid: true };
  const n = Number(trimmed.replace(",", "."));
  return { value: Number.isFinite(n) ? n : null, empty: false, valid: Number.isFinite(n) };
}

/** Тело запроса на создание/изменение позиции — БЕЗ quantity (двадцатый
 * проход): quantity читается вызывающим кодом (handleSubmitForm) отдельно,
 * чтобы решить, какой эндпоинт вызвать (обычный POST/PATCH при 1 или
 * POST .../equipment/bulk при >1) — сам объект payload одинаков для обоих
 * случаев. */
export function formToPayload(form: EquipmentFormState) {
  const periodDays = form.period_days ? Number(form.period_days) : null;
  return {
    name: form.name,
    category: form.category,
    warehouse: form.warehouse.trim() || null,
    code: form.code || null,
    daily_rate: parseDecimalField(form.daily_rate).value ?? 0,
    deposit: parseDecimalField(form.deposit).value ?? 0,
    period_days: periodDays,
    period_price: parseDecimalField(form.period_price).value,
    // Цена за шаг вводится и хранится напрямую, без конвертации (двадцатый
    // проход — см. formFromEquipment выше).
    period_price_after: parseDecimalField(form.period_price_after).value,
    after_period_days: form.after_period_days ? Number(form.after_period_days) : null,
    notes: form.notes || null,
  };
}

/** Есть ли в форме заполненное значение хотя бы одного из трёх полей
 * ступенчатого тарифа — используется, чтобы при открытии формы на
 * редактирование секция сразу была раскрыта, если тариф уже настроен. */
export function hasTieredValues(form: EquipmentFormState): boolean {
  return !!(form.period_days || form.period_price || form.period_price_after);
}

/** Сравнение текущей формы с исходным состоянием (16-й проход, п.6 обзора) —
 * используется, чтобы спрашивать подтверждение закрытия ТОЛЬКО если
 * пользователь реально что-то ввёл/изменил, а не при любом закрытии пустой
 * (режим добавления) или нетронутой (режим редактирования) формы. */
export function isFormDirty(current: EquipmentFormState, initial: EquipmentFormState): boolean {
  return (Object.keys(current) as (keyof EquipmentFormState)[]).some((k) => current[k] !== initial[k]);
}
