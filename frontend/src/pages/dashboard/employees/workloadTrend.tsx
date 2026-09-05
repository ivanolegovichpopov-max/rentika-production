/**
 * Индикатор тренда для сводки нагрузки (66-й проход, "делаем всё") — общий
 * для таблицы нагрузки команды в EmployeesTab.tsx и персональной карточки
 * EmployeeDetailPanel.tsx, поэтому вынесен отдельно, а не продублирован.
 * current/prev — счётчик за текущий и предыдущий период такой же длины
 * (см. EmployeeWorkload.*_prev на бэке); prev === null означает "сравнение
 * недоступно" (период "весь"), а не "было 0" — в этом случае индикатор не
 * рисуется вовсе.
 */
/** Мини-график (спарклайн) дневной динамики одной метрики (67-й проход —
 * до этого тренд был только числом-дельтой к предыдущему периоду, без
 * картины "как менялось по дням"; см. EmployeeWorkloadTimeseries на бэке).
 * Без осей/подписей — только форма линии, тем же принципом, что и обычный
 * спарклайн: важна динамика, а не точные числа (они уже показаны рядом
 * текстом). Плоская нулевая линия — валидный результат (совсем не было
 * активности), а не "нет данных". */
export function WorkloadSparkline({ values, tone = "accent" }: { values: number[]; tone?: "accent" | "good" }) {
  if (values.length < 2) return null;
  const width = 84;
  const height = 26;
  const max = Math.max(...values, 1); // минимум 1 — чтобы плоский ноль не делил на 0
  const step = width / (values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - (v / max) * (height - 4) - 2).toFixed(1)}`);
  const color = tone === "good" ? "var(--good)" : "var(--accent)";
  const areaPoints = `0,${height} ${points.join(" ")} ${width},${height}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block" }}>
      <polygon points={areaPoints} fill={color} opacity={0.12} />
      <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Подсветка "аномалий" в сводке нагрузки (67-й проход — раньше выброс
 * приходилось замечать глазами, разглядывая таблицу). Эвристика, а не
 * точная аналитика — два простых случая:
 *  - активный сотрудник вообще без активности за выбранный период;
 *  - суммарная нагрузка отличается от предыдущего периода минимум в 2.5
 *    раза (в любую сторону), при том что в предыдущем периоде что-то
 *    вообще было (иначе "рост с нуля" у любого новичка считался бы
 *    аномалией, что не полезно). Сравнение недоступно при периоде "весь"
 *    (см. *_prev === null) — тогда функция ничего не подсвечивает. */
export function workloadAnomaly(
  w: { rentals_created: number; client_notes: number; rental_photos: number; rentals_created_prev: number | null; client_notes_prev: number | null; rental_photos_prev: number | null },
  isActive: boolean
): string | null {
  if (w.rentals_created_prev === null) return null; // период "весь" — сравнивать не с чем
  const total = w.rentals_created + w.client_notes + w.rental_photos;
  if (isActive && total === 0) return "Нет активности за период";
  const totalPrev = (w.rentals_created_prev ?? 0) + (w.client_notes_prev ?? 0) + (w.rental_photos_prev ?? 0);
  if (totalPrev > 0) {
    const ratio = total / totalPrev;
    if (ratio >= 2.5) return "Резкий рост нагрузки";
    if (ratio <= 0.3) return "Резкий спад нагрузки";
  }
  return null;
}

export function trendBadge(current: number, prev: number | null) {
  if (prev === null) return null;
  const diff = current - prev;
  if (diff === 0) {
    return (
      <span className="muted" style={{ fontSize: "11px", marginLeft: "6px" }} title="Как и в предыдущем периоде">
        · без изменений
      </span>
    );
  }
  const up = diff > 0;
  return (
    <span
      style={{ fontSize: "11px", marginLeft: "6px", color: up ? "var(--good-ink)" : "var(--critical-ink)" }}
      title={`Предыдущий период: ${prev}`}
    >
      {up ? "▲" : "▼"} {up ? "+" : ""}
      {diff}
    </span>
  );
}
