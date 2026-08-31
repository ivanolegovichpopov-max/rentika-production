import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { IconChevronDown, IconCheck } from "../lib/icons";

/**
 * Единственный выпадающий список на всё приложение (26-й проход, обзор
 * скриншотов: пользователь заметил, что "Все категории" на «Оборудовании»
 * выглядит красиво — своя стилизованная панель, — а "Изменить рейтинг" на
 * «Клиентах» и ещё десяток похожих мест выглядят как голый браузерный
 * `<select>`: сама закрытая кнопка была стилизована (border-radius, своя
 * стрелка — appearance:none в styles.css), но РАСКРЫТЫЙ список опций рисует
 * браузер/ОС напрямую, CSS туда не дотягивается в принципе — это не баг,
 * а ограничение платформы у нативного select.
 *
 * Решение то же самое, что уже было применено для мультивыбора категорий/
 * складов оборудования (см. EquipmentTab.tsx, класс .cat-filter*) —
 * вынесено сюда в переиспользуемый одиночный (не мульти-) вариант и
 * применено везде, где раньше был нативный `<select>`. Классы .cat-filter*
 * в styles.css уже были достаточно общими (ничего специфичного для
 * оборудования), переименовывать их не потребовалось.
 *
 * В отличие от чекбоксов мультивыбора, здесь каждая опция — обычная
 * `<button type="button">`: клик сразу выбирает значение и закрывает
 * панель (это одиночный выбор, а не накопление нескольких значений).
 * type="button" обязателен — многие места используют Dropdown внутри
 * `<form>` (модалки создания аренды, приглашения сотрудника и т.д.), и без
 * явного type кнопка по умолчанию отправляла бы форму.
 *
 * Валидация "выбрано ли что-то" нативным атрибутом `required` у select
 * раньше не была единственной защитой нигде — во всех местах, где Dropdown
 * заменяет `required`-select, submit-обработчик и так явно проверяет пустое
 * значение перед отправкой (см. соответствующие handleSubmit в каждом
 * файле), так что replicate required здесь не нужно.
 */
export interface DropdownOption {
  value: string;
  label: ReactNode;
  hint?: ReactNode;
}

export function Dropdown({
  value,
  options,
  onChange,
  placeholder,
  disabled,
  style,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  /** Текст на закрытой кнопке, когда value пустой или не найден среди options
   * (тот же смысл, что и у placeholder-опции в старом `<select>`). */
  placeholder: ReactNode;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  // Клик вне панели закрывает её — тот же idiom, что и у catFilterOpen в
  // EquipmentTab.tsx.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div className="cat-filter" ref={ref} style={style}>
      <button
        type="button"
        className="btn cat-filter-btn"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        style={style ? { width: "100%" } : undefined}
      >
        <span className="cat-filter-name">{selected ? selected.label : placeholder}</span>
        <IconChevronDown />
      </button>
      {open && (
        <div className="cat-filter-panel">
          {options.map((o) => (
            <button
              type="button"
              key={o.value}
              className={"cat-filter-option" + (o.value === value ? " checked" : "")}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span className="cat-filter-check">{o.value === value && <IconCheck />}</span>
              <span className="cat-filter-name">{o.label}</span>
              {o.hint !== undefined && <span className="cat-filter-count">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
