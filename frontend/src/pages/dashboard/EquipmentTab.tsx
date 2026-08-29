import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import { useData } from "../../context/DataContext";
import type { Equipment, EquipmentCategory, EquipmentImportResult, Rental } from "../../api/types";
import { EQ_META, RENTAL_META, Badge, equipmentDisplayStatus, nextFreeDate, rentalDisplayStatus } from "../../lib/statusMeta";
import { money, fmtDate, isoAddDays, todayISO } from "../../lib/format";
import { IconClose } from "../../lib/icons";
import { useConfirm } from "../../components/ConfirmDialog";
import { parseCsv, csvRowsToObjects, toCsv } from "../../lib/csv";

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
  notes: string;
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
  notes: "",
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
    notes: e.notes ?? "",
  };
}

/** Форма для кнопки "Копировать" на слайдовере (см. EquipmentDetailPanel) —
 * то же, что formFromEquipment, но с очищенным инвентарным номером: копия
 * позиции с тем же № была бы источником путаницы (см. согласование с
 * пользователем в тринадцатом проходе — "Полностью согласен, делаем!" про
 * саму фичу дублирования). Название получает суффикс "(копия)", чтобы в
 * списке сразу было видно, что это новая, ещё не отредактированная позиция.
 */
function formFromEquipmentAsCopy(e: Equipment): EquipmentFormState {
  return { ...formFromEquipment(e), name: e.name + " (копия)", code: "" };
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
    notes: form.notes || null,
  };
}

/** Есть ли в форме заполненное значение хотя бы одного из трёх полей
 * ступенчатого тарифа — используется, чтобы при открытии формы на
 * редактирование секция сразу была раскрыта, если тариф уже настроен. */
function hasTieredValues(form: EquipmentFormState): boolean {
  return !!(form.period_days || form.period_price || form.period_price_after);
}

/** Модалка добавления/изменения оборудования — тот же идиом `<dialog>`
 * (ref + showModal()/close() в useEffect по `open`), что и DocModal в
 * ./documents.tsx, только с формой вместо предпросмотра документа. Поля и
 * подсказка ступенчатого тарифа — 1:1 из демо (tieredRateFieldsHtml), но
 * секция теперь сворачиваемая (14-й проход, пункт 3 обзора формы "Добавить"). */
function EquipmentFormModal({
  open,
  title,
  initial,
  error,
  isOwner,
  categories,
  existingCodes,
  allowAddAnother,
  resetSignal,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initial: EquipmentFormState;
  error: string | null;
  isOwner: boolean;
  categories: EquipmentCategory[];
  // Инвентарные номера уже существующих позиций (кроме редактируемой) — для
  // мягкого предупреждения о дубле, см. duplicateCode ниже.
  existingCodes: string[];
  // Кнопка "Сохранить и добавить ещё" имеет смысл только в режиме
  // добавления/копирования — при редактировании существующей позиции
  // "добавить ещё" нечего.
  allowAddAnother: boolean;
  // Счётчик от родителя: инкремент означает "форма только что успешно
  // отправлена с addAnother=true, сбрось поля, не закрывая модалку" — тот же
  // паттерн, что и createRentalSignal/highlightEmployee.signal в других
  // вкладках.
  resetSignal: number;
  onClose: () => void;
  onSubmit: (form: EquipmentFormState, addAnother: boolean) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<EquipmentFormState>(initial);
  const [showTiered, setShowTiered] = useState(hasTieredValues(initial));
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Сброс формы при открытии и при каждом "Сохранить и добавить ещё"
  // (resetSignal меняется) — родитель к этому моменту уже пересчитал
  // `initial` под новое пустое состояние (см. EquipmentTab.handleSubmitForm).
  // Native <dialog> остаётся смонтированным всё время (только showModal()/
  // close()), поэтому React не переинициализирует состояние сам по себе —
  // приходится это делать вручную.
  useEffect(() => {
    if (open) {
      setForm(initial);
      setShowTiered(hasTieredValues(initial));
      setLocalError(null);
      // Фокус на "Название" — autoFocus не подходит: он срабатывает только
      // при первом монтировании DOM-узла, а <dialog> здесь монтируется один
      // раз и просто переоткрывается. requestAnimationFrame — чтобы фокус
      // ставился уже после showModal() (иначе браузер может увести фокус на
      // сам <dialog>).
      const raf = requestAnimationFrame(() => nameInputRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resetSignal]);

  const trimmedCode = form.code.trim();
  const duplicateCode = trimmedCode !== "" && existingCodes.includes(trimmedCode);

  function validateLocally(): string | null {
    if (!form.name.trim()) return "Название не может состоять из одних пробелов";
    if (!form.category.trim()) return "Категория не может состоять из одних пробелов";
    return null;
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problem = validateLocally();
    if (problem) {
      setLocalError(problem);
      return;
    }
    setLocalError(null);
    // submitter отличает, какая из двух submit-кнопок нажата — оба варианта
    // ("Сохранить" и "Сохранить и добавить ещё") живут в одной <form>, чтобы
    // не дублировать всю разметку полей.
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const addAnother = submitter?.dataset.addAnother === "true";
    onSubmit(form, addAnother);
  }

  return (
    <dialog id="modal" className="wide" ref={ref} onClose={onClose}>
      <form onSubmit={handleSubmit}>
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
              ref={nameInputRef}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Например, перфоратор Bosch GBH 5-40"
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label>Категория</label>
              {isOwner ? (
                // Владелец может ввести и совсем новое название — оно
                // автоматически заведётся в справочнике при сохранении (см.
                // backend: app/api/routes/equipment.py:_ensure_category).
                // datalist даёт автодополнение по уже существующим, но не
                // запрещает свободный ввод — это и есть "владелец создаёт
                // категории".
                <>
                  <input
                    required
                    list="equipment-category-options"
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    placeholder="Инструмент, электроника… (или новая категория)"
                  />
                  <datalist id="equipment-category-options">
                    {categories.map((c) => (
                      <option key={c.id} value={c.name} />
                    ))}
                  </datalist>
                </>
              ) : (
                // Остальные роли — только выбор из уже существующего
                // справочника, свободный текст закрыт: он всё равно будет
                // отклонён backend'ом (400), выпадающий список честнее
                // показывает границы прав, чем текстовое поле, которое
                // потом откажется сохраняться.
                <select required value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                  <option value="" disabled>
                    Выберите категорию…
                  </option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
              {categories.length === 0 && !isOwner && (
                <div className="field-hint">Справочник категорий пуст — попросите владельца бизнеса добавить категории.</div>
              )}
            </div>
            <div className="field">
              <label>Инв. номер</label>
              <input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder="INV-000 (необязательно)"
              />
              {duplicateCode && (
                <div className="field-hint" style={{ color: "var(--warning-ink)" }}>
                  Такой инвентарный номер уже используется другой позицией — сохранить всё равно можно, но лучше
                  проверить, не опечатка ли это.
                </div>
              )}
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
          {showTiered ? (
            <>
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
                Заполните, если ставка снижается при длительной аренде: первые N дней — по первой цене, каждый
                следующий период из N дней — по второй. Например: 690 ₽ за первые 7 дней, затем 190 ₽ за каждые
                следующие 7 дней.{" "}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setShowTiered(false);
                    setForm({ ...form, period_days: "", period_price: "", period_price_after: "" });
                  }}
                >
                  Убрать ступенчатый тариф
                </button>
              </div>
            </>
          ) : (
            <div className="field-hint">
              <button type="button" className="link-btn" onClick={() => setShowTiered(true)}>
                + Добавить ступенчатый тариф
              </button>{" "}
              (необязательно — для скидки при длительной аренде)
            </div>
          )}
          <div className="field">
            <label>Заметка</label>
            <textarea
              rows={3}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Состояние, комплектация, особенности — что угодно, что стоит помнить про эту позицию"
            />
          </div>
          {(localError || error) && <div className="form-error">{localError || error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          {allowAddAnother && (
            <button type="submit" className="btn" data-add-another="true">
              Сохранить и добавить ещё
            </button>
          )}
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
  onCopy,
  onDeleted,
}: {
  businessId: string;
  equipmentId: string;
  onClose: () => void;
  onEdit: (id: string) => void;
  // Необязательный — кнопка "Копировать" показывается, только если её
  // реализовал вызывающий компонент. С дашборда слайдовер открывается в
  // сокращённом варианте (см. Dashboard.tsx: "Изменить" там просто уводит
  // на вкладку "Оборудование", а не открывает форму на месте) — дублировать
  // ту же логику предзаполнения формы там нет смысла, полноценная кнопка
  // нужна только во вкладке "Оборудование" (EquipmentTab), где и живёт
  // сама форма/модалка.
  onCopy?: (id: string) => void;
  onDeleted: () => void;
}) {
  const { equipment, clients, rentals, reloadEquipment } = useData();
  const item = equipment.find((e) => e.id === equipmentId);
  const [maintUntil, setMaintUntil] = useState(item?.maintenance_until ?? "");
  const { confirm, dialog: confirmDialog } = useConfirm();

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

  async function handleDelete() {
    if (equipmentHasOpenRentals(equipmentId, rentals)) {
      alert("Нельзя удалить: по этой позиции есть аренда в работе или бронь. Сначала завершите её.");
      return;
    }
    if (!(await confirm(`«${item!.name}» будет удалено безвозвратно.`, { danger: true }))) return;
    try {
      await api.delete(`/businesses/${businessId}/equipment/${equipmentId}`);
      onDeleted();
      await reloadEquipment();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Не удалось удалить");
    }
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
        {item.notes && (
          <div style={{ marginTop: "10px" }}>
            <div className="k" style={{ marginBottom: "4px" }}>
              Заметка
            </div>
            <div style={{ whiteSpace: "pre-wrap", fontSize: "13px" }}>{item.notes}</div>
          </div>
        )}
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
        {onCopy && (
          <button className="btn" onClick={() => onCopy(equipmentId)}>
            Копировать
          </button>
        )}
        <button className="btn btn-danger-ghost" onClick={() => void handleDelete()}>
          Удалить
        </button>
      </div>

      {confirmDialog}
    </div>
  );
}

/* ============================================================
   Массовый импорт оборудования из CSV — по запросу пользователя в
   тринадцатом проходе ("обязательно нужно реализовать в лучшем виде, как
   считаешь ты"): скачиваемый шаблон → выбор файла → клиентский
   предпросмотр/лёгкая валидация (не ждём сети, чтобы показать явные
   проблемы вроде пустого имени) → отправка файла целиком на backend
   (там — вторая, настоящая валидация построчно, см.
   app/api/routes/equipment.py:import_equipment) → отчёт по каждой строке.
   ============================================================ */
const IMPORT_TEMPLATE_HEADER = [
  "name",
  "category",
  "code",
  "daily_rate",
  "deposit",
  "period_days",
  "period_price",
  "period_price_after",
  "notes",
];

const IMPORT_TEMPLATE_EXAMPLE = [
  "Перфоратор Bosch GBH 5-40",
  "Инструмент",
  "INV-101",
  "500",
  "2000",
  "7",
  "2900",
  "350",
  "Комплект полный, состояние хорошее",
];

function downloadImportTemplate() {
  const csv = toCsv(IMPORT_TEMPLATE_HEADER, [IMPORT_TEMPLATE_EXAMPLE]);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }); // BOM — чтобы Excel сразу открыл в UTF-8, не спрашивая кодировку
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "equipment-import-template.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

interface ImportPreviewRow {
  row: number;
  name: string;
  category: string;
  daily_rate: string;
  problems: string[];
}

/** Лёгкая клиентская проверка — только то, что можно сказать без сети
 * (справочник категорий уже загружен в контексте, но окончательное решение
 * "существует ли категория" всё равно принимает backend, в том числе
 * потому что для владельца неизвестная категория — это не ошибка, а повод
 * завести её). Здесь ловим только совсем явный мусор — пустые обязательные
 * поля и нечисловую ставку — чтобы пользователь увидел проблему до
 * отправки файла, а не только из ответа сервера. */
function validatePreviewRow(obj: Record<string, string>): string[] {
  const problems: string[] = [];
  if (!obj.name) problems.push("нет названия");
  if (!obj.category) problems.push("нет категории");
  const rate = (obj.daily_rate || "").replace(",", ".");
  if (!rate) problems.push("нет ставки");
  else if (Number.isNaN(Number(rate))) problems.push("ставка не число");
  return problems;
}

function EquipmentImportModal({
  open,
  businessId,
  onClose,
  onImported,
}: {
  open: boolean;
  businessId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewRow[]>([]);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<EquipmentImportResult | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function reset() {
    setFile(null);
    setPreview([]);
    setHeaderError(null);
    setSubmitError(null);
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleFileChange(f: File | null) {
    setFile(f);
    setResult(null);
    setSubmitError(null);
    setPreview([]);
    setHeaderError(null);
    if (!f) return;
    const text = await f.text();
    const parsed = parseCsv(text);
    const header = parsed.header.map((h) => h.trim().toLowerCase());
    if (!header.includes("name") || !header.includes("category") || !header.includes("daily_rate")) {
      setHeaderError("В заголовке файла должны быть как минимум колонки: name, category, daily_rate");
      return;
    }
    const objects = csvRowsToObjects(parsed);
    setPreview(
      objects.map((obj, idx) => ({
        row: idx + 2, // строка 1 — заголовок
        name: obj.name || "",
        category: obj.category || "",
        daily_rate: obj.daily_rate || "",
        problems: validatePreviewRow(obj),
      }))
    );
  }

  async function handleImport() {
    if (!file) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await api.postForm<EquipmentImportResult>(`/businesses/${businessId}/equipment/import`, form);
      setResult(res);
      if (res.created > 0) onImported();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Не удалось загрузить файл");
    } finally {
      setSubmitting(false);
    }
  }

  const problemCount = preview.filter((r) => r.problems.length > 0).length;

  return (
    <dialog className="wide" ref={ref} onClose={handleClose}>
      <div className="modal-head">
        <h3>Массовый импорт оборудования из CSV</h3>
        <button type="button" className="icon-btn" onClick={handleClose}>
          <IconClose />
        </button>
      </div>
      <div className="modal-body">
        {!result && (
          <>
            <div className="field-hint" style={{ marginBottom: "10px" }}>
              Файл CSV с заголовком в первой строке. Обязательные колонки: <code>name</code>, <code>category</code>,{" "}
              <code>daily_rate</code>. Необязательные: <code>code</code>, <code>deposit</code>,{" "}
              <code>period_days</code>, <code>period_price</code>, <code>period_price_after</code>,{" "}
              <code>notes</code>. Категория должна либо уже быть в справочнике, либо — если импорт делает владелец
              бизнеса — заведётся автоматически.
            </div>
            <button type="button" className="btn btn-sm" onClick={downloadImportTemplate}>
              Скачать шаблон CSV
            </button>
            <div className="field" style={{ marginTop: "14px" }}>
              <label>Файл</label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => void handleFileChange(e.target.files?.[0] ?? null)}
              />
            </div>
            {headerError && <div className="form-error">{headerError}</div>}
            {preview.length > 0 && (
              <>
                <div className="field-hint" style={{ marginTop: "10px" }}>
                  Найдено строк: {preview.length}
                  {problemCount > 0 ? `, из них с явными проблемами: ${problemCount} (не пройдут импорт)` : ""}. Это
                  предварительная проверка на устройстве — окончательную проверку (включая справочник категорий)
                  выполнит сервер.
                </div>
                <div className="table-wrap" style={{ maxHeight: "260px", overflowY: "auto", marginTop: "8px" }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Строка</th>
                        <th>Название</th>
                        <th>Категория</th>
                        <th>Ставка</th>
                        <th>Проблемы</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((r) => (
                        <tr key={r.row}>
                          <td className="mono">{r.row}</td>
                          <td>{r.name || "—"}</td>
                          <td>{r.category || "—"}</td>
                          <td className="mono">{r.daily_rate || "—"}</td>
                          <td>{r.problems.length > 0 ? r.problems.join(", ") : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {submitError && <div className="form-error">{submitError}</div>}
          </>
        )}

        {result && (
          <>
            <div className="field-hint" style={{ marginBottom: "10px" }}>
              Готово: создано {result.created} из {result.total}
              {result.failed > 0 ? `, ошибок: ${result.failed}` : ""}.
            </div>
            <div className="table-wrap" style={{ maxHeight: "320px", overflowY: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Строка</th>
                    <th>Название</th>
                    <th>Результат</th>
                  </tr>
                </thead>
                <tbody>
                  {result.results.map((r) => (
                    <tr key={r.row}>
                      <td className="mono">{r.row}</td>
                      <td>{r.name}</td>
                      <td>
                        {r.ok ? (
                          <span style={{ color: "var(--good-ink)", fontWeight: 600 }}>Создано</span>
                        ) : (
                          <span style={{ color: "var(--critical-ink)" }}>{r.error}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      <div className="modal-foot">
        {result ? (
          <button type="button" className="btn btn-primary" onClick={handleClose}>
            Готово
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={handleClose}>
              Отмена
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!file || !!headerError || submitting}
              onClick={() => void handleImport()}
            >
              {submitting ? "Импортируем…" : "Импортировать"}
            </button>
          </>
        )}
      </div>
    </dialog>
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
  isOwner,
}: {
  businessId: string;
  search: string;
  filter: string;
  setFilter: (f: string) => void;
  isOwner: boolean;
}) {
  const { equipment, equipmentCategories, rentals, reloadEquipment, reloadEquipmentCategories } = useData();
  const [sort, setSort] = useState<EquipmentSort>({ key: null, dir: "asc" });
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [modalMode, setModalMode] = useState<"add" | "edit" | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [copySource, setCopySource] = useState<Equipment | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  // Инкрементируется при успешном "Сохранить и добавить ещё" — сигнал для
  // EquipmentFormModal сбросить внутреннее состояние формы, не закрывая
  // <dialog> (тот же паттерн, что и createRentalSignal в RentalsTab).
  const [formResetSignal, setFormResetSignal] = useState(0);

  const today = todayISO();
  const q = search.trim().toLowerCase();
  // Категорийный фильтр — независимый от поиска и статусного фильтра,
  // комбинируется с обоими (см. согласование с пользователем в тринадцатом
  // проходе: "Фильтр категорий обязательно нужен").
  const bySearchAndCategory = equipment.filter((e) => {
    const matchesCategory = categoryFilter === "all" || e.category === categoryFilter;
    const matchesSearch = !q || (e.name + " " + e.category + " " + (e.code ?? "")).toLowerCase().includes(q);
    return matchesCategory && matchesSearch;
  });
  // Счётчики на кнопках статуса считаются от уже применённых поиска и
  // категории, но НЕ от самого статусного фильтра — иначе, переключаясь
  // между статусами, пользователь видел бы на остальных кнопках всегда "0"
  // (см. согласование: "Счётчики - делаем").
  const statusCounts: Record<string, number> = { all: bySearchAndCategory.length };
  for (const f of FILTERS) {
    if (f.id === "all") continue;
    statusCounts[f.id] = bySearchAndCategory.filter((e) => equipmentDisplayStatus(e, rentals, today) === f.id).length;
  }
  const filtered = bySearchAndCategory.filter((e) => filter === "all" || equipmentDisplayStatus(e, rentals, today) === filter);
  const list = sortEquipmentList(filtered, sort, rentals, today);

  function toggleSort(key: string) {
    setSort((prev) => {
      if (prev.key === key) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
      return { key, dir: "asc" };
    });
  }

  function openAddModal() {
    setEditingId(null);
    setCopySource(null);
    setFormError(null);
    setModalMode("add");
  }

  function openEditModal(id: string) {
    setEditingId(id);
    setCopySource(null);
    setFormError(null);
    setModalMode("edit");
  }

  function openCopyModal(item: Equipment) {
    setEditingId(null);
    setCopySource(item);
    setFormError(null);
    setModalMode("add");
  }

  function closeFormModal() {
    setModalMode(null);
    setEditingId(null);
    setCopySource(null);
    setFormError(null);
  }

  async function handleSubmitForm(form: EquipmentFormState, addAnother: boolean) {
    setFormError(null);
    try {
      if (modalMode === "edit" && editingId) {
        await api.patch(`/businesses/${businessId}/equipment/${editingId}`, formToPayload(form));
      } else {
        await api.post(`/businesses/${businessId}/equipment`, formToPayload(form));
      }
      await Promise.all([reloadEquipment(), reloadEquipmentCategories()]);
      if (addAnother) {
        // Модалка остаётся открытой в режиме "add" с пустой формой — copySource
        // тоже сбрасывается, иначе следующее "добавить ещё" опять подставило бы
        // исходную позицию для копирования вместо чистого бланка.
        setCopySource(null);
        setFormResetSignal((n) => n + 1);
      } else {
        closeFormModal();
      }
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Не удалось сохранить оборудование");
    }
  }

  const editingItem = editingId ? equipment.find((e) => e.id === editingId) ?? null : null;
  const formTitle = modalMode === "edit" ? "Изменить оборудование" : copySource ? "Копия оборудования" : "Новое оборудование";
  const formInitial =
    modalMode === "edit" && editingItem
      ? formFromEquipment(editingItem)
      : copySource
      ? formFromEquipmentAsCopy(copySource)
      : EMPTY_FORM;

  const categoryNames = equipmentCategories.map((c) => c.name);
  // Для мягкого предупреждения о дубле инв. номера — код самой редактируемой
  // позиции исключается, иначе форма предупреждала бы о "дубле" при
  // сохранении без изменения номера.
  const existingCodes = equipment.filter((e) => e.id !== editingId && e.code).map((e) => e.code as string);

  return (
    <div>
      <div className="tab-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <div className="segmented">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={filter === f.id ? "active" : ""}
                onClick={() => setFilter(f.id)}
              >
                {f.label} ({statusCounts[f.id] ?? 0})
              </button>
            ))}
          </div>
          {categoryNames.length > 0 && (
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              style={{ maxWidth: "220px" }}
              title="Фильтр по категории"
            >
              <option value="all">Все категории</option>
              {categoryNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button className="btn" onClick={() => setImportOpen(true)}>
            Импорт CSV
          </button>
          <button className="btn btn-primary" onClick={openAddModal}>
            + Добавить
          </button>
        </div>
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
        isOwner={isOwner}
        categories={equipmentCategories}
        existingCodes={existingCodes}
        allowAddAnother={modalMode === "add"}
        resetSignal={formResetSignal}
        onClose={closeFormModal}
        onSubmit={(form, addAnother) => void handleSubmitForm(form, addAnother)}
      />

      <EquipmentImportModal
        open={importOpen}
        businessId={businessId}
        onClose={() => setImportOpen(false)}
        onImported={() => void Promise.all([reloadEquipment(), reloadEquipmentCategories()])}
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
          onCopy={(id) => {
            const item = equipment.find((e) => e.id === id);
            setOpenId(null);
            if (item) openCopyModal(item);
          }}
          onDeleted={() => setOpenId(null)}
        />
      )}
    </div>
  );
}
