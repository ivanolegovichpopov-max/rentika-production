/**
 * CategoryAutocomplete — вынесено из EquipmentTab.tsx в отдельный модуль
 * (двадцать второй проход, "разнести по отдельным файлам"), потому что
 * используется и в EquipmentFormModal (сама форма добавления/изменения), и
 * в EquipmentImportModal (таблица предпросмотра CSV-импорта).
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Автодополнение категории — замена нативного `<input list>` + `<datalist>`
 * (16-й проход, обзор по скриншотам, п.6): у нативного datalist нельзя
 * задать ширину выпадающего списка через CSS вообще — в Chrome он рисуется
 * уже самого поля. Панель рендерится через createPortal в document.body с
 * координатами из getBoundingClientRect() поля — только портал по-настоящему
 * выходит за пределы overflow:auto у прокручиваемых предков (сам по себе
 * position:fixed для этого недостаточен: overflow клипует потомков
 * независимо от их position), что нужно для использования внутри таблицы
 * предпросмотра CSV-импорта, а не только в обычной форме. Закрывается по
 * клику вне, скроллу и Escape. */
export function CategoryAutocomplete({
  value,
  onChange,
  categories,
  placeholder,
  required,
  inputClassName,
}: {
  value: string;
  onChange: (v: string) => void;
  categories: string[];
  placeholder?: string;
  required?: boolean;
  inputClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  // Куда портировать панель — обычно document.body, НО если поле находится
  // внутри открытого <dialog> (showModal()), портал в body рисуется ПОД
  // модалкой: открытый <dialog> уходит в отдельный слой браузера ("top
  // layer"), который красится поверх ВСЕГО обычного содержимого страницы
  // независимо от z-index — портированная в body панель в этот слой не
  // попадает и оказывается визуально скрыта под диалогом, даже будучи живой
  // в DOM (баг найден и подтверждён через getComputedStyle() на реальном
  // сайте — семнадцатый проход, уточнение). Портал в САМ `<dialog>` решает
  // это: панель остаётся потомком top layer'а и красится поверх содержимого
  // формы как надо, и заодно (ради чего портал вообще делался) не обрезается
  // overflow:auto таблицы предпросмотра импорта CSV — та проверка не теряется,
  // просто целевой контейнер портала теперь не всегда document.body.
  const [portalTarget, setPortalTarget] = useState<Element | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  function openPanel() {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ top: r.bottom + 4, left: r.left, width: r.width });
    setPortalTarget(el.closest("dialog") || document.body);
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (inputRef.current?.contains(e.target as Node)) return;
      if (panelRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onScrollOrResize() {
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    // capture:true — чтобы поймать скролл ВНУТРИ таблицы предпросмотра
    // импорта (.table-wrap с overflow-y:auto), а не только скролл окна.
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  const q = value.trim().toLowerCase();
  const filtered = (q ? categories.filter((c) => c.toLowerCase().includes(q)) : categories).slice(0, 30);

  return (
    <>
      <input
        ref={inputRef}
        required={required}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          openPanel();
        }}
        onFocus={openPanel}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder={placeholder}
        className={inputClassName}
        autoComplete="off"
      />
      {open &&
        rect &&
        filtered.length > 0 &&
        createPortal(
          <div ref={panelRef} className="autocomplete-panel" style={{ top: rect.top, left: rect.left, width: rect.width }}>
            {filtered.map((name) => (
              <button
                type="button"
                key={name}
                className="autocomplete-option"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(name);
                  setOpen(false);
                }}
              >
                {name}
              </button>
            ))}
          </div>,
          portalTarget || document.body
        )}
    </>
  );
}
