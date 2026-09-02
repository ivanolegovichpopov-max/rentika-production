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
 * Тот же idiom клика вне панели и те же классы .cat-filter-panel/-option,
 * что и у components/Dropdown.tsx (единственный выпадающий список в
 * проекте) — но список опций здесь произвольные действия (onClick), а не
 * выбор одного значения, поэтому отдельный компонент, а не повторное
 * использование Dropdown с "фиктивным" value.
 *
 * Сама кнопка-триггер НЕ переиспользует .cat-filter-btn (29-й проход, ещё
 * один повторный обзор — пользователь справедливо заметил, что кнопка
 * выглядит громоздко). Причины были две: во-первых, "···" перед словом
 * "Ещё" и шеврон после него дублировали один и тот же сигнал "тут
 * раскрывается меню" трижды подряд — оставили только шеврон. Во-вторых,
 * рамка+фон как у .cat-filter-btn визуально приравнивали эту кнопку к
 * рядом стоящим фильтрам ("Все", "Надёжные" и т.п.), хотя по смыслу это
 * другая категория элемента — редко нужное меню действий, а не фильтр
 * списка, и его вес на панели должен быть заметно тише. Поэтому у
 * триггера свой класс .more-menu-btn (без рамки/фона, приглушённый цвет
 * текста) — а выпадающая панель и её пункты остаются на общих
 * .cat-filter-panel/.cat-filter-option, чтобы не плодить лишний CSS для
 * того, что и так выглядит правильно.
 */
export function MoreActionsMenu({
  actions,
  label = "Ещё",
  align = "left",
}: {
  actions: MoreAction[];
  label?: string;
  /** Сторона, от которой раскрывается панель (36-й проход, обзор карточки
   * клиента) — по умолчанию "left" (левый край панели совпадает с левым
   * краем кнопки-триггера), как было всегда и как по-прежнему нужно в
   * широких тулбарах списков «Клиенты»/«Оборудование». "right" — для
   * случая, когда сам триггер прижат к правому краю узкого контейнера
   * (например, слайдовер карточки клиента, кнопка "Ещё" с margin-left:
   * auto) — там раскрытие "от левого края кнопки вправо" уводит панель
   * (min-width: 220px) за пределы экрана, т.к. слева от триггера почти нет
   * места, а справа — совсем. */
  align?: "left" | "right";
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

  return (
    <div className="cat-filter" ref={ref}>
      <button type="button" className="more-menu-btn" onClick={() => setOpen((v) => !v)}>
        <span>{label}</span>
        <IconChevronDown />
      </button>
      {open && (
        <div className={"cat-filter-panel" + (align === "right" ? " cat-filter-panel-right" : "")}>
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
