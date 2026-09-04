/**
 * EquipmentDetailPanel (слайд-панель с деталями оборудования) — вынесено из
 * EquipmentTab.tsx в отдельный модуль (двадцать второй проход, "разнести по
 * отдельным файлам"). Единственный внешний потребитель — Dashboard.tsx,
 * который импортирует его через ре-экспорт из EquipmentTab.tsx (см. конец
 * того файла), поэтому Dashboard.tsx не пришлось менять.
 */
import { useEffect, useState } from "react";
import { api, ApiError } from "../../../api/client";
import { useData } from "../../../context/DataContext";
import type { Equipment, Rental } from "../../../api/types";
import { EQ_META, RENTAL_META, Badge, equipmentDisplayStatus, rentalDisplayStatus } from "../../../lib/statusMeta";
import { money, fmtDate, isoAddDays, todayISO } from "../../../lib/format";
import { IconClose } from "../../../lib/icons";
import { useConfirm } from "../../../components/ConfirmDialog";
import { useToast } from "../../../components/Toast";
import { rateLabel, equipmentHasOpenRentals } from "./helpers";
import { DatePicker } from "../../../components/DatePicker";

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
  const { notify } = useToast();

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
  // частичным телом ({status: ...} / {maintenance_until: ...}), как в демо. Бэкенд
  // валидирует тело как EquipmentUpdate (все поля необязательны, exclude_unset) —
  // партиальные запросы применяются как есть, без необходимости слать остальные поля.
  async function setStatus(next: Equipment["status"]) {
    try {
      await api.patch(`/businesses/${businessId}/equipment/${equipmentId}`, { status: next });
      await reloadEquipment();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось изменить статус");
    }
  }

  async function handleMaintUntilChange(value: string) {
    setMaintUntil(value);
    try {
      await api.patch(`/businesses/${businessId}/equipment/${equipmentId}`, { maintenance_until: value || null });
      await reloadEquipment();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось изменить дату");
    }
  }

  async function handleDelete() {
    if (equipmentHasOpenRentals(equipmentId, rentals)) {
      notify("Нельзя удалить: по этой позиции есть аренда в работе или бронь. Сначала завершите её.");
      return;
    }
    // 29-й проход, п.14 обзора: удаление теперь мягкое — позиция уходит в
    // корзину (см. EquipmentTrashModal в EquipmentTab.tsx) и восстановима 30
    // дней, а не пропадает безвозвратно, как раньше.
    if (
      !(await confirm(`«${item!.name}» будет перемещено в корзину. Восстановить можно в течение 30 дней.`, {
        danger: true,
        confirmLabel: "В корзину",
      }))
    )
      return;
    try {
      await api.delete(`/businesses/${businessId}/equipment/${equipmentId}`);
      onDeleted();
      await reloadEquipment();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось удалить");
    }
  }

  return (
    <div className="slideover">
      <div className="slideover-head">
        <div>
          <h3>{item.name}</h3>
          <div style={{ color: "var(--muted)", fontSize: "12.5px", marginTop: "2px" }}>
            № {item.code ?? "—"} · {item.category} ·{" "}
            {item.warehouse ? item.warehouse : <span style={{ opacity: 0.6 }}>склад не указан</span>}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose}>
          <IconClose />
        </button>
      </div>

      {/* Кнопки действий перенесены сразу под шапку (29-й проход, п.13
          обзора — та же правка, что и у ClientDetailPanel в ClientsTab.tsx:
          "Изменить"/"Удалить" не должны требовать скролла всей карточки). */}
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
            <DatePicker value={maintUntil} onChange={(v) => void handleMaintUntilChange(v)} />
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

      {confirmDialog}
    </div>
  );
}
