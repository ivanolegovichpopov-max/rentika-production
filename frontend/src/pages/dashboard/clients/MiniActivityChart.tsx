/**
 * Мини-график активности клиента — вынесен из ClientsTab.tsx в отдельный
 * модуль (38-й проход, "прибраться в коде"). Сколько аренд НАЧАТО в каждом
 * из последних 6 месяцев (26-й проход, «глазами обычного пользователя»,
 * п.4): раньше про динамику клиента (затихает/разгоняется) можно было
 * судить только по одной цифре "выручка за всё время" и построчной истории.
 * Простой SVG-бар-чарт без сторонних библиотек — тот же принцип "минимум
 * зависимостей", что и весь остальной проект (см. Dropdown.tsx и т.п.).
 *
 * 29-й проход, п.4 обзора — три правки по фидбеку с живого прода:
 *  1. preserveAspectRatio="none" убран — это и был баг "график растянут
 *     криво": "none" заставляет SVG растягивать содержимое под фактическую
 *     ширину контейнера НЕ сохраняя пропорции viewBox, так что на широких
 *     карточках столбики визуально "расплющивались" по высоте. Без этого
 *     атрибута работает дефолт "xMidYMid meet" — сохраняет пропорции.
 *  2. Каждый столбец кликабелен — открывает вкладку "История", отфильтрованную
 *     по этому месяцу (см. onSelectMonth/historyMonthFilter в ClientDetailPanel).
 *  3. Подпись под заголовком уточняет, что считается КОЛИЧЕСТВО сделок, а не
 *     выручка — раньше это было неочевидно, цифры на графике легко спутать
 *     с деньгами.
 *
 * 36-й проход, обзор карточки клиента, п. "график должен быть на всю
 * ширину карточки" — viewBox был жёстко "0 0 180 60" (3:1), а
 * preserveAspectRatio по умолчанию ("xMidYMid meet") масштабирует картинку,
 * СОХРАНЯЯ эту пропорцию, подгоняя по меньшей стороне — высота была
 * зафиксирована в 60px, значит ширина результата не могла превышать
 * 60×3=180px независимо от реальной ширины контейнера (а он ощутимо шире),
 * остальное место просто пустовало. Простого атрибута тут не хватало —
 * пришлось измерить фактическую ширину контейнера (ResizeObserver, тот же
 * приём, что и container queries без самих container queries) и подставить
 * её в viewBox вместо захардкоженных 180 — тогда 1 единица viewBox = 1px
 * реального рендера, и вся раскладка столбцов (barSlot и т.п.) считается
 * уже от неё, а не от произвольного числа. До первого измерения (нулевой
 * кадр до эффекта) используется разумная по умолчанию ширина — без неё
 * график в первом кадре был бы нулевой ширины и мигал бы при появлении.
 */
import { useEffect, useRef, useState } from "react";
import type { Rental } from "../../../api/types";

/** Последние 6 календарных месяцев (включая текущий), от старого к новому —
 * подпись месяца по-русски в родительном не нужна, короткого именительного
 * достаточно для оси графика. */
function lastMonths(n: number): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleDateString("ru", { month: "short" }).replace(".", ""),
    });
  }
  return out;
}

/** Подпись месяца по ключу "YYYY-MM" в родительном падеже, для фразы
 * "Показаны аренды, начатые в …" над отфильтрованной историей в
 * ClientDetailPanel. */
export function monthKeyToLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("ru", { month: "long", year: "numeric" });
}

export function MiniActivityChart({ rentals, onSelectMonth }: { rentals: Rental[]; onSelectMonth: (monthKey: string) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (rentals.length === 0) return null;
  const months = lastMonths(6);
  const counts = months.map((m) => rentals.filter((r) => r.start_date.startsWith(m.key)).length);
  const max = Math.max(1, ...counts);
  const barSlot = width / months.length;
  const barWidth = barSlot - 6;
  return (
    <div className="slideover-section" ref={wrapRef}>
      <h4>Активность по месяцам</h4>
      <div className="field-hint" style={{ marginBottom: "6px" }}>
        Количество арендных сделок, начатых в месяце (не выручка) — нажмите на столбец, чтобы посмотреть их в истории.
      </div>
      <svg width="100%" height="60" viewBox={`0 0 ${width} 60`} style={{ display: "block" }}>
        {months.map((m, i) => {
          const x = i * barSlot + 3;
          const h = (counts[i] / max) * 38;
          return (
            <g
              key={m.key}
              onClick={() => counts[i] > 0 && onSelectMonth(m.key)}
              style={{ cursor: counts[i] > 0 ? "pointer" : "default" }}
            >
              <title>{`${m.label}: ${counts[i]}`}</title>
              {/* Прозрачная область побольше вокруг столбца — увеличивает
                  кликабельную зону сверх узкого самого столбца. */}
              <rect x={x - 2} y="0" width={Math.max(barWidth + 4, 1)} height="46" fill="transparent" />
              <rect x={x} y={44 - h} width={Math.max(barWidth, 1)} height={Math.max(h, 1)} rx="2" fill="var(--accent)" />
              <text x={x + barWidth / 2} y="56" fontSize="10" textAnchor="middle" fill="var(--muted)">
                {m.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
