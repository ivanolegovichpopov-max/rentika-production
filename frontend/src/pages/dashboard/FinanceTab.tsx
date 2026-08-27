import { useData } from "../../context/DataContext";
import { money, fmtDate, dayDiff } from "../../lib/format";
import { rentalDisplayStatus } from "../../lib/statusMeta";
import {
  periodFor,
  returnsInPeriod,
  categoryRevenueMap,
  topClientsByRevenue,
  financeBuckets,
  depositsHeldNow,
  type FinancePeriod,
} from "../../lib/financeCalc";

/**
 * Вкладка «Финансы» — перенесена 1:1 из демо-прототипа (renderFinance()).
 * Периодом управляет родитель (Dashboard.tsx) — здесь только тело страницы,
 * заголовок <h1>Финансы</h1> рисует топбар шелла.
 *
 * Известные упрощения относительно демо (см. итоговый отчёт):
 *  - кнопка «Печать отчёта» не перенесена вовсе (см. ниже, перед тулбаром);
 *  - панель «Начислено по активным арендам» использует приближённую формулу
 *    вместо точного демо-расчёта с пропорциональным делением по дням
 *    пересечения (accruedRevenueForPeriod);
 *  - «Топ клиентов» и строки «Истории возвратов» не кликабельны — в этом
 *    изолированном пассе нет карточки клиента, на которую можно было бы
 *    перейти (в демо это были button.due-item / <tr data-action="open-client">).
 */

const PRESETS: { key: "7" | "30" | "90" | "all"; label: string }[] = [
  { key: "7", label: "7 дней" },
  { key: "30", label: "30 дней" },
  { key: "90", label: "90 дней" },
  { key: "all", label: "Весь период" },
];

const CAT_SEQ_RAMP = ["var(--seq-5)", "var(--seq-4)", "var(--seq-3)", "var(--seq-6)", "var(--seq-2)"];

export function FinanceTab({
  period,
  setPeriod,
}: {
  period: FinancePeriod;
  setPeriod: (p: FinancePeriod) => void;
}) {
  const { equipment, clients, rentals } = useData();

  const rows = returnsInPeriod(rentals, period.from, period.to);
  const sumBase = rows.reduce((s, r) => s + r.base, 0);
  const sumLate = rows.reduce((s, r) => s + r.late_fee, 0);
  const sumDamage = rows.reduce((s, r) => s + r.damage_fee, 0);
  const sumDiscount = rows.reduce((s, r) => s + r.discount, 0);
  const sumTotal = rows.reduce((s, r) => s + r.total, 0);

  const clientById = (id: string) => clients.find((c) => c.id === id);
  const equipmentById = (id: string) => equipment.find((e) => e.id === id);

  const depositsHeld = depositsHeldNow(rentals, rentalDisplayStatus);

  // Приближение демо-формулы accruedRevenueForPeriod: та честно делит сумму
  // аренды пропорционально пересечению дней аренды с выбранным периодом.
  // Здесь — упрощённо: берём весь r.total активных/просроченных аренд,
  // начавшихся не позже конца периода, без пропорционального деления по дням.
  const accrued = rentals
    .filter((r) => {
      const s = rentalDisplayStatus(r);
      return s === "active" || s === "overdue";
    })
    .filter((r) => r.start_date <= period.to && dayDiff(r.start_date) <= 0)
    .reduce((s, r) => s + r.total, 0);

  const buckets = financeBuckets(period.from, period.to, rows);
  const maxVal = Math.max(1, ...buckets.map((b) => b.total));
  const showEvery = Math.max(1, Math.ceil(buckets.length / 8));

  const topClients = topClientsByRevenue(rows, 5);

  const catRevenue = categoryRevenueMap(rows, equipment);
  const catKeys = Object.keys(catRevenue).sort((a, b) => catRevenue[b] - catRevenue[a]);
  const maxCatVal = catKeys.length ? catRevenue[catKeys[0]] : 1;

  return (
    <div>
      <div className="view-toolbar">
        <div className="segmented">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              className={period.key === p.key ? "active" : ""}
              onClick={() => setPeriod(periodFor(p.key, rentals))}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="finance-range">
          <input
            type="date"
            value={period.from}
            max={period.to}
            onChange={(e) => setPeriod({ ...period, from: e.target.value, key: "custom" })}
          />
          <span>—</span>
          <input
            type="date"
            value={period.to}
            min={period.from}
            onChange={(e) => setPeriod({ ...period, to: e.target.value, key: "custom" })}
          />
        </div>
        {/* Кнопка «Печать отчёта» из демо сознательно не перенесена: печатного
            представления финансового отчёта в проде ещё нет — печать/PDF
            в этом пассе реализована только для актов/договоров по отдельной
            аренде. Пустая disabled-кнопка выглядела бы как баг, поэтому её
            здесь просто нет — это явный пробел, см. итоговый отчёт. */}
      </div>

      <div className="stat-grid fin-stat-grid">
        <div className="stat-tile">
          <div className="stat-label">Выручка за период</div>
          <div className="stat-value mono">{money(sumTotal)}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-label">В т.ч. аренда</div>
          <div className="stat-value mono">{money(sumBase)}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-label">В т.ч. просрочка</div>
          <div className={"stat-value mono" + (sumLate > 0 ? " critical" : "")}>{money(sumLate)}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-label">В т.ч. компенсации</div>
          <div className={"stat-value mono" + (sumDamage > 0 ? " critical" : "")}>{money(sumDamage)}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-label">В т.ч. скидки</div>
          <div className="stat-value mono">{sumDiscount ? "−" + money(sumDiscount) : money(0)}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-label">Возвратов в периоде</div>
          <div className="stat-value">{rows.length}</div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h2>Динамика выручки</h2>
          <span className="hint">по факту возврата, {fmtDate(period.from)} — {fmtDate(period.to)}</span>
        </div>
        <div className="panel-body">
          {buckets.length ? (
            <div className="fin-chart">
              {buckets.map((b, i) => (
                <div className="fin-chart-bar-wrap" key={b.from + "_" + i}>
                  <div
                    className={"fin-chart-bar" + (b.total === 0 ? " fin-chart-bar-empty" : "")}
                    style={{ height: Math.max(2, Math.round((b.total / maxVal) * 100)) + "%" }}
                    title={money(b.total)}
                  />
                  {i % showEvery === 0 && <span className="fin-chart-label">{fmtDate(b.from)}</span>}
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-note" style={{ padding: "16px 18px" }}>Нет данных для графика.</div>
          )}
        </div>
      </div>

      <div className="stat-grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <div className="panel">
          <div className="panel-head">
            <h2>Депозиты на удержании</h2>
            <span className="hint">сейчас, вне периода отчёта</span>
          </div>
          <div className="panel-body">
            <div className="stat-value mono" style={{ padding: "2px 0 6px" }}>{money(depositsHeld)}</div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>Начислено по активным арендам</h2>
            <span className="hint" title="Ещё не входит в «Выручку за период» — будет учтено после фактического возврата">
              за период, сейчас
            </span>
          </div>
          <div className="panel-body">
            <div className="stat-value mono" style={{ padding: "2px 0 6px" }}>{money(accrued)}</div>
          </div>
        </div>
      </div>

      <div className="stat-grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <div className="panel">
          <div className="panel-head">
            <h2>Топ клиентов</h2>
            <span className="hint">по выручке за период</span>
          </div>
          <div className="panel-body" style={{ paddingTop: 0 }}>
            {topClients.length ? (
              topClients.map((x) => {
                const client = clientById(x.id);
                return (
                  <div className="due-item" key={x.id}>
                    <div className="due-main">
                      <div className="due-title">{client?.name}</div>
                    </div>
                    <span className="due-value">{money(x.revenue)}</span>
                  </div>
                );
              })
            ) : (
              <div className="empty-note">Нет данных за период.</div>
            )}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>Выручка по категориям</h2>
            <span className="hint">за период</span>
          </div>
          <div className="panel-body">
            {catKeys.length ? (
              catKeys.map((cat, i) => {
                const pct = Math.max(4, Math.round((catRevenue[cat] / maxCatVal) * 100));
                return (
                  <div className="util-row" key={cat}>
                    <div className="util-name">
                      <span className="util-name-text" title={cat}>{cat}</span>
                    </div>
                    <div className="util-track">
                      <div
                        className="util-fill"
                        style={{ width: pct + "%", background: CAT_SEQ_RAMP[i % CAT_SEQ_RAMP.length] }}
                      />
                    </div>
                    <div className="util-pct">{money(catRevenue[cat])}</div>
                  </div>
                );
              })
            ) : (
              <div className="empty-note">Нет данных за период.</div>
            )}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>История возвратов</h2>
          <span className="hint">{fmtDate(period.from)} — {fmtDate(period.to)}</span>
        </div>
        {rows.length === 0 ? (
          <div className="empty-note" style={{ padding: "16px 18px" }}>За выбранный период возвратов не было.</div>
        ) : (
          <div className="table-wrap" style={{ border: "none", borderRadius: 0, boxShadow: "none" }}>
            <table>
              <thead>
                <tr>
                  <th>Дата возврата</th>
                  <th>Клиент</th>
                  <th>Оборудование</th>
                  <th>Аренда</th>
                  <th>Просрочка</th>
                  <th>Повреждения</th>
                  <th>Скидка</th>
                  <th>Итого</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const client = clientById(r.client_id);
                  const itemNames = r.items.map((it) => equipmentById(it.equipment_id)?.name ?? "—").join(", ");
                  return (
                    <tr key={r.id}>
                      <td>{fmtDate(r.actual_return || r.end_date)}</td>
                      <td><div className="cell-name">{client?.name ?? "—"}</div></td>
                      <td>{itemNames}</td>
                      <td className="mono">{money(r.base)}</td>
                      <td className={"mono" + (r.late_fee ? " text-critical" : "")}>{r.late_fee ? money(r.late_fee) : "—"}</td>
                      <td className={"mono" + (r.damage_fee ? " text-critical" : "")}>{r.damage_fee ? money(r.damage_fee) : "—"}</td>
                      <td className="mono">{r.discount ? "−" + money(r.discount) : "—"}</td>
                      <td className="mono"><b>{money(r.total)}</b></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
