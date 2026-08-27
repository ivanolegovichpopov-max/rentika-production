import { useEffect, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { Client, Equipment, Rental } from "../../api/types";

const STATUS_LABEL: Record<Rental["status"], string> = {
  booked: "Забронировано",
  active: "В работе",
  overdue: "Просрочено",
  returned: "Возвращено",
  cancelled: "Отменено",
};

export function RentalsTab({ businessId }: { businessId: string }) {
  const [rentals, setRentals] = useState<Rental[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ client_id: "", equipment_id: "", start_date: "", end_date: "" });

  async function load() {
    setLoading(true);
    try {
      const [r, c, e] = await Promise.all([
        api.get<Rental[]>(`/businesses/${businessId}/rentals`),
        api.get<Client[]>(`/businesses/${businessId}/clients`),
        api.get<Equipment[]>(`/businesses/${businessId}/equipment`),
      ]);
      setRentals(r);
      setClients(c);
      setEquipment(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId]);

  function clientName(id: string) {
    return clients.find((c) => c.id === id)?.name ?? "—";
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/businesses/${businessId}/rentals`, {
        client_id: form.client_id,
        equipment_ids: [form.equipment_id],
        start_date: form.start_date,
        end_date: form.end_date,
      });
      setForm({ client_id: "", equipment_id: "", start_date: "", end_date: "" });
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось создать аренду");
    }
  }

  async function handleAction(action: "issue" | "cancel" | "return", rentalId: string) {
    try {
      if (action === "return") {
        const damageFeeStr = prompt("Сумма компенсации за повреждения (если нет — оставьте 0):", "0");
        if (damageFeeStr === null) return;
        await api.post(`/businesses/${businessId}/rentals/${rentalId}/return`, {
          damage_fee: Number(damageFeeStr || 0),
        });
      } else {
        await api.post(`/businesses/${businessId}/rentals/${rentalId}/${action}`);
      }
      await load();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Не удалось выполнить действие");
    }
  }

  if (loading) return <div className="muted">Загрузка…</div>;

  const availableEquipment = equipment.filter((e) => e.status === "available");

  return (
    <div>
      <div className="tab-toolbar">
        <h2>Аренды</h2>
        <button onClick={() => setShowForm((v) => !v)}>{showForm ? "Отмена" : "+ Новая аренда"}</button>
      </div>

      {showForm && (
        <form className="card form-grid" onSubmit={handleCreate}>
          <label>
            Клиент
            <select required value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })}>
              <option value="" disabled>Выберите клиента</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label>
            Оборудование
            <select required value={form.equipment_id} onChange={(e) => setForm({ ...form, equipment_id: e.target.value })}>
              <option value="" disabled>Выберите оборудование</option>
              {availableEquipment.map((eq) => (
                <option key={eq.id} value={eq.id}>{eq.name} ({eq.daily_rate} ₽/день)</option>
              ))}
            </select>
          </label>
          <label>
            Дата начала
            <input required type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
          </label>
          <label>
            Дата окончания
            <input required type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button type="submit">Оформить</button>
        </form>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th>Клиент</th>
            <th>Период</th>
            <th>Сумма</th>
            <th>Статус</th>
            <th>Действия</th>
          </tr>
        </thead>
        <tbody>
          {rentals.map((r) => (
            <tr key={r.id}>
              <td>{clientName(r.client_id)}</td>
              <td>{r.start_date} — {r.end_date}</td>
              <td className="mono">{r.amount} ₽</td>
              <td>
                <span className={`badge badge-${r.status}`}>{STATUS_LABEL[r.status]}</span>
              </td>
              <td className="row-actions">
                {r.status === "booked" && (
                  <button className="link" onClick={() => handleAction("issue", r.id)}>Выдать</button>
                )}
                {(r.status === "booked" || r.status === "active") && (
                  <button className="link danger" onClick={() => handleAction("cancel", r.id)}>Отменить</button>
                )}
                {(r.status === "active" || r.status === "overdue") && (
                  <button className="link" onClick={() => handleAction("return", r.id)}>Принять возврат</button>
                )}
              </td>
            </tr>
          ))}
          {rentals.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">Аренд пока нет.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
