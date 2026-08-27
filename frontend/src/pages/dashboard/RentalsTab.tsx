import { useState, type ReactNode } from "react";
import { api, ApiError } from "../../api/client";
import { useData } from "../../context/DataContext";
import type { Rental } from "../../api/types";
import { money, fmtDate, dayDiff } from "../../lib/format";
import { RENTAL_META, Badge, rentalDisplayStatus, type StatusMeta } from "../../lib/statusMeta";
import { IconPrinter, IconEdit } from "../../lib/icons";
import { DocModal, buildContractDoc, buildIssueDoc, buildReturnDoc } from "./documents";

const FILTERS: { id: string; label: string }[] = [
  { id: "active", label: "В работе" },
  { id: "booked", label: "Забронировано" },
  { id: "overdue", label: "Просрочено" },
  { id: "returned", label: "Возвращено" },
  { id: "cancelled", label: "Отменено" },
  { id: "all", label: "Все" },
];

const SORTS: { id: string; label: string }[] = [
  { id: "date", label: "Сначала новые" },
  { id: "amount", label: "По сумме" },
  { id: "client", label: "По клиенту" },
];

export function RentalsTab({
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
  const { equipment, clients, rentals, reloadRentals, reloadEquipment } = useData();
  const [sort, setSort] = useState("date");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ client_id: "", equipment_id: "", start_date: "", end_date: "" });
  const [error, setError] = useState<string | null>(null);
  const [docModal, setDocModal] = useState<{ title: string; node: ReactNode } | null>(null);

  const availableEquipment = equipment.filter((e) => e.status === "available");

  const list = rentals.filter((r) => {
    const st = rentalDisplayStatus(r);
    const statusOk = filter === "all" ? true : filter === "active" ? st === "active" || st === "overdue" : st === filter;
    if (!statusOk) return false;

    const client = clients.find((c) => c.id === r.client_id);
    const names = r.items.map((it) => equipment.find((e) => e.id === it.equipment_id)?.name ?? "").join(" ");
    if (search && !((client?.name ?? "") + " " + names).toLowerCase().includes(search.toLowerCase())) return false;

    return true;
  });

  const sorted = [...list].sort((a, b) => {
    if (sort === "amount") return b.total - a.total;
    if (sort === "client") {
      const ca = clients.find((c) => c.id === a.client_id)?.name ?? "";
      const cb = clients.find((c) => c.id === b.client_id)?.name ?? "";
      return ca.localeCompare(cb, "ru");
    }
    return b.start_date.localeCompare(a.start_date);
  });

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
      await Promise.all([reloadRentals(), reloadEquipment()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось создать аренду");
    }
  }

  async function handleIssue(r: Rental) {
    try {
      const updated = await api.post<Rental>(`/businesses/${businessId}/rentals/${r.id}/issue`);
      await Promise.all([reloadRentals(), reloadEquipment()]);
      const client = clients.find((c) => c.id === updated.client_id);
      setDocModal({ title: "Акт приёма-передачи", node: buildIssueDoc(updated, client, equipment) });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Не удалось выдать аренду");
    }
  }

  async function handleCancel(r: Rental) {
    if (!confirm("Отменить эту аренду?")) return;
    try {
      await api.post(`/businesses/${businessId}/rentals/${r.id}/cancel`);
      await Promise.all([reloadRentals(), reloadEquipment()]);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Не удалось отменить аренду");
    }
  }

  async function handleReturn(r: Rental) {
    const damageFeeStr = prompt("Сумма компенсации за повреждения (если нет — оставьте 0):", "0");
    if (damageFeeStr === null) return;
    const discountStr = prompt("Скидка, ₽ (если нет — оставьте 0):", "0");
    if (discountStr === null) return;
    try {
      const updated = await api.post<Rental>(`/businesses/${businessId}/rentals/${r.id}/return`, {
        damage_fee: Number(damageFeeStr || 0),
        discount: Number(discountStr || 0),
      });
      await Promise.all([reloadRentals(), reloadEquipment()]);
      const client = clients.find((c) => c.id === updated.client_id);
      setDocModal({ title: "Акт возврата", node: buildReturnDoc(updated, client, equipment) });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Не удалось принять возврат");
    }
  }

  function openDoc(title: string, node: ReactNode) {
    setDocModal({ title, node });
  }

  return (
    <div>
      <div className="tab-toolbar">
        <div className="segmented">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className={filter === f.id ? "active" : ""} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
          <button className="btn btn-primary" type="button" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Отмена" : "+ Новая аренда"}
          </button>
        </div>
      </div>

      {showForm && (
        <form className="form-grid" onSubmit={handleCreate}>
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
          <button type="submit" className="btn btn-primary">Оформить</button>
        </form>
      )}

      {sorted.map((r) => {
        const client = clients.find((c) => c.id === r.client_id);
        const st = rentalDisplayStatus(r);
        const daysLeft = dayDiff(r.end_date);
        const soonBadge: StatusMeta | null =
          st === "active" && daysLeft <= 2
            ? { label: daysLeft <= 0 ? "Истекает сегодня" : `Осталось ${daysLeft} дн.`, tone: "warning" }
            : null;
        const itemNames = r.items.map((it) => equipment.find((e) => e.id === it.equipment_id)?.name ?? "—").join(", ");

        return (
          // TODO: демо делает всю карточку кликабельной → открывает деталку клиента.
          // Требует общего механизма "открыть клиента" между вкладками (пока
          // ClientDetailPanel живёт только внутри ClientsTab) — не подключено в
          // этом проходе. Класс "clickable" и обработчик клика на карточке
          // сознательно не добавлены.
          <div className="rental-card" key={r.id}>
            <div className="rental-main">
              <div className="rental-top">
                <span className="rental-client">{client?.name ?? "Клиент удалён"}</span>
                <Badge meta={RENTAL_META[st]} />
                {soonBadge && <Badge meta={soonBadge} />}
              </div>
              <div className="rental-items">{itemNames}</div>
              <div className="rental-meta">
                <span>
                  {fmtDate(r.start_date)} — {fmtDate(r.end_date)}
                  {r.actual_return ? " · возврат " + fmtDate(r.actual_return) : ""}
                </span>
                <span className="amount-mono mono">{money(r.total)}</span>
              </div>
            </div>

            {/* Клик по кнопкам не должен всплывать до карточки — в демо это было
                бесплатно за счёт делегирования через closest() на уровне всего
                документа (обработчик разбирал event.target независимо от того,
                где именно во вложенной разметке произошёл клик). В React у
                карточки сейчас нет собственного onClick (см. TODO выше), но
                stopPropagation оставлен здесь заранее — как только клик по
                карточке будет подключён, кнопки внутри .rental-actions не
                должны его триггерить. */}
            <div className="rental-actions" onClick={(e) => e.stopPropagation()}>
              {r.status === "booked" && (
                <>
                  <button className="btn btn-primary btn-sm" type="button" onClick={() => handleIssue(r)}>
                    Выдать
                  </button>
                  <button
                    className="btn btn-sm"
                    type="button"
                    disabled
                    title="Пока не реализовано — редактирование дат аренды после создания появится позже"
                  >
                    <IconEdit /> Изменить
                  </button>
                  <button className="btn-danger-ghost btn-sm" type="button" onClick={() => handleCancel(r)}>
                    Отменить
                  </button>
                </>
              )}
              {r.status === "active" && (
                <>
                  <button className="btn btn-primary btn-sm" type="button" onClick={() => handleReturn(r)}>
                    Принять возврат
                  </button>
                  <button
                    className="btn btn-sm"
                    type="button"
                    disabled
                    title="Пока не реализовано — редактирование дат аренды после создания появится позже"
                  >
                    <IconEdit /> Изменить
                  </button>
                  <button
                    className="btn btn-sm"
                    type="button"
                    onClick={() => openDoc("Акт приёма-передачи", buildIssueDoc(r, client, equipment))}
                  >
                    <IconPrinter /> Акт выдачи
                  </button>
                </>
              )}
              {r.status === "returned" && (
                <button
                  className="btn btn-sm"
                  type="button"
                  onClick={() => openDoc("Акт возврата", buildReturnDoc(r, client, equipment))}
                >
                  <IconPrinter /> Акт возврата
                </button>
              )}
              <button
                className="btn btn-sm"
                type="button"
                onClick={() => openDoc("Договор аренды", buildContractDoc(r, client, equipment))}
              >
                <IconPrinter /> Договор
              </button>
            </div>
          </div>
        );
      })}

      {sorted.length === 0 && <div className="empty-note">Аренд по заданным условиям не найдено.</div>}

      <DocModal title={docModal?.title ?? ""} open={!!docModal} onClose={() => setDocModal(null)}>
        {docModal?.node}
      </DocModal>
    </div>
  );
}
