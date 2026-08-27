import { useState } from "react";
import { api, ApiError } from "../../api/client";
import { useData } from "../../context/DataContext";
import { EQ_META, Badge, equipmentDisplayStatus, nextFreeDate } from "../../lib/statusMeta";
import { money, fmtDate, isoAddDays, todayISO } from "../../lib/format";

const FILTERS: { id: string; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "available", label: "Свободно" },
  { id: "rented", label: "В аренде" },
  { id: "overdue", label: "Просрочено" },
  { id: "maintenance", label: "Обслуживание" },
  { id: "retired", label: "Списано" },
];

interface EquipmentForm {
  name: string;
  category: string;
  code: string;
  daily_rate: string;
  deposit: string;
  period_days: string;
  period_price: string;
  period_price_after: string;
}

const EMPTY_FORM: EquipmentForm = {
  name: "",
  category: "",
  code: "",
  daily_rate: "",
  deposit: "0",
  period_days: "",
  period_price: "",
  period_price_after: "",
};

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
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<EquipmentForm>(EMPTY_FORM);

  const today = todayISO();
  const q = search.trim().toLowerCase();
  const list = equipment.filter((e) => {
    const matchesFilter = filter === "all" || equipmentDisplayStatus(e, rentals, today) === filter;
    const matchesSearch = !q || (e.name + " " + e.category + " " + (e.code ?? "")).toLowerCase().includes(q);
    return matchesFilter && matchesSearch;
  });

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/businesses/${businessId}/equipment`, {
        name: form.name,
        category: form.category,
        code: form.code || null,
        daily_rate: Number(form.daily_rate),
        deposit: Number(form.deposit || 0),
        period_days: form.period_days ? Number(form.period_days) : null,
        period_price: form.period_price ? Number(form.period_price) : null,
        period_price_after: form.period_price_after ? Number(form.period_price_after) : null,
      });
      setForm(EMPTY_FORM);
      setShowForm(false);
      await reloadEquipment();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось добавить оборудование");
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Списать/удалить эту позицию?")) return;
    try {
      await api.delete(`/businesses/${businessId}/equipment/${id}`);
      await reloadEquipment();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Не удалось удалить");
    }
  }

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
        <button className="btn" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Отмена" : "+ Добавить"}
        </button>
      </div>

      {showForm && (
        <form className="form-grid" onSubmit={handleCreate}>
          <label>
            Название
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            Категория
            <input required value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
          </label>
          <label>
            Код/инвентарный номер
            <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </label>
          <label>
            Ставка в день, ₽
            <input
              required
              type="number"
              min="0"
              value={form.daily_rate}
              onChange={(e) => setForm({ ...form, daily_rate: e.target.value })}
            />
          </label>
          <label>
            Залог, ₽
            <input
              type="number"
              min="0"
              value={form.deposit}
              onChange={(e) => setForm({ ...form, deposit: e.target.value })}
            />
          </label>
          <label>
            Ступенчатый тариф: период, дней
            <input
              type="number"
              min="0"
              value={form.period_days}
              onChange={(e) => setForm({ ...form, period_days: e.target.value })}
            />
          </label>
          <label>
            цена периода, ₽
            <input
              type="number"
              min="0"
              value={form.period_price}
              onChange={(e) => setForm({ ...form, period_price: e.target.value })}
            />
          </label>
          <label>
            цена след. периода, ₽
            <input
              type="number"
              min="0"
              value={form.period_price_after}
              onChange={(e) => setForm({ ...form, period_price_after: e.target.value })}
            />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button type="submit" className="btn btn-primary">
            Сохранить
          </button>
        </form>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Название</th>
              <th>Категория</th>
              <th>Статус</th>
              <th>Ставка/день</th>
              <th>Залог</th>
              <th />
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
                <tr key={it.id}>
                  <td>
                    <div className="cell-name">{it.name}</div>
                    <div className="cell-sub">№ {it.code ?? "—"}</div>
                  </td>
                  <td>{it.category}</td>
                  <td>
                    <Badge meta={EQ_META[status]} />
                    {freeFrom && <div className="cell-sub">своб. с {freeFrom}</div>}
                  </td>
                  <td className="mono">{money(it.daily_rate)}</td>
                  <td className="mono">{money(it.deposit)}</td>
                  <td>
                    <button className="btn btn-sm btn-danger-ghost" onClick={() => handleDelete(it.id)}>
                      Удалить
                    </button>
                  </td>
                </tr>
              );
            })}
            {list.length === 0 && (
              <tr>
                <td colSpan={6} className="empty-note">
                  {q ? `Ничего не найдено по запросу «${search}».` : "Пока нет ни одной позиции оборудования."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
