/**
 * Индикатор тренда для сводки нагрузки (66-й проход, "делаем всё") — общий
 * для таблицы нагрузки команды в EmployeesTab.tsx и персональной карточки
 * EmployeeDetailPanel.tsx, поэтому вынесен отдельно, а не продублирован.
 * current/prev — счётчик за текущий и предыдущий период такой же длины
 * (см. EmployeeWorkload.*_prev на бэке); prev === null означает "сравнение
 * недоступно" (период "весь"), а не "было 0" — в этом случае индикатор не
 * рисуется вовсе.
 */
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
