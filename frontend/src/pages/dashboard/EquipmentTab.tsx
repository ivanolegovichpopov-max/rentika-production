import { useEffect, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { Equipment } from "../../api/types";

const STATUS_LABEL: Record<Equipment["status"], string> = {
  available: "Свободно",
  rented: "В аренде",
  maintenance: "Обслуживание",
  retired: "Списано",
};

export function EquipmentTab({ businessId }: { businessId: string }) {
  const [items, setItems] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", category: "", code: "", daily_rate: "", deposit: "0" });

  async function load() {
    setLoading(true);
    try {
      setItems(await api.get<Equipment[]>(`/businesses/${businessId}/equipment`));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId]);

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
      });
      setForm({ name: "", category: "", code: "", daily_rate: "", deposit: "0" });
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось добавить оборудование");
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Списать/удалить эту позицию?")) return;
    await api.delete(`/businesses/${businessId}/equipment/${id}`);
    await load();
  }

  if (loading) return <div className="muted">Загрузка…</div>;

  return (
    <div>
      <div className="tab-toolbar">
        <h2>Оборудование</h2>
        <button onClick={() => setShowForm((v) => !v)}>{showForm ? "Отмена" : "+ Добавить"}</button>
      </div>

      {showForm && (
        <form className="card form-grid" onSubmit={handleCreate}>
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
            <input required type="number" min="0" value={form.daily_rate} onChange={(e) => setForm({ ...form, daily_rate: e.target.value })} />
          </label>
          <label>
            Залог, ₽
            <input type="number" min="0" value={form.deposit} onChange={(e) => setForm({ ...form, deposit: e.target.value })} />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button type="submit">Сохранить</button>
        </form>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th>Название</th>
            <th>Категория</th>
            <th>Код</th>
            <th>Ставка/день</th>
            <th>Статус</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id}>
              <td>{it.name}</td>
              <td>{it.category}</td>
              <td>{it.code ?? "—"}</td>
              <td className="mono">{it.daily_rate} ₽</td>
              <td>
                <span className={`badge badge-${it.status}`}>{STATUS_LABEL[it.status]}</span>
              </td>
              <td>
                <button className="link danger" onClick={() => handleDelete(it.id)}>
                  Удалить
                </button>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                Пока нет ни одной позиции оборудования.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
