import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { IconChevronDown, IconMore } from "../lib/icons";

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
  iconOnly = false,
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
  /** Компактный триггер — круглая icon-btn с точками (IconMore) вместо
   * текста "Ещё" + шеврона (36-й проход, обзор карточки клиента: в узком
   * ряду кнопок карточки клиента текстовый вариант не помещался в строку
   * и переносился на отдельную, из-за чего смотрелся отдельно повисшим
   * элементом — компактный вариант на ~30-40px уже, обычно этого хватает,
   * чтобы уместиться в общий ряд без переноса). `label` в этом режиме
   * используется только как `title` кнопки для доступности/подсказки, на
   * экране не показывается. */
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Досчитанный нижний отступ панели — не 0 только когда прямо под открытой
  // панелью, при закрытии, окажется частично перекрытый триггер ДРУГОГО
  // экземпляра MoreActionsMenu (см. комментарий у useLayoutEffect ниже).
  const [extraBottom, setExtraBottom] = useState(0);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  /**
   * 51-й проход — точная причина бага "в выпадающем меню просвечивается
   * следующее 'Ещё'" (репортился дважды, второй раз — с 4 скриншотами на
   * разных карточках, с явным требованием найти точную причину без
   * затемнения). Живой замер в DOM (getBoundingClientRect +
   * elementsFromPoint) показал: панель НЕ прозрачная и НЕ ниже по
   * z-index — в точке стыка она честно оказывается самым верхним
   * элементом. Настоящая причина другая — карточки идут плотно
   * (margin-bottom всего 10px), и КАЖДАЯ заканчивается собственной кнопкой
   * "Ещё"/"⋯" в том же столбце, где раскрывается панель. Панель меню
   * (~120px высотой у списка из 3 пунктов) при открытии геометрически
   * задевает верхнюю часть такой же кнопки соседней карточки, но только
   * ЧАСТИЧНО — нижняя часть её подписи/шеврона остаётся видна сразу под
   * краем панели. Именно это частичное (не полное) перекрытие двух честных
   * непрозрачных слоёв и читается как "слои перемешались". Смена
   * направления раскрытия не решает проблему — тем же замером
   * подтверждено, что вверх панель ровно так же перекрывает "Ещё"
   * предыдущей карточки (структура одинаковая у всех карточек).
   *
   * Фикс — не затемнение (пользователь явно отверг его как костыль,
   * которого нет больше нигде на сайте), а устранение самой причины
   * частичного перекрытия: после открытия меряем реальную геометрию,
   * ищем через elementsFromPoint вдоль нижнего края панели триггер ДРУГОГО
   * экземпляра этого же компонента (маркер data-more-trigger — не
   * произвольная кнопка со случайно совпавшим классом, и не наш
   * собственный триггер, см. !ref.current?.contains) и, если он перекрыт
   * лишь частично, досчитываем панели ровно столько нижнего отступа,
   * чтобы накрыть его целиком — частичное перекрытие становится полным
   * (без обрезанного "хвоста" подписи) либо, если места хватает, не
   * задевает соседа вовсе. Эффект молчит (extraBottom = 0) везде, где
   * рядом нет второй такой же кнопки — тулбары "Клиенты"/"Оборудование",
   * панели карточек и т.п. не затронуты.
   */
  useLayoutEffect(() => {
    if (!open) {
      setExtraBottom(0);
      return;
    }
    const panelEl = panelRef.current;
    if (!panelEl) return;
    const panelRect = panelEl.getBoundingClientRect();
    // Несколько точек вдоль нижнего края, а не только центр — соседняя
    // кнопка может оказаться у любого края панели в зависимости от align.
    const xs = [panelRect.left + 4, (panelRect.left + panelRect.right) / 2, panelRect.right - 4];
    let extra = 0;
    for (const x of xs) {
      const hit = document
        .elementsFromPoint(x, panelRect.bottom - 1)
        .find((el) => el instanceof HTMLElement && el.hasAttribute("data-more-trigger") && !ref.current?.contains(el));
      if (!hit) continue;
      const hitRect = hit.getBoundingClientRect();
      // Перекрытие именно частичное: нижний край соседней кнопки ниже
      // нижнего края панели, а верхний — выше него. Иначе перекрытия либо
      // нет, либо оно уже полное — дорабатывать нечего.
      if (hitRect.bottom > panelRect.bottom && hitRect.top < panelRect.bottom) {
        extra = Math.max(extra, Math.ceil(hitRect.bottom - panelRect.bottom) + 2);
      }
    }
    setExtraBottom(extra);
  }, [open]);

  return (
    <div className="cat-filter" ref={ref}>
      {iconOnly ? (
        <button type="button" className="icon-btn" title={label} data-more-trigger onClick={() => setOpen((v) => !v)}>
          <IconMore />
        </button>
      ) : (
        <button type="button" className="more-menu-btn" data-more-trigger onClick={() => setOpen((v) => !v)}>
          <span>{label}</span>
          <IconChevronDown />
        </button>
      )}
      {open && (
        <div
          ref={panelRef}
          className={"cat-filter-panel" + (align === "right" ? " cat-filter-panel-right" : "")}
          style={extraBottom ? { paddingBottom: 6 + extraBottom } : undefined}
        >
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
