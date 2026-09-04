import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { IconChevronDown, IconCheck } from "../lib/icons";
import type { DropdownOption } from "./Dropdown";

/**
 * Мультивыбор из общего списка значений (категория/склад и т.п.) — тот же
 * .cat-filter*-idiom и та же панель, что и у одиночного Dropdown.tsx, но
 * с чекбоксами и накоплением нескольких значений вместо выбора одного с
 * закрытием панели. Раньше это было продублировано вручную дважды в
 * EquipmentTab.tsx (категории + склады, полностью одинаковый код — открытие/
 * закрытие панели, клик вне панели, разметка) — при переносе того же
 * поведения на Календарь (55-й проход, обзор по скриншоту: "нет
 * множественного выбора, сделай как на Оборудовании") дублировать этот же
 * блок в третий и четвёртый раз показалось хуже, чем вынести его сюда один
 * раз. EquipmentTab.tsx оставлен как есть (свой инлайн-код) — рефактор под
 * этот компонент не входил в задачу и не нужен, раз там и так всё работает.
 *
 * Пустой массив `values` — это "выбрано всё" (тот же смысл, что и в
 * EquipmentTab.tsx), а не "ничего не выбрано". Опция "Все ..." — не элемент
 * `options`, а отдельная псевдо-опция, которую рисует сам компонент (клик
 * по ней — это `onChange([])`), после неё — .cat-filter-sep, затем сами
 * options с чекбоксами (клик — добавить/убрать из values).
 */
export function MultiDropdown({
  values,
  options,
  onChange,
  allLabel,
  allHint,
  /** Существительное для сводки в закрытой кнопке при 2+ выбранных
   * значениях ("Категорий: 2", "Складов: 3") — родительный падеж
   * множественного числа, число не меняет форму слова в этом месте, так
   * что отдельная функция плюрализации не нужна (1:1 с EquipmentTab.tsx). */
  countNoun,
  disabled,
  style,
}: {
  values: string[];
  options: DropdownOption[];
  onChange: (values: string[]) => void;
  allLabel: ReactNode;
  allHint?: ReactNode;
  countNoun: string;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function toggle(v: string) {
    onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);
  }

  const buttonLabel: ReactNode =
    values.length === 0
      ? allLabel
      : values.length === 1
      ? options.find((o) => o.value === values[0])?.label ?? values[0]
      : `${countNoun}: ${values.length}`;

  return (
    <div className="cat-filter" ref={ref} style={style}>
      <button
        type="button"
        className="btn cat-filter-btn"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        style={style ? { width: "100%" } : undefined}
      >
        <span className="cat-filter-name">{buttonLabel}</span>
        <IconChevronDown />
      </button>
      {open && (
        <div className="cat-filter-panel">
          <label className={"cat-filter-option" + (values.length === 0 ? " checked" : "")}>
            <input type="checkbox" className="sr-only" checked={values.length === 0} onChange={() => onChange([])} />
            <span className="cat-filter-check">{values.length === 0 && <IconCheck />}</span>
            <span className="cat-filter-name">{allLabel}</span>
            {allHint !== undefined && <span className="cat-filter-count">{allHint}</span>}
          </label>
          <div className="cat-filter-sep" />
          {options.map((o) => (
            <label className={"cat-filter-option" + (values.includes(o.value) ? " checked" : "")} key={o.value}>
              <input type="checkbox" className="sr-only" checked={values.includes(o.value)} onChange={() => toggle(o.value)} />
              <span className="cat-filter-check">{values.includes(o.value) && <IconCheck />}</span>
              <span className="cat-filter-name">{o.label}</span>
              {o.hint !== undefined && <span className="cat-filter-count">{o.hint}</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
