/**
 * Дашборд — перенесён 1:1 из демо-прототипа (oborot-crm-prototype.html).
 * Компонент рендерит только тело раздела (плитки статистики + панели) —
 * заголовок страницы и кнопку "+ Новая аренда" рисует родительская оболочка
 * (Dashboard.tsx).
 */
import { useData } from "../../context/DataContext";
import { api, ApiError } from "../../api/client";
import type { Client, Rental } from "../../api/types";
import { money, fmtDate, dayDiff, todayISO } from "../../lib/format";
import { RENTAL_META, RATING_META, Badge, rentalDisplayStatus, equipmentDisplayStatus } from "../../lib/statusMeta";
import { topEquipmentByRevenue } from "../../lib/financeCalc";
import { IconAlert, IconTrendUp, IconTrendDown } from "../../lib/icons";
import type { View } from "../Dashboard";

export type NavigateFn = (
  target: View,
  opts?: { equipmentFilter?: string; rentalFilter?: string; search?: string; finance30?: boolean }
) => void;

interface DashboardTabProps {
  navigate: NavigateFn;
  businessId: string;
}

type DeltaTone = "good" | "critical" | "flat";

function StatTile({
  label,
  value,
  mono,
  critical,
  delta,
  onClick,
}: {
  label: string;
  value: string | number;
  mono?: boolean;
  critical?: boolean;
  delta?: { pct: number; tone: DeltaTone } | null;
  onClick: () => void;
}) {
  return (
    <button className="stat-tile" onClick={onClick}>
      <div className="stat-label">{label}</div>
      <div className={"stat-value" + (mono ? " mono" : "") + (critical ? " critical" : "")}>{value}</div>
      {delta && (
        <div className={"stat-delta " + delta.tone}>
          {delta.tone === "good" ? <IconTrendUp /> : delta.tone === "critical" ? <IconTrendDown /> : null}
          {(delta.pct > 0 ? "+" : "") + delta.pct}% к пред. периоду
        </div>
      )}
    </button>
  );
}

interface CategoryStat {
  total: number;
  rented: number;
  maint: number;
}

interface RiskyEntry {
  client: Client;
  rental: Rental;
  status: string;
  priority: number;
}

export function DashboardTab({ navigate, businessId }: DashboardTabProps) {
  const { equipment, clients, rentals, reloadRentals, reloadEquipment } = useData();
  const today = todayISO();

  const activeAndOverdue = rentals.filter((r) => {
    const s = rentalDisplayStatus(r);
    return s === "active" || s === "overdue";
  });
  const overdue = activeAndOverdue.filter((r) => rentalDisplayStatus(r) === "overdue");

  const rentedEquipIds = new Set<string>();
  activeAndOverdue.forEach((r) => r.items.forEach((it) => rentedEquipIds.add(it.equipment_id)));

  const usableEquip = equipment.filter((e) => e.status !== "retired");
  const freeCount = usableEquip.filter((e) => equipmentDisplayStatus(e, rentals, today) === "available").length;

  const revenue30 = rentals
    .filter((r) => r.status === "returned" && dayDiff(r.actual_return || r.end_date) >= -30)
    .reduce((s, r) => s + r.total, 0);
  const revenuePrev30 = rentals
    .filter((r) => {
      const d = dayDiff(r.actual_return || r.end_date);
      return r.status === "returned" && d < -30 && d >= -60;
    })
    .reduce((s, r) => s + r.total, 0);
  const depositsHeld = activeAndOverdue.reduce((s, r) => s + r.deposit_total, 0);
  const damage30 = rentals
    .filter((r) => r.status === "returned" && dayDiff(r.actual_return || r.end_date) >= -30)
    .reduce((s, r) => s + r.damage_fee, 0);

  let revenueDelta: { pct: number; tone: DeltaTone } | null = null;
  if (revenuePrev30 > 0) {
    const pct = Math.round(((revenue30 - revenuePrev30) / revenuePrev30) * 100);
    revenueDelta = { pct, tone: pct > 0 ? "good" : pct < 0 ? "critical" : "flat" };
  }

  const dueList = activeAndOverdue
    .slice()
    .sort((a, b) => (a.end_date < b.end_date ? -1 : 1))
    .slice(0, 7);

  const byCategory: Record<string, CategoryStat> = {};
  usableEquip.forEach((e) => {
    if (!byCategory[e.category]) byCategory[e.category] = { total: 0, rented: 0, maint: 0 };
    byCategory[e.category].total++;
    if (rentedEquipIds.has(e.id)) byCategory[e.category].rented++;
    if (equipmentDisplayStatus(e, rentals, today) === "maintenance") byCategory[e.category].maint++;
  });
  const catKeys = Object.keys(byCategory).sort(
    (a, b) => byCategory[b].rented / byCategory[b].total - byCategory[a].rented / byCategory[a].total
  );
  const seqRamp = ["var(--seq-3)", "var(--seq-4)", "var(--seq-5)", "var(--seq-6)", "var(--seq-2)"];
  const overallPct = usableEquip.length ? Math.round((rentedEquipIds.size / usableEquip.length) * 100) : 0;

  const riskyMap: Record<string, RiskyEntry> = {};
  rentals.forEach((r) => {
    const s = rentalDisplayStatus(r);
    if (s !== "active" && s !== "overdue" && s !== "booked") return;
    const c = clients.find((x) => x.id === r.client_id);
    if (!c || c.rating === "normal") return;
    const priority = s === "overdue" ? 3 : s === "active" ? 2 : 1;
    if (!riskyMap[c.id] || riskyMap[c.id].priority < priority) {
      riskyMap[c.id] = { client: c, rental: r, status: s, priority };
    }
  });
  const riskyList = Object.values(riskyMap).sort((a, b) => b.priority - a.priority);

  const topEquip = topEquipmentByRevenue(rentals, equipment, 5);

  // "Возврат ожидается сегодня" — активные аренды, у которых плановая дата
  // возврата сегодня.
  const dueToday = rentals.filter((r) => r.status === "active" && dayDiff(r.end_date) === 0);
  // "Выдача ожидается сегодня" — забронированные аренды, стартующие сегодня.
  const pickupToday = rentals.filter((r) => r.status === "booked" && dayDiff(r.start_date) === 0);

  function itemNames(r: Rental): string {
    return r.items.map((it) => equipment.find((e) => e.id === it.equipment_id)?.name).join(", ");
  }

  // Открытие карточки клиента: отдельной детальной панели клиента на
  // дашборде пока нет — её строит другой инженер во вкладке "Клиенты"
  // (общий механизм "открыть карточку клиента" ещё не готов). Как временное
  // решение просто переходим на вкладку "Клиенты" с именем клиента в
  // поиске, чтобы его было легко найти.
  function openClient(c: Client) {
    navigate("clients", { search: c.name });
  }

  async function handleIssue(rentalId: string) {
    try {
      await api.post(`/businesses/${businessId}/rentals/${rentalId}/issue`);
      await reloadRentals();
      await reloadEquipment();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Не удалось выполнить действие");
    }
  }

  return (
    <>
      <div className="stat-grid">
        <StatTile
          label="В аренде сейчас"
          value={rentedEquipIds.size}
          onClick={() => navigate("rentals", { rentalFilter: "active" })}
        />
        <StatTile
          label={"Свободно из " + usableEquip.length}
          value={freeCount}
          onClick={() => navigate("equipment", { equipmentFilter: "available" })}
        />
        <StatTile
          label="Просрочено возвратов"
          value={overdue.length}
          critical={overdue.length > 0}
          onClick={() => navigate("rentals", { rentalFilter: "overdue" })}
        />
        <StatTile
          label="Выручка за 30 дней"
          value={money(revenue30)}
          mono
          delta={revenueDelta}
          onClick={() => navigate("finance", { finance30: true })}
        />
        <StatTile
          label="Депозиты на удержании"
          value={money(depositsHeld)}
          mono
          onClick={() => navigate("finance", { finance30: true })}
        />
        <StatTile
          label="Компенсации за повреждения"
          value={money(damage30)}
          mono
          onClick={() => navigate("finance", { finance30: true })}
        />
      </div>

      <div className="dash-grid">
        <div className="panel">
          <div className="panel-head">
            <h2>Ближайшие и просроченные возвраты</h2>
            <span className="hint">{activeAndOverdue.length} в работе</span>
          </div>
          <div className="panel-body">
            {activeAndOverdue.length === 0 ? (
              <div className="empty-note">Активных аренд нет.</div>
            ) : (
              dueList.map((r) => {
                const c = clients.find((x) => x.id === r.client_id);
                const names = itemNames(r);
                const st = rentalDisplayStatus(r);
                const metaText =
                  st === "overdue"
                    ? "просрочено на " + Math.abs(dayDiff(r.end_date)) + " дн."
                    : "до " + fmtDate(r.end_date);
                const inner = (
                  <>
                    <div className="due-main">
                      <div className="due-title">{c?.name ?? "—"}</div>
                      <div className="due-meta">
                        {names} · {metaText}
                      </div>
                    </div>
                    <Badge meta={RENTAL_META[st]} />
                  </>
                );
                return c ? (
                  <button key={r.id} className="due-item" onClick={() => openClient(c)}>
                    {inner}
                  </button>
                ) : (
                  <div key={r.id} className="due-item">
                    {inner}
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Загрузка по категориям</h2>
            <span className="hint">{overallPct}% в среднем</span>
          </div>
          <div className="panel-body">
            {catKeys.map((cat, i) => {
              const d = byCategory[cat];
              const pct = Math.round((d.rented / d.total) * 100);
              return (
                <button
                  key={cat}
                  className="util-row"
                  onClick={() => navigate("equipment", { equipmentFilter: "all", search: cat })}
                >
                  <div className="util-name">
                    <span className="util-name-text" title={cat}>
                      {cat}
                    </span>
                    {d.maint > 0 && (
                      <span className="util-maint" title={`${d.maint} на обслуживании`}>
                        +{d.maint}
                      </span>
                    )}
                  </div>
                  <div className="util-track">
                    <div
                      className="util-fill"
                      style={{ width: Math.max(4, pct) + "%", background: seqRamp[i % seqRamp.length] }}
                    />
                  </div>
                  <div className="util-pct">{pct}%</div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {riskyList.length > 0 && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <h2 style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ display: "flex", color: "var(--critical)" }}>
                <IconAlert />
              </span>
              Клиенты, требующие внимания
            </h2>
          </div>
          <div className="panel-body">
            {riskyList.map((x) => {
              const c = x.client;
              const r = x.rental;
              const metaText =
                x.status === "booked"
                  ? "бронь с " + fmtDate(r.start_date)
                  : x.status === "overdue"
                    ? "просрочено на " + Math.abs(dayDiff(r.end_date)) + " дн."
                    : "до " + fmtDate(r.end_date);
              const names = itemNames(r);
              return (
                <button key={c.id} className="due-item" onClick={() => openClient(c)}>
                  <div className="due-main">
                    <div className="due-title">{c.name}</div>
                    <div className="due-meta">
                      {names} · {metaText}
                    </div>
                  </div>
                  <Badge meta={RATING_META[c.rating]} />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {topEquip.length > 0 && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <h2>Топ оборудования по доходу</h2>
            <span className="hint">за всё время</span>
          </div>
          <div className="panel-body">
            {topEquip.map((x) => {
              const e = equipment.find((eq) => eq.id === x.id);
              if (!e) return null;
              return (
                <button
                  key={x.id}
                  className="due-item"
                  // Отдельной карточки/детали оборудования тоже пока нет —
                  // переходим на вкладку "Оборудование" с фильтром по имени,
                  // как разумный временный вариант.
                  onClick={() => navigate("equipment", { equipmentFilter: "all", search: e.name })}
                >
                  <div className="due-main">
                    <div className="due-title">{e.name}</div>
                    <div className="due-meta">{e.category}</div>
                  </div>
                  <span className="due-value">{money(x.revenue)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {pickupToday.length > 0 && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <h2>Выдача ожидается сегодня</h2>
          </div>
          <div className="panel-body">
            {pickupToday.map((r) => {
              const c = clients.find((x) => x.id === r.client_id);
              const names = itemNames(r);
              return (
                <div className="mini-item" key={r.id}>
                  <span>
                    <b>{c?.name ?? "—"}</b> — {names}
                  </span>
                  <span className="mini-item-actions">
                    <button className="btn btn-primary btn-sm" onClick={() => void handleIssue(r.id)}>
                      Выдать
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {dueToday.length > 0 && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <h2>Возврат ожидается сегодня</h2>
          </div>
          <div className="panel-body">
            {dueToday.map((r) => {
              const c = clients.find((x) => x.id === r.client_id);
              const names = itemNames(r);
              return (
                <div className="mini-item" key={r.id}>
                  <span>
                    <b>{c?.name ?? "—"}</b> — {names}
                  </span>
                  <span className="mini-item-actions">
                    {/* Полная форма возврата (с полями компенсации за
                        повреждения и скидки) живёт во вкладке "Аренды" —
                        здесь, для быстрого действия с дашборда, просто
                        переходим туда с этим клиентом в поиске. */}
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => navigate("rentals", { rentalFilter: "active", search: c?.name ?? "" })}
                    >
                      Принять возврат
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
