/**
 * Дашборд — перенесён 1:1 из демо-прототипа (oborot-crm-prototype.html), плюс
 * возможность, которой в демо не было (запрошена пользователем отдельно):
 * каждую стат-плашку и панель можно скрыть или переименовать лично для себя
 * (см. DashboardPrefs/EditBar ниже) — настройка хранится на бэкенде per-Employee,
 * поэтому переживает выход из аккаунта и не видна другим сотрудникам бизнеса.
 * Компонент рендерит только тело раздела (плитки статистики + панели) —
 * заголовок страницы и кнопку "+ Новая аренда" рисует родительская оболочка
 * (Dashboard.tsx).
 */
import { useEffect, useState } from "react";
import { useData } from "../../context/DataContext";
import { api, ApiError } from "../../api/client";
import type { Client, DashboardPrefs, Rental } from "../../api/types";
import { money, fmtDate, dayDiff, todayISO } from "../../lib/format";
import { RENTAL_META, RATING_META, Badge, rentalDisplayStatus, equipmentDisplayStatus } from "../../lib/statusMeta";
import { topEquipmentByRevenue } from "../../lib/financeCalc";
import { IconAlert, IconEye, IconEyeOff, IconSliders, IconTrendUp, IconTrendDown } from "../../lib/icons";
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

const EMPTY_PREFS: DashboardPrefs = { hidden: [], labels: {} };

/**
 * Плавающая панель "переименовать / скрыть", показывается поверх блока только
 * в режиме настройки. defaultValue (не value) — инпут неконтролируемый,
 * значение уходит на сервер по onBlur/Enter, не на каждое нажатие клавиши;
 * key={id} гарантирует, что при повторном входе в режим настройки поле
 * подхватит актуальное значение, а не то, что осталось от прошлого рендера.
 */
function EditBar({
  id,
  defaultLabel,
  currentLabel,
  hidden,
  onToggleHidden,
  onCommitLabel,
}: {
  id: string;
  defaultLabel: string;
  currentLabel: string;
  hidden: boolean;
  onToggleHidden: (id: string) => void;
  onCommitLabel: (id: string, defaultLabel: string, value: string) => void;
}) {
  return (
    <div className="dash-editbar">
      <input
        key={id}
        type="text"
        className="dash-editbar-input"
        defaultValue={currentLabel}
        placeholder={defaultLabel}
        title="Своё название блока (для вас лично)"
        onBlur={(e) => onCommitLabel(id, defaultLabel, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      <button
        type="button"
        className="icon-btn"
        onClick={() => onToggleHidden(id)}
        title={hidden ? "Показать блок" : "Скрыть блок"}
      >
        {hidden ? <IconEyeOff /> : <IconEye />}
      </button>
    </div>
  );
}

function StatTile({
  label,
  value,
  mono,
  critical,
  delta,
  onClick,
  disabled,
}: {
  label: string;
  value: string | number;
  mono?: boolean;
  critical?: boolean;
  delta?: { pct: number; tone: DeltaTone } | null;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button className="stat-tile" onClick={disabled ? undefined : onClick} disabled={disabled}>
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

  // ---------- Личная настройка дашборда (скрыть/переименовать) ----------
  const [prefs, setPrefs] = useState<DashboardPrefs>(EMPTY_PREFS);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [editMode, setEditMode] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPrefsLoaded(false);
    api
      .get<DashboardPrefs>(`/businesses/${businessId}/dashboard-prefs`)
      .then((p) => {
        if (!cancelled) setPrefs({ hidden: p.hidden ?? [], labels: p.labels ?? {} });
      })
      .catch(() => {
        // Настройка чисто косметическая — если не загрузилась, просто
        // показываем всё по умолчанию, без ошибки пользователю.
      })
      .finally(() => {
        if (!cancelled) setPrefsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  function toggleHidden(id: string) {
    const hiddenList = prefs.hidden.includes(id) ? prefs.hidden.filter((x) => x !== id) : [...prefs.hidden, id];
    const next = { ...prefs, hidden: hiddenList };
    setPrefs(next);
    void api.put(`/businesses/${businessId}/dashboard-prefs`, next).catch(() => {});
  }

  function commitLabel(id: string, defaultLabel: string, value: string) {
    const trimmed = value.trim();
    const labels = { ...prefs.labels };
    if (!trimmed || trimmed === defaultLabel) delete labels[id];
    else labels[id] = trimmed;
    const next = { ...prefs, labels };
    setPrefs(next);
    void api.put(`/businesses/${businessId}/dashboard-prefs`, next).catch(() => {});
  }

  function label(id: string, fallback: string): string {
    return prefs.labels[id] || fallback;
  }
  function isHidden(id: string): boolean {
    return prefs.hidden.includes(id);
  }
  /** Блок рендерится, если он не скрыт ИЛИ мы в режиме настройки (тогда скрытые
   * тоже видны, но приглушены — иначе их было бы невозможно снова показать). */
  function shows(id: string): boolean {
    return editMode || !isHidden(id);
  }

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
      <div className="dash-toolbar">
        <button
          type="button"
          className={"btn btn-sm" + (editMode ? " btn-primary" : "")}
          disabled={!prefsLoaded}
          onClick={() => setEditMode((v) => !v)}
          title="Скрыть ненужные плашки и панели дашборда или переименовать их для себя"
        >
          <IconSliders /> {editMode ? "Готово" : "Настроить дашборд"}
        </button>
      </div>

      <div className="stat-grid">
        {shows("stat-active") && (
          <div className={"dash-block-cell" + (isHidden("stat-active") ? " dash-block-hidden" : "")}>
            {editMode && (
              <EditBar
                id="stat-active"
                defaultLabel="В аренде сейчас"
                currentLabel={label("stat-active", "В аренде сейчас")}
                hidden={isHidden("stat-active")}
                onToggleHidden={toggleHidden}
                onCommitLabel={commitLabel}
              />
            )}
            <StatTile
              label={label("stat-active", "В аренде сейчас")}
              value={rentedEquipIds.size}
              disabled={editMode}
              onClick={() => navigate("rentals", { rentalFilter: "active" })}
            />
          </div>
        )}
        {shows("stat-free") && (
          <div className={"dash-block-cell" + (isHidden("stat-free") ? " dash-block-hidden" : "")}>
            {editMode && (
              <EditBar
                id="stat-free"
                defaultLabel={"Свободно из " + usableEquip.length}
                currentLabel={label("stat-free", "Свободно из " + usableEquip.length)}
                hidden={isHidden("stat-free")}
                onToggleHidden={toggleHidden}
                onCommitLabel={commitLabel}
              />
            )}
            <StatTile
              label={label("stat-free", "Свободно из " + usableEquip.length)}
              value={freeCount}
              disabled={editMode}
              onClick={() => navigate("equipment", { equipmentFilter: "available" })}
            />
          </div>
        )}
        {shows("stat-overdue") && (
          <div className={"dash-block-cell" + (isHidden("stat-overdue") ? " dash-block-hidden" : "")}>
            {editMode && (
              <EditBar
                id="stat-overdue"
                defaultLabel="Просрочено возвратов"
                currentLabel={label("stat-overdue", "Просрочено возвратов")}
                hidden={isHidden("stat-overdue")}
                onToggleHidden={toggleHidden}
                onCommitLabel={commitLabel}
              />
            )}
            <StatTile
              label={label("stat-overdue", "Просрочено возвратов")}
              value={overdue.length}
              critical={overdue.length > 0}
              disabled={editMode}
              onClick={() => navigate("rentals", { rentalFilter: "overdue" })}
            />
          </div>
        )}
        {shows("stat-revenue30") && (
          <div className={"dash-block-cell" + (isHidden("stat-revenue30") ? " dash-block-hidden" : "")}>
            {editMode && (
              <EditBar
                id="stat-revenue30"
                defaultLabel="Выручка за 30 дней"
                currentLabel={label("stat-revenue30", "Выручка за 30 дней")}
                hidden={isHidden("stat-revenue30")}
                onToggleHidden={toggleHidden}
                onCommitLabel={commitLabel}
              />
            )}
            <StatTile
              label={label("stat-revenue30", "Выручка за 30 дней")}
              value={money(revenue30)}
              mono
              delta={revenueDelta}
              disabled={editMode}
              onClick={() => navigate("finance", { finance30: true })}
            />
          </div>
        )}
        {shows("stat-deposits") && (
          <div className={"dash-block-cell" + (isHidden("stat-deposits") ? " dash-block-hidden" : "")}>
            {editMode && (
              <EditBar
                id="stat-deposits"
                defaultLabel="Депозиты на удержании"
                currentLabel={label("stat-deposits", "Депозиты на удержании")}
                hidden={isHidden("stat-deposits")}
                onToggleHidden={toggleHidden}
                onCommitLabel={commitLabel}
              />
            )}
            <StatTile
              label={label("stat-deposits", "Депозиты на удержании")}
              value={money(depositsHeld)}
              mono
              disabled={editMode}
              onClick={() => navigate("finance", { finance30: true })}
            />
          </div>
        )}
        {shows("stat-damage30") && (
          <div className={"dash-block-cell" + (isHidden("stat-damage30") ? " dash-block-hidden" : "")}>
            {editMode && (
              <EditBar
                id="stat-damage30"
                defaultLabel="Компенсации за повреждения"
                currentLabel={label("stat-damage30", "Компенсации за повреждения")}
                hidden={isHidden("stat-damage30")}
                onToggleHidden={toggleHidden}
                onCommitLabel={commitLabel}
              />
            )}
            <StatTile
              label={label("stat-damage30", "Компенсации за повреждения")}
              value={money(damage30)}
              mono
              disabled={editMode}
              onClick={() => navigate("finance", { finance30: true })}
            />
          </div>
        )}
      </div>

      <div className="dash-grid">
        {shows("panel-due") && (
          <div className={"dash-block-cell" + (isHidden("panel-due") ? " dash-block-hidden" : "")}>
            {editMode && (
              <EditBar
                id="panel-due"
                defaultLabel="Ближайшие и просроченные возвраты"
                currentLabel={label("panel-due", "Ближайшие и просроченные возвраты")}
                hidden={isHidden("panel-due")}
                onToggleHidden={toggleHidden}
                onCommitLabel={commitLabel}
              />
            )}
            <div className="panel">
              <div className="panel-head">
                <h2>{label("panel-due", "Ближайшие и просроченные возвраты")}</h2>
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
          </div>
        )}

        {shows("panel-categories") && (
          <div className={"dash-block-cell" + (isHidden("panel-categories") ? " dash-block-hidden" : "")}>
            {editMode && (
              <EditBar
                id="panel-categories"
                defaultLabel="Загрузка по категориям"
                currentLabel={label("panel-categories", "Загрузка по категориям")}
                hidden={isHidden("panel-categories")}
                onToggleHidden={toggleHidden}
                onCommitLabel={commitLabel}
              />
            )}
            <div className="panel">
              <div className="panel-head">
                <h2>{label("panel-categories", "Загрузка по категориям")}</h2>
                <span className="hint">{overallPct}% в среднем</span>
              </div>
              <div className="panel-body">
                {catKeys.length === 0 && <div className="empty-note">Нет данных</div>}
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
        )}
      </div>

      {shows("panel-risky") && (
        <div
          className={"dash-block-cell" + (isHidden("panel-risky") ? " dash-block-hidden" : "")}
          style={{ marginTop: 16 }}
        >
          {editMode && (
            <EditBar
              id="panel-risky"
              defaultLabel="Клиенты, требующие внимания"
              currentLabel={label("panel-risky", "Клиенты, требующие внимания")}
              hidden={isHidden("panel-risky")}
              onToggleHidden={toggleHidden}
              onCommitLabel={commitLabel}
            />
          )}
          <div className="panel">
            <div className="panel-head">
              <h2 style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ display: "flex", color: "var(--critical)" }}>
                  <IconAlert />
                </span>
                {label("panel-risky", "Клиенты, требующие внимания")}
              </h2>
            </div>
            <div className="panel-body">
              {riskyList.length === 0 ? (
                <div className="empty-note">Ничего не найдено.</div>
              ) : (
                riskyList.map((x) => {
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
                })
              )}
            </div>
          </div>
        </div>
      )}

      {shows("panel-topequip") && (
        <div
          className={"dash-block-cell" + (isHidden("panel-topequip") ? " dash-block-hidden" : "")}
          style={{ marginTop: 16 }}
        >
          {editMode && (
            <EditBar
              id="panel-topequip"
              defaultLabel="Топ оборудования по доходу"
              currentLabel={label("panel-topequip", "Топ оборудования по доходу")}
              hidden={isHidden("panel-topequip")}
              onToggleHidden={toggleHidden}
              onCommitLabel={commitLabel}
            />
          )}
          <div className="panel">
            <div className="panel-head">
              <h2>{label("panel-topequip", "Топ оборудования по доходу")}</h2>
              <span className="hint">за всё время</span>
            </div>
            <div className="panel-body">
              {topEquip.length === 0 ? (
                <div className="empty-note">Ничего не найдено.</div>
              ) : (
                topEquip.map((x) => {
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
                })
              )}
            </div>
          </div>
        </div>
      )}

      {shows("panel-pickup") && (
        <div
          className={"dash-block-cell" + (isHidden("panel-pickup") ? " dash-block-hidden" : "")}
          style={{ marginTop: 16 }}
        >
          {editMode && (
            <EditBar
              id="panel-pickup"
              defaultLabel="Выдача ожидается сегодня"
              currentLabel={label("panel-pickup", "Выдача ожидается сегодня")}
              hidden={isHidden("panel-pickup")}
              onToggleHidden={toggleHidden}
              onCommitLabel={commitLabel}
            />
          )}
          <div className="panel">
            <div className="panel-head">
              <h2>{label("panel-pickup", "Выдача ожидается сегодня")}</h2>
            </div>
            <div className="panel-body">
              {pickupToday.length === 0 ? (
                <div className="empty-note">Ничего не найдено.</div>
              ) : (
                pickupToday.map((r) => {
                  const c = clients.find((x) => x.id === r.client_id);
                  const names = itemNames(r);
                  return (
                    <div
                      className={"mini-item" + (c ? " clickable" : "")}
                      key={r.id}
                      onClick={c ? () => openClient(c) : undefined}
                    >
                      <span>
                        <b>{c?.name ?? "—"}</b> — {names}
                      </span>
                      <span className="mini-item-actions">
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleIssue(r.id);
                          }}
                        >
                          Выдать
                        </button>
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {shows("panel-duetoday") && (
        <div
          className={"dash-block-cell" + (isHidden("panel-duetoday") ? " dash-block-hidden" : "")}
          style={{ marginTop: 16 }}
        >
          {editMode && (
            <EditBar
              id="panel-duetoday"
              defaultLabel="Возврат ожидается сегодня"
              currentLabel={label("panel-duetoday", "Возврат ожидается сегодня")}
              hidden={isHidden("panel-duetoday")}
              onToggleHidden={toggleHidden}
              onCommitLabel={commitLabel}
            />
          )}
          <div className="panel">
            <div className="panel-head">
              <h2>{label("panel-duetoday", "Возврат ожидается сегодня")}</h2>
            </div>
            <div className="panel-body">
              {dueToday.length === 0 ? (
                <div className="empty-note">Ничего не найдено.</div>
              ) : (
                dueToday.map((r) => {
                  const c = clients.find((x) => x.id === r.client_id);
                  const names = itemNames(r);
                  return (
                    <div
                      className={"mini-item" + (c ? " clickable" : "")}
                      key={r.id}
                      onClick={c ? () => openClient(c) : undefined}
                    >
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
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate("rentals", { rentalFilter: "active", search: c?.name ?? "" });
                          }}
                        >
                          Принять возврат
                        </button>
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
