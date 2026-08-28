import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../../api/client";
import { useData } from "../../context/DataContext";
import type { Client, Equipment, Rental, RentalItem } from "../../api/types";
import { money, fmtDate, dayDiff, todayISO, isoAddDays, spanDays } from "../../lib/format";
import { RENTAL_META, Badge, rentalDisplayStatus, type StatusMeta } from "../../lib/statusMeta";
import { IconPrinter, IconEdit, IconClose, IconAlert } from "../../lib/icons";
import { DocModal, buildContractDoc, buildIssueDoc, buildReturnDoc } from "./documents";
import { useConfirm } from "../../components/ConfirmDialog";

/**
 * Порт renderRentals()/addRentalForm()/editRentalForm()/issueRentalForm()/
 * returnRentalForm() из демо (claude/oborot-crm-prototype.html) на реальные
 * данные backend'а. Сознательно НЕ перенесено — зависит от demo-only
 * концепций, которых нет в продовой модели данных:
 *  - бейдж "Продлевалась N раз" (r.extensions[]) — у Rental в проде нет
 *    истории продлений, только текущие start_date/end_date;
 *  - фильтр по менеджеру (ui.rentalOwnerFilter) и поле "Ответственный" в
 *    форме создания — держатся на ownerId/team (список сотрудников демо),
 *    в проде аренда привязывается к сотруднику через created_by_employee_id
 *    на backend'е автоматически, выбора нет.
 * Это задокументированный, неизбежный разрыв с демо, а не недосмотр.
 *
 * Переключатель "Только рискованные" (ui.rentalRiskOnly в демо) — В ОТЛИЧИЕ
 * от фильтра по менеджеру, он держится не на ownerId, а на client.rating
 * ("на контроле"/"чёрный список"), которое в проде есть — по ошибке был
 * ранее записан в один список с фильтром по менеджеру и не перенесён.
 * Исправлено при третьей сверке с демо — реализован ниже (riskOnly).
 */

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

// Тексты по умолчанию для textarea выдачи/возврата — 1:1 с демо
// (issueRentalForm/returnRentalForm) и с DEFAULT_ISSUE_NOTES/DEFAULT_RETURN_NOTES
// на backend'е (app/api/routes/rentals.py) — если поле не тронуто, отправляем
// именно этот текст явно (backend и сам подставит его при пустом значении,
// но так пользователь видит тот же дефолт, что и в форме демо).
const DEFAULT_ISSUE_NOTES = "Комплектация полная, состояние исправное.";
const DEFAULT_RETURN_NOTES = "Без повреждений, комплектация полная.";

/* ============================================================
   Доступность оборудования на произвольный диапазон дат — порт
   isEquipmentFree/nextFreeDate демо (addRentalForm/editRentalForm).
   lib/statusMeta.tsx уже экспортирует nextFreeDate, но та версия отвечает на
   другой вопрос — "когда освобождается ТЕКУЩАЯ активная аренда этой позиции"
   (для колонки "своб. с" на вкладке Оборудование). Здесь нужно проверить
   пересечение ЛЮБОГО booked/active бронирования с произвольным [start, end],
   который ещё не сохранён (черновик формы) — другая задача, поэтому портируется
   отдельно, а не переиспользуется.
   ============================================================ */
function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

function isEquipmentFreeForRange(
  equipmentId: string,
  start: string,
  end: string,
  rentals: Rental[],
  excludeRentalId?: string
): boolean {
  if (!start || !end) return true;
  return !rentals.some((r) => {
    if (r.id === excludeRentalId) return false;
    if (r.status !== "booked" && r.status !== "active") return false;
    if (!r.items.some((it) => it.equipment_id === equipmentId)) return false;
    return rangesOverlap(r.start_date, r.end_date, start, end);
  });
}

function conflictEndFor(
  equipmentId: string,
  start: string,
  end: string,
  rentals: Rental[],
  excludeRentalId?: string
): string | null {
  const blocking = rentals
    .filter((r) => {
      if (r.id === excludeRentalId) return false;
      if (r.status !== "booked" && r.status !== "active") return false;
      if (!r.items.some((it) => it.equipment_id === equipmentId)) return false;
      return rangesOverlap(r.start_date, r.end_date, start, end);
    })
    .sort((a, b) => (a.end_date < b.end_date ? 1 : -1));
  return blocking.length ? blocking[0].end_date : null;
}

function isUnderMaintenanceOn(eq: Equipment, dateIso: string): boolean {
  if (eq.status !== "maintenance") return false;
  if (!eq.maintenance_until) return true;
  return dateIso <= eq.maintenance_until;
}

function rateLabel(
  dailyRate: number,
  periodDays: number | null,
  periodPrice: number | null,
  periodPriceAfter: number | null
): string {
  if (periodDays && periodPrice) {
    return `${money(periodPrice)}/${periodDays}дн` + (periodPriceAfter ? ` → ${money(periodPriceAfter)}/${periodDays}дн` : "");
  }
  return `${money(dailyRate)}/сутки`;
}

function equipmentRateLabel(e: Equipment): string {
  return rateLabel(e.daily_rate, e.period_days, e.period_price, e.period_price_after);
}

function itemRateLabel(it: RentalItem): string {
  return rateLabel(it.daily_rate_snapshot, it.period_days_snapshot, it.period_price_snapshot, it.period_price_after_snapshot);
}

/* ============================================================
   Предпросмотр финансов при возврате — порт itemCostForDays/rentalFinanceCalc
   демо, той же формулой, что и app/services/pricing.py (item_cost_for_days/
   compute_rental_breakdown): пока форма открыта, актуальная дата возврата и
   доплата за повреждения ещё не сохранены, поэтому пересчитываем локально
   для live-превью в .summary-box. На самой отправке формы источник истины —
   backend (POST /return пересчитывает то же самое на своих данных).
   ============================================================ */
function itemCostForDays(it: RentalItem, days: number): number {
  if (days <= 0) return 0;
  const dailyRate = it.daily_rate_snapshot;
  const periodDays = it.period_days_snapshot;
  const periodPrice = it.period_price_snapshot;
  const periodPriceAfter = it.period_price_after_snapshot;
  if (!periodDays || !periodPrice) return dailyRate * days;
  if (days <= periodDays) return dailyRate * days;
  const extraDays = days - periodDays;
  const perDayAfter = (periodPriceAfter || 0) / periodDays;
  return periodPrice + extraDays * perDayAfter;
}

function itemsCostForDays(items: RentalItem[], days: number): number {
  return items.reduce((s, it) => s + itemCostForDays(it, days), 0);
}

interface FinancePreview {
  plannedDays: number;
  lateDays: number;
  base: number;
  lateFee: number;
  damage: number;
  discount: number;
  total: number;
}

function previewReturnFinance(r: Rental, actualReturn: string, damageFee: number): FinancePreview {
  const plannedDays = spanDays(r.start_date, r.end_date);
  const endForCalc = actualReturn || (dayDiff(r.end_date) < 0 ? todayISO() : r.end_date);
  const actualDays = spanDays(r.start_date, endForCalc);
  const lateDays = Math.max(0, actualDays - plannedDays);
  const base = Math.round(itemsCostForDays(r.items, plannedDays));
  const actualCost = Math.round(itemsCostForDays(r.items, actualDays));
  const lateFee = Math.max(0, actualCost - base);
  const discount = r.discount || 0;
  const total = Math.max(0, base + lateFee + damageFee - discount);
  return { plannedDays, lateDays, base, lateFee, damage: damageFee, discount, total };
}

function FinanceSummary({ fin, depositTotal }: { fin: FinancePreview; depositTotal: number }) {
  return (
    <div className="summary-box">
      <div className="summary-row">
        <span>Аренда, {fin.plannedDays} дн.</span>
        <span className="v">{money(fin.base)}</span>
      </div>
      {fin.lateFee > 0 && (
        <div className="summary-row critical">
          <span>Просрочка, {fin.lateDays} дн.</span>
          <span className="v">{money(fin.lateFee)}</span>
        </div>
      )}
      {fin.damage > 0 && (
        <div className="summary-row critical">
          <span>Компенсация повреждений</span>
          <span className="v">{money(fin.damage)}</span>
        </div>
      )}
      {fin.discount > 0 && (
        <div className="summary-row">
          <span>Скидка</span>
          <span className="v">−{money(fin.discount)}</span>
        </div>
      )}
      <div className="summary-row total">
        <span>Итого к оплате</span>
        <span className="v">{money(fin.total)}</span>
      </div>
      <div className="summary-row">
        <span>Депозит на удержании</span>
        <span className="v">{money(depositTotal)}</span>
      </div>
    </div>
  );
}

/* ============================================================
   Каркас модалки формы — тот же idiom, что DocModal в documents.tsx
   (dialog id="modal" + ref + useEffect showModal()/close() по пропу open),
   только с <form> внутри и футером Отмена/Сохранить вместо Закрыть/Печать.
   id="modal" здесь обязателен — стили (dialog#modal / dialog#modal.wide и
   всё остальное modal-* в styles.css) заданы ID-селектором, а не классом.
   ============================================================ */
function FormModal({
  title,
  open,
  onClose,
  onSubmit,
  submitLabel = "Сохранить",
  wide,
  error,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  submitLabel?: string;
  wide?: boolean;
  error?: string | null;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog id="modal" className={wide ? "wide" : undefined} ref={ref} onClose={onClose}>
      <form onSubmit={onSubmit}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} type="button">
            <IconClose />
          </button>
        </div>
        <div className="modal-body">
          {children}
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose} type="button">
            Отмена
          </button>
          <button className="btn btn-primary" type="submit">
            {submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** Мультивыбор оборудования с проверкой занятости на диапазон [start, end] —
 * порт общей разметки .eq-picklist/.eq-pick-row демо, используется и в
 * создании, и в правке аренды. */
function EquipmentPicklist({
  items,
  start,
  end,
  rentals,
  excludeRentalId,
  checkedIds,
  onToggle,
  alwaysShowIds,
}: {
  items: Equipment[];
  start: string;
  end: string;
  rentals: Rental[];
  excludeRentalId?: string;
  checkedIds: string[];
  onToggle: (id: string) => void;
  alwaysShowIds?: string[];
}) {
  const visible = items.filter(
    (e) => (alwaysShowIds?.includes(e.id) ?? false) || (e.status !== "retired" && !isUnderMaintenanceOn(e, start))
  );

  return (
    <div className="eq-picklist">
      {visible.map((e) => {
        const free = isEquipmentFreeForRange(e.id, start, end, rentals, excludeRentalId);
        const conflictEnd = free ? null : conflictEndFor(e.id, start, end, rentals, excludeRentalId);
        const checked = checkedIds.includes(e.id);
        return (
          <label key={e.id} className={`eq-pick-row${free ? "" : " disabled"}`}>
            <input type="checkbox" checked={checked} disabled={!free} onChange={() => onToggle(e.id)} />
            <span className="eq-pick-name">{e.name}</span>
            <span className="eq-pick-rate">{equipmentRateLabel(e)}</span>
            {!free && conflictEnd && <span className="eq-pick-conflict">занято до {fmtDate(conflictEnd)}</span>}
          </label>
        );
      })}
    </div>
  );
}

/* ---------- Новая аренда ---------- */
function CreateRentalModal({
  businessId,
  clients,
  equipment,
  rentals,
  onClose,
  onCreated,
}: {
  businessId: string;
  clients: Client[];
  equipment: Equipment[];
  rentals: Rental[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [clientId, setClientId] = useState("");
  const [startDate, setStartDate] = useState(todayISO());
  const [endDate, setEndDate] = useState(isoAddDays(todayISO(), 2));
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function toggle(id: string) {
    setCheckedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!clientId) {
      setError("Выберите клиента");
      return;
    }
    if (checkedIds.length === 0) {
      setError("Выберите хотя бы одно оборудование");
      return;
    }
    if (endDate < startDate) {
      setError("Дата окончания раньше начала");
      return;
    }
    setSaving(true);
    try {
      await api.post(`/businesses/${businessId}/rentals`, {
        client_id: clientId,
        equipment_ids: checkedIds,
        start_date: startDate,
        end_date: endDate,
        // Скидку при создании аренды сознательно не отправляем: RentalCreate
        // (backend/app/schemas/inventory.py) принимает только client_id/
        // equipment_ids/start_date/end_date — поля discount там нет, в
        // отличие от demo's addRentalForm. Задать скидку можно сразу после
        // создания через "Изменить" (PATCH .../rentals/{id}, RentalEdit.discount).
      });
      await onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось создать аренду");
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormModal
      title="Новая аренда"
      open
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel={saving ? "Сохранение…" : "Оформить"}
      wide
      error={error}
    >
      <div className="field">
        <label>Клиент</label>
        <select required value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="" disabled>
            Выберите клиента
          </option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.phone ? ` · ${c.phone}` : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="field-row">
        <div className="field">
          <label>Начало</label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div className="field">
          <label>Окончание</label>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>Оборудование</label>
        <EquipmentPicklist
          items={equipment}
          start={startDate}
          end={endDate}
          rentals={rentals}
          checkedIds={checkedIds}
          onToggle={toggle}
        />
        <div className="field-hint">Занятые на выбранные даты позиции недоступны для выбора.</div>
      </div>
    </FormModal>
  );
}

/* ---------- Изменить аренду (доступно для "Забронировано" и "В аренде") ---------- */
function EditRentalModal({
  businessId,
  rental,
  client,
  equipment,
  rentals,
  onClose,
  onSaved,
}: {
  businessId: string;
  rental: Rental;
  client: Client | undefined;
  equipment: Equipment[];
  rentals: Rental[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const isActive = rental.status === "active";
  const currentIds = rental.items.map((it) => it.equipment_id);
  const [startDate, setStartDate] = useState(rental.start_date);
  const [endDate, setEndDate] = useState(rental.end_date);
  const [checkedIds, setCheckedIds] = useState<string[]>(currentIds);
  const [discount, setDiscount] = useState(rental.discount ? String(rental.discount) : "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function toggle(id: string) {
    setCheckedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (checkedIds.length === 0) {
      setError("Выберите хотя бы одно оборудование");
      return;
    }
    if (endDate < startDate) {
      setError("Дата окончания раньше начала");
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/businesses/${businessId}/rentals/${rental.id}`, {
        // Поле отключено и не меняется для уже выданных ("active") аренд —
        // backend всё равно игнорирует start_date, когда status=active, так
        // что отправка текущего (неизменного) значения безвредна.
        start_date: startDate,
        end_date: endDate,
        equipment_ids: checkedIds,
        discount: Number(discount) || 0,
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось изменить аренду");
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormModal
      title={`Изменить аренду — ${client?.name ?? "—"}`}
      open
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel={saving ? "Сохранение…" : "Сохранить"}
      wide
      error={error}
    >
      <div className="field">
        <label>Клиент</label>
        <div style={{ padding: "9px 11px", background: "var(--surface-2)", borderRadius: 8, fontSize: 13.5, fontWeight: 600 }}>
          {client?.name ?? "—"}
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label>Начало</label>
          <input
            type="date"
            value={startDate}
            disabled={isActive}
            title={isActive ? "Оборудование уже выдано — дата выдачи зафиксирована" : undefined}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Окончание</label>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
      </div>
      {isActive && (
        <div className="field-hint" style={{ marginTop: -8 }}>
          Дата начала зафиксирована: оборудование уже выдано клиенту.
        </div>
      )}
      <div className="field">
        <label>Оборудование</label>
        <EquipmentPicklist
          items={equipment}
          start={startDate}
          end={endDate}
          rentals={rentals}
          excludeRentalId={rental.id}
          checkedIds={checkedIds}
          onToggle={toggle}
          alwaysShowIds={currentIds}
        />
        <div className="field-hint">Занятые на выбранные даты позиции недоступны для выбора.</div>
      </div>
      <div className="field">
        <label>Скидка, ₽ (по договорённости)</label>
        <input type="number" min={0} value={discount} placeholder="0" onChange={(e) => setDiscount(e.target.value)} />
      </div>
    </FormModal>
  );
}

/* ---------- Выдать оборудование ---------- */
function IssueRentalModal({
  businessId,
  rental,
  client,
  equipment,
  onClose,
  onIssued,
}: {
  businessId: string;
  rental: Rental;
  client: Client | undefined;
  equipment: Equipment[];
  onClose: () => void;
  onIssued: (updated: Rental) => Promise<void>;
}) {
  const [notes, setNotes] = useState(DEFAULT_ISSUE_NOTES);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const updated = await api.post<Rental>(`/businesses/${businessId}/rentals/${rental.id}/issue`, {
        issue_notes: notes,
      });
      await onIssued(updated);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось выдать аренду");
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormModal
      title={`Выдать оборудование — ${client?.name ?? "—"}`}
      open
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel={saving ? "Сохранение…" : "Выдать"}
      error={error}
    >
      <div className="summary-box">
        {rental.items.map((it) => {
          const eq = equipment.find((e) => e.id === it.equipment_id);
          return (
            <div className="mini-item" key={it.equipment_id}>
              <span>{eq?.name ?? "—"}</span>
              <span className="mono">{itemRateLabel(it)}</span>
            </div>
          );
        })}
      </div>
      <div className="field">
        <label>Состояние на момент выдачи</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Комплектация полная, повреждений нет…" />
      </div>
      <div className="field-hint">После выдачи автоматически сформируется акт приёма-передачи.</div>
    </FormModal>
  );
}

/* ---------- Принять возврат ---------- */
function ReturnRentalModal({
  businessId,
  rental,
  client,
  onClose,
  onReturned,
}: {
  businessId: string;
  rental: Rental;
  client: Client | undefined;
  onClose: () => void;
  onReturned: (updated: Rental) => Promise<void>;
}) {
  const [actualReturn, setActualReturn] = useState(todayISO());
  const [notes, setNotes] = useState(DEFAULT_RETURN_NOTES);
  const [damageFee, setDamageFee] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fin = previewReturnFinance(rental, actualReturn || todayISO(), Number(damageFee) || 0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const updated = await api.post<Rental>(`/businesses/${businessId}/rentals/${rental.id}/return`, {
        actual_return: actualReturn || todayISO(),
        return_notes: notes,
        damage_fee: Number(damageFee) || 0,
        // Скидка не редактируется в этой форме (как и в демо — она задаётся при
        // создании/правке аренды, не при возврате), но передать текущее
        // rental.discount явно обязательно: RentalReturn.discount по умолчанию
        // 0 на backend'е, и без явной передачи уже установленная скидка молча
        // сбросилась бы в 0 при приёме возврата.
        discount: rental.discount,
      });
      await onReturned(updated);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось принять возврат");
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormModal
      title={`Принять возврат — ${client?.name ?? "—"}`}
      open
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel={saving ? "Сохранение…" : "Принять возврат"}
      error={error}
    >
      <div className="field">
        <label>Фактическая дата возврата</label>
        <input type="date" value={actualReturn} onChange={(e) => setActualReturn(e.target.value)} />
      </div>
      <div className="field">
        <label>Состояние при возврате</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Без повреждений…" />
      </div>
      <div className="field">
        <label>Доплата за повреждения, ₽ (если есть)</label>
        <input type="number" min={0} value={damageFee} onChange={(e) => setDamageFee(e.target.value)} />
      </div>
      <FinanceSummary fin={fin} depositTotal={rental.deposit_total} />
    </FormModal>
  );
}

export function RentalsTab({
  businessId,
  search,
  filter,
  setFilter,
  openCreateSignal,
}: {
  businessId: string;
  search: string;
  filter: string;
  setFilter: (f: string) => void;
  // Инкрементируемый счётчик из шапки (Dashboard.tsx) — кнопка "Новая
  // аренда" в топбаре теперь открывает форму СРАЗУ, а не просто переходит на
  // вкладку с фильтром, как раньше (см. UX-обзор, п.2). Счётчик, а не
  // boolean — чтобы повторное нажатие без смены вида тоже срабатывало.
  openCreateSignal?: number;
}) {
  const { equipment, clients, rentals, reloadRentals, reloadEquipment } = useData();
  const [sort, setSort] = useState("date");
  const [riskOnly, setRiskOnly] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [editRental, setEditRental] = useState<Rental | null>(null);
  const [issueRental, setIssueRental] = useState<Rental | null>(null);
  const [returnRental, setReturnRental] = useState<Rental | null>(null);
  const [docModal, setDocModal] = useState<{ title: string; node: ReactNode } | null>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();

  useEffect(() => {
    if (openCreateSignal) setShowCreate(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCreateSignal]);

  const list = rentals.filter((r) => {
    const st = rentalDisplayStatus(r);
    const statusOk = filter === "all" ? true : filter === "active" ? st === "active" || st === "overdue" : st === filter;
    if (!statusOk) return false;

    const client = clients.find((c) => c.id === r.client_id);
    const names = r.items.map((it) => equipment.find((e) => e.id === it.equipment_id)?.name ?? "").join(" ");
    if (search && !((client?.name ?? "") + " " + names).toLowerCase().includes(search.toLowerCase())) return false;

    if (riskOnly && (!client || client.rating === "normal")) return false;

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

  async function handleCancel(r: Rental) {
    if (!(await confirm("Отменить эту аренду?", { danger: true, confirmLabel: "Отменить аренду" }))) return;
    try {
      await api.post(`/businesses/${businessId}/rentals/${r.id}/cancel`);
      await Promise.all([reloadRentals(), reloadEquipment()]);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Не удалось отменить аренду");
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
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={"btn btn-sm" + (riskOnly ? " btn-primary" : "")}
            title="Показать только клиентов «на контроле» или из чёрного списка"
            onClick={() => setRiskOnly((v) => !v)}
          >
            <IconAlert /> Только рискованные
          </button>
          <button className="btn btn-primary" type="button" onClick={() => setShowCreate(true)}>
            + Новая аренда
          </button>
        </div>
      </div>

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
                  <button className="btn btn-primary btn-sm" type="button" onClick={() => setIssueRental(r)}>
                    Выдать
                  </button>
                  <button className="btn btn-sm" type="button" onClick={() => setEditRental(r)}>
                    <IconEdit /> Изменить
                  </button>
                  <button className="btn btn-danger-ghost btn-sm" type="button" onClick={() => handleCancel(r)}>
                    Отменить
                  </button>
                </>
              )}
              {r.status === "active" && (
                <>
                  <button className="btn btn-primary btn-sm" type="button" onClick={() => setReturnRental(r)}>
                    Принять возврат
                  </button>
                  <button className="btn btn-sm" type="button" onClick={() => setEditRental(r)}>
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

      {sorted.length === 0 && (
        <div className="panel">
          <div className="panel-body">
            <div className="empty-note">
              Ничего не найдено{search ? ` по запросу «${search}»` : " в этом фильтре"}.
            </div>
          </div>
        </div>
      )}

      {showCreate && (
        <CreateRentalModal
          businessId={businessId}
          clients={clients}
          equipment={equipment}
          rentals={rentals}
          onClose={() => setShowCreate(false)}
          onCreated={async () => {
            await Promise.all([reloadRentals(), reloadEquipment()]);
          }}
        />
      )}

      {editRental && (
        <EditRentalModal
          businessId={businessId}
          rental={editRental}
          client={clients.find((c) => c.id === editRental.client_id)}
          equipment={equipment}
          rentals={rentals}
          onClose={() => setEditRental(null)}
          onSaved={async () => {
            await Promise.all([reloadRentals(), reloadEquipment()]);
          }}
        />
      )}

      {issueRental && (
        <IssueRentalModal
          businessId={businessId}
          rental={issueRental}
          client={clients.find((c) => c.id === issueRental.client_id)}
          equipment={equipment}
          onClose={() => setIssueRental(null)}
          onIssued={async (updated) => {
            await Promise.all([reloadRentals(), reloadEquipment()]);
            const c = clients.find((cl) => cl.id === updated.client_id);
            openDoc("Акт приёма-передачи", buildIssueDoc(updated, c, equipment));
          }}
        />
      )}

      {returnRental && (
        <ReturnRentalModal
          businessId={businessId}
          rental={returnRental}
          client={clients.find((c) => c.id === returnRental.client_id)}
          onClose={() => setReturnRental(null)}
          onReturned={async (updated) => {
            await Promise.all([reloadRentals(), reloadEquipment()]);
            const c = clients.find((cl) => cl.id === updated.client_id);
            openDoc("Акт возврата", buildReturnDoc(updated, c, equipment));
          }}
        />
      )}

      <DocModal title={docModal?.title ?? ""} open={!!docModal} onClose={() => setDocModal(null)}>
        {docModal?.node}
      </DocModal>

      {confirmDialog}
    </div>
  );
}
