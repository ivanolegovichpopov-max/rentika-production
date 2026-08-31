import { useEffect, useState } from "react";

/**
 * useState с сохранением значения в localStorage — девятнадцатый проход,
 * п.4 обзора ("было бы удобно чтобы сортировка во всех полях сохранялась
 * после обновления страницы"). Общий хук, а не завязан на конкретную форму
 * значения — EquipmentTab хранит {key,dir}, RentalsTab — просто строку
 * (id варианта сортировки из <select>).
 *
 * key стоит формировать с businessId (например `equipment-sort:${businessId}`),
 * чтобы сортировка не "утекала" между разными бизнесами одного аккаунта при
 * переключении через "Все бизнесы" в сайдбаре.
 *
 * localStorage может быть недоступен (приватный режим некоторых браузеров,
 * заполненная квота) или содержать испорченное значение — в обоих случаях
 * тихо откатываемся на initial, не роняя страницу.
 */
export function usePersistedState<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) return JSON.parse(raw) as T;
    } catch {
      // испорченное значение / localStorage недоступен — используем initial.
    }
    return initial;
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // см. комментарий выше — сохранение просто не произойдёт.
    }
  }, [key, value]);

  return [value, setValue];
}
