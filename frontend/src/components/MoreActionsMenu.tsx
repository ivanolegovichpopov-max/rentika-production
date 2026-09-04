import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
 * Те же классы .cat-filter-panel/-option, что и у components/Dropdown.tsx
 * (единственный выпадающий список в проекте) — но список опций здесь
 * произвольные действия (onClick), а не выбор одного значения, поэтому
 * отдельный компонент, а не повторное использование Dropdown с "фиктивным"
 * value.
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
 *
 * ПАНЕЛЬ ПОРТИРУЕТСЯ В document.body (51-й проход — см. подробный разбор
 * ниже, "почему портал"). Раньше панель была `position: absolute` внутри
 * обычного `<div className="cat-filter">` рядом с кнопкой — тем же
 * способом, каким этот компонент жил с самого начала. Разбор бага "в
 * выпадающем меню просвечивается следующее 'Ещё'" показал, что этого
 * недостаточно в принципе, не только в этом конкретном случае.
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
  const [pos, setPos] = useState<{ top: number; left: number | "auto"; right: number | "auto" } | null>(null);
  // Куда портировать панель — обычно document.body, но если кнопка внутри
  // открытого <dialog> (RentalDetailPanel/ClientDetailPanel/EquipmentDetailPanel
  // рендерятся именно так, см. useModalDialog.ts), портал в body рисуется ПОД
  // диалогом: открытый <dialog> уходит в отдельный слой браузера ("top
  // layer"), который красится поверх ВСЕГО обычного содержимого страницы
  // независимо от z-index. Тот же приём и та же причина, что и в
  // CategoryAutocomplete.tsx (17-й проход) — портал в САМ `<dialog>` решает
  // это, оставляя панель в top layer'е вместе с диалогом.
  const [portalTarget, setPortalTarget] = useState<Element | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  function openMenu() {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // left И right заданы явно в ОБОИХ случаях (одно из двух — "auto"), а не
    // просто пропущено то, что не нужно (52-й проход — регрессия после
    // портала: без явного left:"auto" при align="right" в игру вступал
    // унаследованный из CSS `.cat-filter-panel { left: 0 }` — с одновременно
    // заданными непустыми left И right и шириной auto браузер растягивает
    // блок между ними на всю ширину экрана вместо auto-ширины по контенту).
    setPos(
      align === "right"
        ? { top: r.bottom + 4, left: "auto", right: window.innerWidth - r.right }
        : { top: r.bottom + 4, left: r.left, right: "auto" }
    );
    setPortalTarget(el.closest("dialog") || document.body);
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (triggerRef.current?.contains(e.target as Node)) return;
      if (panelRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    // Закрытие по скроллу/ресайзу (тот же приём, что и в
    // CategoryAutocomplete.tsx) — position:fixed привязана к координатам на
    // момент открытия, при скролле она "отклеится" от кнопки-триггера, если
    // не закрыть. capture:true — чтобы поймать скролл ВНУТРИ узкого
    // контейнера (например, тела .slideover), а не только скролл окна.
    function onScrollOrResize() {
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  /**
   * 51-й проход — точная причина бага "в выпадающем меню просвечивается
   * следующее 'Ещё'" (репортился трижды: сначала со скриншотами, потом с
   * явным требованием найти точную причину без затемнения, и в конце — с
   * новым наблюдением, что при наведении на соседнее "Ещё" открытое меню
   * начинает МОРГАТЬ). Первая версия фикса (просто досчитать панели нижний
   * отступ) была основана на неверном диагнозе и не решила проблему до
   * конца — именно моргание при наведении это и вскрыло. Настоящая причина
   * нашлась только через точный замер живого DOM (getBoundingClientRect +
   * elementsFromPoint, на несжатом окне — не через скриншоты):
   *
   * Панель была `position: absolute` ВНУТРИ `<div className="cat-filter">`
   * этой конкретной карточки, с `z-index: 5`. Соседняя карточка ниже — со
   * своей ТАКОЙ ЖЕ кнопкой "Ещё" — тоже обычный `<div className="cat-filter">`
   * с `position: relative`, но БЕЗ z-index (auto). По правилам CSS
   * z-index сравнивается только МЕЖДУ элементами внутри одного контекста
   * наложения — а `position:relative` без явного z-index (как у обеих
   * .cat-filter-обёрток) СВОЙ контекст наложения не создаёт. Значит, с
   * точки зрения общего (корневого) контекста наложения страницы, ЦЕЛИКОМ
   * .cat-filter-обёртка этой карточки (вместе со своей z-index:5 панелью
   * внутри) и .cat-filter-обёртка соседней карточки — это два ОДИНАКОВЫХ
   * "auto"-уровня, а между элементами одного уровня порядок отрисовки
   * решает ПОРЯДОК В DOM, а не то, что z-index:5 стоит где-то глубоко
   * внутри одной из них. Карточка ниже в DOM идёт ПОСЛЕ текущей — значит
   * её кнопка "Ещё" рисуется ПОВЕРХ всей нашей открытой панели целиком,
   * z-index:5 внутри панели тут ни при чём (он "работает" только против
   * СОБСТВЕННЫХ соседей внутри той же .cat-filter, а других там нет).
   *
   * Именно поэтому баг выглядел как "частичное просвечивание": у
   * `.more-menu-btn` нет фона, пока по ней не навести (`background: none`,
   * только на `:hover` появляется заливка) — она и правда была ВСЕГДА
   * поверх панели, но пока не в фокусе мыши сквозь неё было видно только
   * текст/иконку (у них заливки не бывает), а не прямоугольник целиком.
   * При наведении на неё включался `:hover`-фон `.more-menu-btn` —
   * ВНЕЗАПНО появлялся непрозрачный прямоугольник поверх части нашей
   * панели ровно там, где курсор — это и есть "моргание", которое заметил
   * пользователь. Смена направления раскрытия не решает проблему — при
   * открытии вверх та же логика играет против ПРЕДЫДУЩЕЙ карточки.
   *
   * Фикс — не затемнение и не подгонка отступов "на глаз" (пользователь
   * явно отверг костыли), а устранение самой причины: панель рендерится
   * ПОРТАЛОМ в document.body (через createPortal), с `position: fixed` и
   * координатами из getBoundingClientRect() кнопки-триггера — точно тем же
   * приёмом, каким в этом проекте уже решена ровно такая же по природе
   * проблема (CategoryAutocomplete.tsx, 16-й/17-й проход, .autocomplete-panel).
   * Портированная в body панель — прямой потомок body, а не глубоко вложенный
   * элемент внутри .rental-card — и однозначно выигрывает сравнение
   * z-index против ЛЮБОГО обычного содержимого страницы, независимо от
   * того, какая карточка раньше или позже в DOM.
   */
  return (
    <>
      {iconOnly ? (
        <button
          type="button"
          ref={triggerRef}
          className="icon-btn"
          title={label}
          onClick={() => (open ? setOpen(false) : openMenu())}
        >
          <IconMore />
        </button>
      ) : (
        <button
          type="button"
          ref={triggerRef}
          className="more-menu-btn"
          onClick={() => (open ? setOpen(false) : openMenu())}
        >
          <span>{label}</span>
          <IconChevronDown />
        </button>
      )}
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            className="cat-filter-panel"
            // z-index:300 инлайном — перебивает CSS-правило .cat-filter-panel
            // (z-index:5, рассчитанное на обычное, непортированное положение
            // внутри узкого локального контекста наложения тулбара). Здесь
            // панель — прямой потомок body/<dialog> и сравнивается уже с
            // ЕГО соседями: .slideover-панель карточки клиента/оборудования
            // стоит на z-index:41 — без явного перебития наше меню оказалось
            // бы отрисовано ПОД ней и было бы не видно. 300 — то же
            // значение, что и у .autocomplete-panel (CategoryAutocomplete.tsx),
            // другого портированного в body выпадающего списка в проекте.
            style={{ position: "fixed", top: pos.top, left: pos.left, right: pos.right, zIndex: 300 }}
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
          </div>,
          portalTarget || document.body
        )}
    </>
  );
}
