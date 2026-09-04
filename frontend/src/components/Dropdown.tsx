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
  searchable,
  searchPlaceholder,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  /** Текст на закрытой кнопке, когда value пустой или не найден среди options
   * (тот же смысл, что и у placeholder-опции в старом `<select>`). */
  placeholder: ReactNode;
  disabled?: boolean;
  style?: CSSProperties;
  // Поле поиска вверху панели (29-й проход, п.15 обзора: пикер цели слияния
  // клиентов — простой скролл по кнопкам не годится, когда клиентов в базе
  // много). Фильтрует по options[].label как обычному тексту (нечувствительно
  // к регистру) — labelText ниже нужен именно для этого, т.к. label может
  // быть произвольным ReactNode, а не голой строкой.
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
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

  useEffect(() => {
    if (open && searchable) {
      setQuery("");
      const raf = requestAnimationFrame(() => searchRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
  }, [open, searchable]);

  const q = query.trim().toLowerCase();
  const visibleOptions =
    searchable && q ? options.filter((o) => labelText(o.label).toLowerCase().includes(q)) : options;

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
          {searchable && (
            <input
              ref={searchRef}
              className="table-input"
              style={{ margin: "2px 6px 6px", width: "calc(100% - 12px)" }}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder={searchPlaceholder ?? "Поиск…"}
            />
          )}
          {visibleOptions.length === 0 && <div className="empty-note" style={{ padding: "6px 10px" }}>Ничего не найдено</div>}
          {visibleOptions.map((o) => (
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

/** Текстовое представление label для поиска — большинство мест передают
 * голую строку, но некоторые (счётчики) — JSX; для тех просто не найдётся
 * ничего по поиску, что безопаснее, чем пытаться "распарсить" произвольный
 * ReactNode обратно в текст. */
function labelText(label: ReactNode): string {
  return typeof label === "string" || typeof label === "number" ? String(label) : "";
}
