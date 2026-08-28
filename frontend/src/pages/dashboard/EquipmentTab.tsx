import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import { useData } from "../../context/DataContext";
import type { Equipment, Rental } from "../../api/types";
import { EQ_META, RENTAL_META, Badge, equipmentDisplayStatus, nextFreeDate, rentalDisplayStatus } from "../../lib/statusMeta";
import { money, fmtDate, isoAddDays, todayISO } from "../../lib/format";
import { IconClose } from "../../lib/icons";

const FILTERS: { id: string; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "available", label: "Свободно" },
  { id: "rented", label: "В аренде" },
  { id: "overdue", label: "Просрочено" },
  { id: "maintenance", label: "Обслуживание" },
  { id: "retired", label: "Списано" },
];

/* ============================================================
   Сортировка таблицы — перенесено 1:1 из демо (EQUIPMENT_SORT_COLUMNS /
   equipmentSortValue / sortEquipmentList / setEquipmentSort).
   ============================================================ */
const EQUIPMENT_SORT_COLUMNS: { key: string; label: string }[] = [
  { key: "name", label: "Оборудование" },
  { key: "category", label: "Категория" },
  { key: "status", label: "Статус" },
  { key: "rate", label: "Ставка" },
  { key: "deposit", label: "Депозит" },
];

const EQUIPMENT_STATUS_PRIORITY: Record<string, number> = {
  overdue: 0,
  rented: 1,
  available: 2,
  maintenance: 3,
  retired: 4,
};

interface EquipmentSort {
  key: string | null;
  dir: "asc" | "desc";
}

function equipmentSortValue(e: Equipment, key: string, rentals: Rental[], today: string): string | number {
  if (key === "name") return e.name.toLowerCase();
  if (key === "category") return e.category.toLowerCase();
  if (key === "status") return EQUIPMENT_STATUS_PRIORITY[equipmentDisplayStatus(e, rentals, today)] ?? 99;
  if (key === "rate") return e.daily_rate;
  if (key === "deposit") return e.deposit;
  return 0;
}

function sortEquipmentList(list: Equipment[], sort: EquipmentSort, rentals: Rental[], today: string): Equipment[] {
  if (!sort.key) return list;
  const key = sort.key;
  const dir = sort.dir === "desc" ? -1 : 1;
  return [...list].sort((a, b) => {
    const va = equipmentSortValue(a, key, rentals, today);
    const vb = equipmentSortValue(b, key, rentals, today);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return a.name.localeCompare(b.name, "ru");
  });
}

/** Подпись ставки с учётом ступенчатого тарифа — 1:1 из демо (rateLabel). */
function rateLabel(e: Equipment): string {
  if (e.period_days && e.period_price) {
    return (
      money(e.period_price) +
      "/" +
      e.period_days +
      "дн" +
      (e.period_price_after ? " → " + money(e.period_price_after) + "/" + e.period_days + "дн" : "")
    );
  }
  return money(e.daily_rate) + "/сутки";
}

/* ============================================================
   Показатели позиции в слайд-панели — эквиваленты демо-функций
   equipmentRevenueMap / equipmentUtilization / equipmentHasOpenRentals.
   ============================================================ */
function isUnderMaintenanceOn(eq: Equipment, dateIso: string): boolean {
  if (eq.status !== "maintenance") return false;
  if (!eq.maintenance_until) return true;
  return dateIso <= eq.maintenance_until;
}

type DayCategory = "maintenance" | "busy" | "available";

/** Статус позиции на конкретный день — та же классификация, что и
 * equipmentDisplayStatus/календарь в демо, но упрощена до трёх корзин
 * (обслуживание / занято / свободно), которых достаточно для загрузки. */
function equipmentDayCategory(e: Equipment, d: string, rentals: Rental[]): DayCategory {
  if (isUnderMaintenanceOn(e, d)) return "maintenance";
  const busy = rentals.some(
    (r) =>
      (r.status === "booked" || r.status === "active") &&
      d >= r.start_date &&
      d <= r.end_date &&
      r.items.some((it) => it.equipment_id === e.id)
  );
  return busy ? "busy" : "available";
}

/** Загрузка позиции за последние `days` дней в процентах — дни на
 * обслуживании исключены из знаменателя (простой по ремонту не
 * считается неэффективностью), как в демо. */
function equipmentUtilizationPct(e: Equipment, rentals: Rental[], days = 90): number {
  let busy = 0;
  let maint = 0;
  for (let i = 0; i < days; i++) {
    const d = isoAddDays(todayISO(), -i);
    const cat = equipmentDayCategory(e, d, rentals);
    if (cat === "maintenance") maint++;
    else if (cat === "busy") busy++;
  }
  const denom = days - maint;
  return denom > 0 ? Math.round((busy / denom) * 100) : 0;
}

/** Выручка по каждой позиции оборудования за всё время (по завершённым
 * арендам), с распределением суммы аренды/просрочки/повреждений
 * пропорционально ставке — 1:1 из демо (equipmentRevenueMap), только на
 * реальных полях backend'а (Rental.base/late_fee/damage_fee и
 * RentalItem.daily_rate_snapshot вместо пересчёта на фронте). */
function equipmentRevenueMap(rentals: Rental[]): Record<string, number> {
  const map: Record<string, number> = {};
  rentals.forEach((r) => {
    if (r.status !== "returned") return;
    const totalDaily = r.items.reduce((s, it) => s + it.daily_rate_snapshot, 0) || 1;
    r.items.forEach((it) => {
      const share = it.daily_rate_snapshot / totalDaily;
      const rev = (r.base + r.late_fee) * share + r.damage_fee / r.items.length;
      map[it.equipment_id] = (map[it.equipment_id] || 0) + rev;
    });
  });
  return map;
}

/** Есть ли у позиции незакрытая аренда (в работе или забронирована) —
 * определяется на фронте из уже загруженного списка аренд, без нового
 * эндпоинта, 1:1 с демо (equipmentHasOpenRentals). */
function equipmentHasOpenRentals(equipmentId: string, rentals: Rental[]): boolean {
  return rentals.some(
    (r) => (r.status === "active" || r.status === "booked") && r.items.some((it) => it.equipment_id === equipmentId)
  );
}

/* ============================================================
   Форма добавления/изменения оборудования
   ============================================================ */
interface EquipmentFormState {
  name: string;
  category: string;
  code: string;
  daily_rate: string;
  deposit: string;
  period_days: string;
  period_price: string;
  period_price_after: string;
}

const EMPTY_FORM: EquipmentFormState = {
  name: "",
  category: "",
  code: "",
  daily_rate: "",
  deposit: "0",
  period_days: "",
  period_price: "",
  period_price_after: "",
};

function formFromEquipment(e: Equipment): EquipmentFormState {
  return {
    name: e.name,
    category: e.category,
    code: e.code ?? "",
    daily_rate: String(e.daily_rate),
    deposit: String(e.deposit),
    period_days: e.period_days != null ? String(e.period_days) : "",
    period_price: e.period_price != null ? String(e.period_price) : "",
    period_price_after: e.period_price_after != null ? String(e.period_price_after) : "",
  };
}

function formToPayload(form: EquipmentFormState) {
  return {
    name: form.name,
    category: form.category,
    code: form.code || null,
    daily_rate: Number(form.daily_rate) || 0,
    deposit: Number(form.deposit) || 0,
    period_days: form.period_days ? Number(form.period_days) : null,
    period_price: form.period_price ? Number(form.period_price) : null,
    period_price_after: form.period_price_after ? Number(form.period_price_after) : null,
  };
}

/** Модалка добавления/изменения оборудования — тот же идиом `<dialog>`
 * (ref + showModal()/close() в useEffect по `open`), что и DocModal в
 * ./documents.tsx, только с формой вместо предпросмотра документа. Поля и
 * подсказка ступенчатого тарифа — 1:1 из демо (tieredRateFieldsHtml). */
function EquipmentFormModal({
  open,
  title,
  initial,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initial: EquipmentFormState;
  error: string | null;
  onClose: () => void;
  onSubmit: (form: EquipmentFormState) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState<EquipmentFormState>(initial);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (open) setForm(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <dialog id="modal" className="wide" ref={ref} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(form);
        }}
      >
        <div className="modal-head">
          <h3>{title}</h3>
          <button type="button" className="icon-btn" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>Название</label>
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Например, перфоратор Bosch GBH 5-40"
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label>Категория</label>
              <input
                required
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="Инструмент, электроника…"
              />
            </div>
            <div className="field">
              <label>Инв. номер</label>
              <input
                required
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder="INV-000"
              />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Ставка, ₽/сутки</label>
              <input
                required
                type="number"
                min="0"
                value={form.daily_rate}
                onChange={(e) => setForm({ ...form, daily_rate: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Депозит, ₽</label>
              <input
                required
                type="number"
                min="0"
                value={form.deposit}
                onChange={(e) => setForm({ ...form, deposit: e.target.value })}
              />
            </div>
          </div>
          <div className="field-row field-row-3">
            <div className="field">
              <label>Период, дней</label>
              <input
                type="number"
                min="0"
                value={form.period_days}
                onChange={(e) => setForm({ ...form, period_days: e.target.value })}
                placeholder="напр. 7"
              />
            </div>
            <div className="field">
              <label>Цена за период, ₽</label>
              <input
                type="number"
                min="0"
                value={form.period_price}
                onChange={(e) => setForm({ ...form, period_price: e.target.value })}
                placeholder="напр. 690"
              />
            </div>
            <div className="field">
              <label>Цена за период далее, ₽</label>
              <input
                type="number"
                min="0"
                value={form.period_price_after}
                onChange={(e) => setForm({ ...form, period_price_after: e.target.value })}
                placeholder="напр. 190"
              />
            </div>
          </div>
          <div className="field-hint">
            Необязательно. Заполните, если ставка снижается при длительной аренде: первые N дней — по первой цене,
            каждый следующий период из N дней — по второй. Например: 690 ₽ за первые 7 дней, затем 190 ₽ за каждые
            следующие 7 дней.
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn btn-primary">
            Сохранить
          </button>
        </div>
      </form>
    </dialog>
  );
}

/* ============================================================
   Слайд-панель с деталями оборудования — 1:1 из демо (openEquipmentDetail):
   статус/ставка/депозит, показатели (выручка/загрузка), пикер статуса
   обслуживания (+ дата окончания), мини-история аренд, кнопки изменить/удалить.
   ============================================================ */
export function EquipmentDetailPanel({
  businessId,
  equipmentId,
  onClose,
  onEdit,
  onDeleted,
}: {
  businessId: string;
  equipmentId: string;
  onClose: () => void;
  onEdit: (id: string) => void;
  onDeleted: () => void;
}) {
  const { equipment, clients, rentals, reloadEquipment } = useData();
  const item = equipment.find((e) => e.id === equipmentId);
  const [maintUntil, setMaintUntil] = useState(item?.maintenance_until ?? "");

  useEffect(() => {
    setMaintUntil(item?.maintenance_until ?? "");
  }, [item?.id, item?.maintenance_until]);

  if (!item) return null;

  const today = todayISO();
  const status = equipmentDisplayStatus(item, rentals, today);
  const history = rentals
    .filter((r) => r.items.some((it) => it.equipment_id === equipmentId))
    .slice()
    .sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
  const lifetimeRevenue = equipmentRevenueMap(rentals)[equipmentId] ?? 0;
  const utilPct = equipmentUtilizationPct(item, rentals, 90);

  // Статус-пикер и дата окончания обслуживания PATCH'ят `/businesses/{id}/equipment/{id}`
  // частичным телом ({status: ...} / {maintenance_until: ...}), как в демо. На момент
  // написания этого файла бэкендовый PATCH (app/api/routes/equipment.py) валидирует
  // тело как EquipmentCreate (обязательные name/category/daily_rate, без полей
  // status/maintenance_until вовсе) — партиальные запросы будут отклонены/проигнорированы,
  // пока бэкенд не получит отдельную схему частичного обновления. Вне зоны ответственности
  // этого файла (владею только EquipmentTab.tsx) — оставлено как есть для параллельного фикса.
  async function setStatus(next: Equipment["status"]) {
    try {
      await api.patch(`/businesses/${businessId}/equipment/${equipmentId}`, { status: next });
      await reloadEquipment();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Не удалось изменить статус");
    }
  }

  async function handleMaintUntilChange(value: string) {
    setMaintUntil(value);
    try {
      await api.patch(`/businesses/${businessId}/equipment/${equipmentId}`, { maintenance_until: value || null });
      await reloadEquipment();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Не удалось изменить дату");
    }
  }

  function handleDelete() {
    if (equipmentHasOpenRentals(equipmentId, rentals)) {
      alert("Нельзя удалить: по этой позиции есть аренда в работе или бронь. Сначала завершите её.");
      return;
    }
    if (!confirm(`«${item!.name}» будет удалено безвозвратно.`)) return;
    void (async () => {
      try {
        await api.delete(`/businesses/${businessId}/equipment/${equipmentId}`);
        onDeleted();
        await reloadEquipment();
      } catch (err) {
        alert(err instanceof ApiError ? err.message : "Не удалось удалить");
      }
    })();
  }

  return (
    <div className="slideover">
      <div className="slideover-head">
        <div>
          <h3>{item.name}</h3>
          <div style={{ color: "var(--muted)", fontSize: "12.5px", marginTop: "2px" }}>
            № {item.code ?? "—"} · {item.category}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose}>
          <IconClose />
        </button>
      </div>

      <div className="slideover-section">
        <h4>Статус</h4>
        <div style={{ marginBottom: "10px" }}>
          <Badge meta={EQ_META[status]} />
        </div>
        <div className="kv-grid">
          <span className="k">Ставка</span>
          <span className="mono">{rateLabel(item)}</span>
          <span className="k">Депозит</span>
          <span className="mono">{money(item.deposit)}</span>
        </div>
        {/* Поля "Заметка" здесь нет: у demo-прототипа e.notes есть, но у
            production-модели Equipment (app/models/inventory.py) и её схем
            (app/schemas/inventory.py) поля notes нет вовсе — это
            задокументированный пробел относительно демо, а не баг рендера. */}
      </div>

      <div className="slideover-section">
        <h4>Показатели</h4>
        <div className="kv-grid">
          <span className="k">Выручка за всё время</span>
          <span className="mono">{money(lifetimeRevenue)}</span>
          <span className="k">Загрузка за 90 дней</span>
          <span className="mono">{utilPct}%</span>
        </div>
      </div>

      <div className="slideover-section">
        <h4>Изменить статус обслуживания</h4>
        <div className="rating-picker">
          <button
            className={"btn btn-sm" + (item.status === "available" ? " btn-primary" : "")}
            onClick={() => void setStatus("available")}
          >
            Свободно
          </button>
          <button
            className={"btn btn-sm" + (item.status === "maintenance" ? " btn-primary" : "")}
            onClick={() => void setStatus("maintenance")}
          >
            На обслуживании
          </button>
          <button
            className={"btn btn-sm" + (item.status === "retired" ? " btn-primary" : "")}
            onClick={() => void setStatus("retired")}
          >
            Списано
          </button>
        </div>
        {item.status === "maintenance" && (
          <div className="field" style={{ marginTop: "10px" }}>
            <label>Ожидаемая дата окончания (необязательно)</label>
            <input type="date" value={maintUntil} onChange={(e) => void handleMaintUntilChange(e.target.value)} />
            <div className="field-hint">
              {item.maintenance_until
                ? `До ${fmtDate(item.maintenance_until)} позиция недоступна для брони; с ${fmtDate(
                    isoAddDays(item.maintenance_until, 1)
                  )} её снова можно бронировать.`
                : "Без даты позиция считается недоступной, пока статус не сменят вручную."}
            </div>
          </div>
        )}
      </div>

      <div className="slideover-section">
        <h4>История аренд · {history.length}</h4>
        {history.length === 0 ? (
          <div className="empty-note">Ещё не сдавалось в аренду</div>
        ) : (
          history.map((r) => {
            const client = clients.find((c) => c.id === r.client_id);
            return (
              <div className="mini-item" key={r.id}>
                <span>
                  {client?.name ?? "—"} · {fmtDate(r.start_date)}—{fmtDate(r.end_date)}
                </span>
                <Badge meta={RENTAL_META[rentalDisplayStatus(r)]} />
              </div>
            );
          })
        )}
      </div>

      <div className="slideover-section" style={{ display: "flex", gap: "8px" }}>
        <button className="btn" onClick={() => onEdit(equipmentId)}>
          Изменить
        </button>
        <button className="btn btn-danger-ghost" onClick={handleDelete}>
          Удалить
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   Вкладка «Оборудование»
   ============================================================ */
export function EquipmentTab({
  businessId,
  search,
  filter,
  setFilter,
}: {
  businessId: string;
  search: string;
  filter: string;
  setFilter: (f: string) => void;
}) {
  const { equipment, rentals, reloadEquipment } = useData();
  const [sort, setSort] = useState<EquipmentSort>({ key: null, dir: "asc" });
  const [modalMode, setModalMode] = useState<"add" | "edit" | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const today = todayISO();
  const q = search.trim().toLowerCase();
  const filtered = equipment.filter((e) => {
    const matchesFilter = filter === "all" || equipmentDisplayStatus(e, rentals, today) === filter;
    const matchesSearch = !q || (e.name + " " + e.category + " " + (e.code ?? "")).toLowerCase().includes(q);
    return matchesFilter && matchesSearch;
  });
  const list = sortEquipmentList(filtered, sort, rentals, today);

  function toggleSort(key: string) {
    setSort((prev) => {
      if (prev.key === key) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
      return { key, dir: "asc" };
    });
  }

  function openAddModal() {
    setEditingId(null);
    setFormError(null);
    setModalMode("add");
  }

  function openEditModal(id: string) {
    setEditingId(id);
    setFormError(null);
    setModalMode("edit");
  }

  function closeFormModal() {
    setModalMode(null);
    setEditingId(null);
    setFormError(null);
  }

  async function handleSubmitForm(form: EquipmentFormState) {
    setFormError(null);
    try {
      if (modalMode === "edit" && editingId) {
        await api.patch(`/businesses/${businessId}/equipment/${editingId}`, formToPayload(form));
      } else {
        await api.post(`/businesses/${businessId}/equipment`, formToPayload(form));
      }
      closeFormModal();
      await reloadEquipment();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Не удалось сохранить оборудование");
    }
  }

  const editingItem = editingId ? equipment.find((e) => e.id === editingId) ?? null : null;
  const formTitle = modalMode === "edit" ? "Изменить оборудование" : "Новое оборудование";
  const formInitial = modalMode === "edit" && editingItem ? formFromEquipment(editingItem) : EMPTY_FORM;

  return (
    <div>
      <div className="tab-toolbar">
        <div className="segmented">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={filter === f.id ? "active" : ""}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button className="btn btn-primary" onClick={openAddModal}>
          + Добавить
        </button>
      </div>

      {list.length === 0 ? (
        <div className="panel">
          <div className="panel-body">
            <div className="empty-note">Ничего не найдено{q ? ` по запросу «${search}»` : ""}.</div>
          </div>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {EQUIPMENT_SORT_COLUMNS.map((col) => {
                  const active = sort.key === col.key;
                  return (
                    <th
                      key={col.key}
                      className={"sortable" + (active ? " active" : "")}
                      onClick={() => toggleSort(col.key)}
                    >
                      {col.label}
                      <span className={"sort-arrow" + (active ? "" : " sort-arrow-idle")}>
                        {active ? (sort.dir === "desc" ? "▼" : "▲") : "↕"}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {list.map((it) => {
                const status = equipmentDisplayStatus(it, rentals, today);
                let freeFrom: string | null = null;
                if (status === "rented" || status === "overdue") {
                  const nf = nextFreeDate(it, rentals);
                  if (nf) freeFrom = fmtDate(isoAddDays(nf, 1));
                } else if (status === "maintenance" && it.maintenance_until) {
                  freeFrom = fmtDate(isoAddDays(it.maintenance_until, 1));
                }
                return (
                  <tr key={it.id} data-clickable="true" onClick={() => setOpenId(it.id)}>
                    <td>
                      <div className="cell-name">{it.name}</div>
                      <div className="cell-sub">№ {it.code ?? "—"}</div>
                    </td>
                    <td>{it.category}</td>
                    <td>
                      <Badge meta={EQ_META[status]} />
                      {freeFrom && <div className="cell-sub">своб. с {freeFrom}</div>}
                    </td>
                    <td className="mono">{rateLabel(it)}</td>
                    <td className="mono">{money(it.deposit)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <EquipmentFormModal
        open={modalMode !== null}
        title={formTitle}
        initial={formInitial}
        error={formError}
        onClose={closeFormModal}
        onSubmit={(form) => void handleSubmitForm(form)}
      />

      {openId && <div className="slideover-backdrop" onClick={() => setOpenId(null)} />}
      {openId && (
        <EquipmentDetailPanel
          businessId={businessId}
          equipmentId={openId}
          onClose={() => setOpenId(null)}
          onEdit={(id) => {
            setOpenId(null);
            openEditModal(id);
          }}
          onDeleted={() => setOpenId(null)}
        />
      )}
    </div>
  );
}
