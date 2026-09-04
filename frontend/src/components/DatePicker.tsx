import { useEffect, useMemo, useRef, useState } from "react";
import { todayISO, ymd } from "../lib/format";
import { IconCalendar } from "../lib/icons";

/**
 * Свой попап-календарь взамен нативного `<input type="date">` (57-58-й
 * проходы, обзор с Календаря — "дизайн календаря, который открывается,
 * отличается от общего дизайна"). Раньше закрытое поле стилизовалось через
 * CSS (граница/радиус/фон совпадали с остальными полями формы), а вот
 * РАСКРЫТЫЙ попап рисует браузер/ОС напрямую — тот же принцип ограничения
 * платформы, из-за которого раньше заменили нативный `<select>` на
 * components/Dropdown.tsx: у CSS нет доступа внутрь нативного пикера ни в
 * одном браузере. Решение то же самое — свой компонент с тем же визуальным
 * языком (.cat-filter-panel), просто с сеткой дней вместо списка опций.
 *
 * Заменяет ВСЕ `<input type="date">` в приложении (13 мест в 10 файлах на
 * момент замены) — раньше несогласованность была системной, просто заметнее
 * всего на Календаре, где это поле открывают чаще остальных.
 *
 * value/onChange — те же ISO-строки "YYYY-MM-DD" (или "" для пустого
 * значения), что были у обычного input'а, так что замена в местах
 * использования — только сама разметка, вся остальная логика (min/max,
 * disabled, обработчики onChange) переносится без изменений.
 */

const MONTH_NAMES = [
  "январь",
  "февраль",
  "март",
  "апрель",
  "май",
  "июнь",
  "июль",
  "август",
  "сентябрь",
  "октябрь",
  "ноябрь",
  "декабрь",
];
const DOW_LABELS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function parseLocal(iso: string): Date {
  return new Date(iso + "T00:00:00");
}

/** Тот же вид, что и у закрытого нативного поля ("04.09.2026") — в отличие
 * от fmtDate() из lib/format.ts (короткая форма без года, "4 сент.", для
 * бейджей/таблиц), здесь нужен именно day.month.year с ведущими нулями. */
function formatClosed(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

/** 42 ячейки (6 недель) вокруг месяца year/month (0-индексация), понедельник
 * первым столбцом — тот же порядок дней недели, что и в нативном пикере
 * Chrome на скриншотах обзора. */
function buildGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const firstDow = (first.getDay() + 6) % 7; // 0=Пн..6=Вс
  const start = new Date(year, month, 1 - firstDow);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push(d);
  }
  return cells;
}

export function DatePicker({
  value,
  onChange,
  min,
  max,
  disabled,
  placeholder = "дд.мм.гггг",
  title,
  compact,
  align,
}: {
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
  placeholder?: string;
  title?: string;
  /** Уменьшенный размер поля — тот же случай, что раньше закрывали
   * `.cal-jump input[type="date"]`/`.finance-range input[type="date"]`
   * (Календарь, тулбар "перейти к дате"; Финансы, диапазон периода). */
  compact?: boolean;
  /** Раскрытие от правого края поля — для второй колонки в паре полей
   * (например, "Окончание" рядом с "Начало"), чтобы попап не вылезал за
   * правый край модалки, тот же приём, что и .cat-filter-panel-right у
   * components/MoreActionsMenu.tsx. */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const base = value || min || todayISO();
  const baseDate = parseLocal(base);
  const [viewYear, setViewYear] = useState(baseDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(baseDate.getMonth());

  useEffect(() => {
    if (!open) return;
    // При каждом открытии показываем месяц текущего значения (или
    // сегодняшний, если поле пустое) — тот же принцип, что и у сброса
    // query в Dropdown.tsx при открытии панели: не оставлять от прошлого
    // открытия вид месяца, никак не связанного с текущим значением поля.
    const d = parseLocal(value || min || todayISO());
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const grid = useMemo(() => buildGrid(viewYear, viewMonth), [viewYear, viewMonth]);
  const today = todayISO();

  function prevMonth() {
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  }
  function nextMonth() {
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  }
  function pick(iso: string) {
    onChange(iso);
    setOpen(false);
  }

  return (
    <div className="date-field" ref={ref}>
      <button
        type="button"
        className={"date-field-btn" + (compact ? " date-field-btn-sm" : "")}
        disabled={disabled}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={value ? undefined : "date-field-placeholder"}>{value ? formatClosed(value) : placeholder}</span>
        <IconCalendar />
      </button>
      {open && !disabled && (
        <div className={"date-field-panel" + (align === "right" ? " date-field-panel-right" : "")}>
          <div className="date-field-head">
            <button type="button" onClick={prevMonth} aria-label="Предыдущий месяц">
              ‹
            </button>
            <span className="date-field-title">
              {MONTH_NAMES[viewMonth][0].toUpperCase() + MONTH_NAMES[viewMonth].slice(1)} {viewYear}
            </span>
            <button type="button" onClick={nextMonth} aria-label="Следующий месяц">
              ›
            </button>
          </div>
          <div className="date-field-grid">
            {DOW_LABELS.map((d) => (
              <div className="date-field-dow" key={d}>
                {d}
              </div>
            ))}
            {grid.map((d) => {
              const iso = ymd(d);
              const inMonth = d.getMonth() === viewMonth;
              const outOfRange = (min && iso < min) || (max && iso > max);
              const cls =
                "date-field-day" +
                (!inMonth ? " muted" : "") +
                (iso === today ? " today" : "") +
                (iso === value ? " selected" : "");
              return (
                <button type="button" key={iso} className={cls} disabled={!!outOfRange} onClick={() => pick(iso)}>
                  {d.getDate()}
                </button>
              );
            })}
          </div>
          <div className="date-field-foot">
            <button type="button" onClick={() => pick(today)}>
              Сегодня
            </button>
            {value && (
              <button type="button" onClick={() => pick("")}>
                Очистить
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
