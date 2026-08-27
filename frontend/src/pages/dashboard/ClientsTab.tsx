import { useEffect, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { Client } from "../../api/types";

const RATING_LABEL: Record<Client["rating"], string> = {
  normal: "Обычный",
  watch: "На контроле",
  blacklist: "Чёрный список",
};

export function ClientsTab({ businessId }: { businessId: string }) {
  const [items, setItems] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "" });

  async function load() {
    setLoading(true);
    try {
      setItems(await api.get<Client[]>(`/businesses/${businessId}/clients`));
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
      await api.post(`/businesses/${businessId}/clients`, { name: form.name, phone: form.phone || null });
      setForm({ name: "", phone: "" });
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось добавить клиента");
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Удалить этого клиента?")) return;
    try {
      await api.delete(`/businesses/${businessId}/clients/${id}`);
      await load();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Не удалось удалить");
    }
  }

  if (loading) return <div className="muted">Загрузка…</div>;

  return (
    <div>
      <div className="tab-toolbar">
        <h2>Клиенты</h2>
        <button onClick={() => setShowForm((v) => !v)}>{showForm ? "Отмена" : "+ Добавить"}</button>
      </div>

      {showForm && (
        <form className="card form-grid" onSubmit={handleCreate}>
          <label>
            Имя / название
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            Телефон
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button type="submit">Сохранить</button>
        </form>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th>Имя</th>
            <th>Телефон</th>
            <th>Рейтинг</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>{c.phone ?? "—"}</td>
              <td>
                <span className={`badge badge-${c.rating}`}>{RATING_LABEL[c.rating]}</span>
              </td>
              <td>
                <button className="link danger" onClick={() => handleDelete(c.id)}>
                  Удалить
                </button>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                Клиентов пока нет.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
