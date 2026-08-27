import { useState } from "react";
import { api, ApiError } from "../../api/client";
import { useData } from "../../context/DataContext";
import type { Client } from "../../api/types";
import { RATING_META, RENTAL_META, Badge, rentalDisplayStatus } from "../../lib/statusMeta";
import { money, fmtDate } from "../../lib/format";
import { IconClose } from "../../lib/icons";

interface ClientForm {
  name: string;
  phone: string;
  email: string;
  doc: string;
}

const EMPTY_FORM: ClientForm = { name: "", phone: "", email: "", doc: "" };

export function ClientsTab({ businessId, search }: { businessId: string; search: string }) {
  const { clients, rentals, reloadClients } = useData();
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ClientForm>(EMPTY_FORM);
  const [openClientId, setOpenClientId] = useState<string | null>(null);

  const q = search.trim().toLowerCase();
  const list = clients.filter(
    (c) => !q || (c.name + " " + (c.phone ?? "") + " " + (c.email ?? "")).toLowerCase().includes(q)
  );

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/businesses/${businessId}/clients`, {
        name: form.name,
        phone: form.phone || null,
        email: form.email || null,
        doc: form.doc || null,
      });
      setForm(EMPTY_FORM);
      setShowForm(false);
      await reloadClients();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось добавить клиента");
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Удалить этого клиента?")) return;
    try {
      await api.delete(`/businesses/${businessId}/clients/${id}`);
      if (openClientId === id) setOpenClientId(null);
      await reloadClients();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Не удалось удалить");
    }
  }

  return (
    <div>
      <div className="tab-toolbar">
        <h2>Клиенты</h2>
        <button className="btn" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Отмена" : "+ Добавить"}
        </button>
      </div>

      {showForm && (
        <form className="form-grid" onSubmit={handleCreate}>
          <label>
            Имя / название
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            Телефон
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </label>
          <label>
            Email
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label>
            Документ (паспорт)
            <input value={form.doc} onChange={(e) => setForm({ ...form, doc: e.target.value })} />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button type="submit" className="btn btn-primary">
            Сохранить
          </button>
        </form>
      )}

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
                <th>Имя</th>
                <th>Документ</th>
                <th>Рейтинг</th>
                <th>Аренды</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((c) => {
                const clientRentals = rentals.filter((r) => r.client_id === c.id);
                const activeCount = clientRentals.filter((r) => {
                  const s = rentalDisplayStatus(r);
                  return s === "active" || s === "overdue";
                }).length;
                return (
                  <tr key={c.id} onClick={() => setOpenClientId(c.id)} style={{ cursor: "pointer" }}>
                    <td>
                      <div className="cell-name">{c.name}</div>
                      <div className="cell-sub">{c.phone ?? "—"}</div>
                    </td>
                    <td>{c.doc ?? "—"}</td>
                    <td>
                      <Badge meta={RATING_META[c.rating]} />
                    </td>
                    <td>
                      {clientRentals.length} всего{activeCount > 0 ? `, ${activeCount} сейчас` : ""}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button className="btn btn-sm btn-danger-ghost" onClick={() => handleDelete(c.id)}>
                        Удалить
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {openClientId && <div className="slideover-backdrop" onClick={() => setOpenClientId(null)} />}
      {openClientId && (
        <ClientDetailPanel
          businessId={businessId}
          clientId={openClientId}
          onClose={() => setOpenClientId(null)}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}

function ClientDetailPanel({
  businessId,
  clientId,
  onClose,
  onDelete,
}: {
  businessId: string;
  clientId: string;
  onClose: () => void;
  onDelete: (id: string) => void;
}) {
  const { clients, rentals, equipment, reloadClients } = useData();
  const client = clients.find((c) => c.id === clientId);

  if (!client) return null;

  const history = rentals
    .filter((r) => r.client_id === clientId)
    .slice()
    .sort((a, b) => (a.start_date < b.start_date ? 1 : -1));

  const lifetimeRevenue = history.filter((r) => r.status === "returned").reduce((s, r) => s + r.total, 0);
  const lateReturns = history.filter((r) => r.status === "returned" && r.actual_return && r.actual_return > r.end_date).length;
  const currentlyOverdue = history.filter((r) => rentalDisplayStatus(r) === "overdue").length;
  const totalLate = lateReturns + currentlyOverdue;
  const depositHeld = history
    .filter((r) => {
      const s = rentalDisplayStatus(r);
      return s === "active" || s === "overdue";
    })
    .reduce((s, r) => s + r.deposit_total, 0);

  async function setRating(rating: Client["rating"]) {
    await api.patch(`/businesses/${businessId}/clients/${clientId}`, { rating });
    await reloadClients();
  }

  return (
    <div className="slideover">
      <div className="slideover-head">
        <div>
          <h3>{client.name}</h3>
          <div style={{ color: "var(--muted)", fontSize: "12.5px", marginTop: "2px" }}>{client.phone ?? "—"}</div>
        </div>
        <button className="icon-btn" onClick={onClose}>
          <IconClose />
        </button>
      </div>

      <div className="slideover-section">
        <h4>Надёжность</h4>
        <div style={{ marginBottom: "10px" }}>
          <Badge meta={RATING_META[client.rating]} />
        </div>
        <div className="rating-picker">
          <button
            className={"btn btn-sm" + (client.rating === "normal" ? " btn-primary" : "")}
            onClick={() => void setRating("normal")}
          >
            Надёжный
          </button>
          <button
            className={"btn btn-sm" + (client.rating === "watch" ? " btn-primary" : "")}
            onClick={() => void setRating("watch")}
          >
            На контроле
          </button>
          <button
            className={"btn btn-sm" + (client.rating === "blacklist" ? " btn-primary" : "")}
            onClick={() => void setRating("blacklist")}
          >
            Чёрный список
          </button>
        </div>
      </div>

      <div className="slideover-section">
        <h4>Показатели</h4>
        <div className="kv-grid">
          <span className="k">Выручка за всё время</span>
          <span className="mono">{money(lifetimeRevenue)}</span>
          <span className="k">Просрочек за всё время</span>
          <span className={"mono" + (totalLate > 0 ? " text-critical" : "")}>{totalLate}</span>
          <span className="k">Депозит на удержании сейчас</span>
          <span className="mono">{money(depositHeld)}</span>
        </div>
      </div>

      <div className="slideover-section">
        <h4>Контакты</h4>
        <div className="kv-grid">
          <span className="k">Email</span>
          <span>{client.email ?? "—"}</span>
          <span className="k">Документ</span>
          <span>{client.doc ?? "—"}</span>
          <span className="k">В базе с</span>
          <span>{fmtDate(client.created_at.slice(0, 10))}</span>
        </div>
      </div>

      {client.notes && (
        <div className="slideover-section">
          <h4>Заметки</h4>
          <div style={{ fontSize: "13.5px" }}>{client.notes}</div>
        </div>
      )}

      <div className="slideover-section">
        <h4>История аренд · {history.length}</h4>
        {history.length === 0 ? (
          <div className="empty-note">Ещё не сдавалось в аренду</div>
        ) : (
          history.map((r) => (
            <div className="mini-item" key={r.id}>
              <span>
                {r.items.map((it) => equipment.find((eq) => eq.id === it.equipment_id)?.name ?? "—").join(", ")} ·{" "}
                {fmtDate(r.start_date)}—{fmtDate(r.end_date)}
              </span>
              <Badge meta={RENTAL_META[rentalDisplayStatus(r)]} />
            </div>
          ))
        )}
      </div>

      <div className="slideover-section">
        <button
          className="btn btn-danger-ghost"
          onClick={() => {
            onDelete(clientId);
          }}
        >
          Удалить
        </button>
      </div>
    </div>
  );
}
