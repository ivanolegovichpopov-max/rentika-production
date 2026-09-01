import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconChevronDown } from "../lib/icons";

export interface MoreAction {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

/**
 * Кнопка "⋯ Ещё" со списком редких служебных действий (настройка столбцов,
 * импорт/экспорт CSV, корзина и т.п.) — 29-й проход, ещё один повторный
 * обзор: панель вкладок Клиенты/Оборудование была перегружена кнопками
 * одного визуального веса, хотя реально на каждый день нужна обычно только
 * "+ Добавить" — остальное открывают раз в неделю, а не на каждом клике.
 * Прячет их за одной кнопкой, оставляя на виду только то, что действительно
 * часто нужно.
 *
 * Тот же idiom клика вне панели и те же классы .cat-filter*, что и у
 * components/Dropdown.tsx (единственный выпадающий список в проекте) — но
 * список опций здесь произвольные действия (onClick), а не выбор одного
 * значения, поэтому отдельный компонент, а не повторное использование
 * Dropdown с "фиктивным" value.
 */
export function MoreActionsMenu({ actions, label = "Ещё" }: { actions: MoreAction[]; label?: string }) {
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

  return (
    <div className="cat-filter" ref={ref}>
      <button type="button" className="btn cat-filter-btn" onClick={() => setOpen((v) => !v)}>
        <span className="cat-filter-name">⋯ {label}</span>
        <IconChevronDown />
      </button>
      {open && (
        <div className="cat-filter-panel">
          {actions.map((a) => (
            <button
              type="button"
              key={a.key}
              className="cat-filter-option"
              disabled={a.disabled}
              onClick={() => {
                setOpen(false);
                a.onClick();
              }}
            >
              {a.icon}
              <span className="cat-filter-name">{a.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
