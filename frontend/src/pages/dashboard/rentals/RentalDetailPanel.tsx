/**
 * RentalDetailPanel (слайд-панель с деталями аренды) — новое в 39-м проходе,
 * по итогам обзора вкладки "Аренды": у Клиентов и Оборудования есть детальная
 * карточка с разбивкой, у Аренд её не было вообще — сама карточка в списке
 * (.rental-card) показывает только самое основное (клиент, позиции одной
 * строкой, суммарно даты и итог), а куда именно ушла сумма (плановые дни vs
 * просрочка vs повреждения vs скидка), какая ставка у каждой позиции
 * отдельно и что записано в заметках при выдаче/возврате — узнать было
 * нельзя, не листая печатные акты.
 *
 * Открывается кликом по самой карточке (см. RentalsTab.tsx: класс
 * .rental-card.clickable + onClick на карточке, кнопки действий внутри
 * останавливают всплытие). Панель умеет открывать связанные карточки —
 * клиента (onOpenClient) и позиции оборудования (onOpenEquipment, добавлено
 * в 40-м проходе) — тем же кросс-вкладочным механизмом dashClientId/
 * dashEquipmentId, что уже используют DashboardTab и ClientsTab.
 *
 * 41-й проход, по итогам обзора ("какие доработки ещё реализовать?") —
 * панель обзавелась собственными действиями:
 *  - "Продлить" — быстрое продление по одной дате, без открытия полной формы
 *    правки аренды. Само действие делегировано наверх (onExtend), а не
 *    выполняется прямо здесь — модалка и её PATCH-запрос по-прежнему живут в
 *    RentalsTab.tsx рядом с Изменить/Выдать/Принять возврат (тот же принцип,
 *    что описан выше для "полностью read-only": не плодить два места с одной
 *    и той же логикой правки аренды).
 *  - "Написать клиенту" (WhatsApp/почта) — чистый client-side экшн (wa.me/
 *    mailto:), без обращения к backend, поэтому реализован прямо здесь —
 *    1-в-1 переиспользует buildRentalSummaryText из clients/summary.ts (та
 *    же функция, что уже используют кнопки "Отправить сводку" в
 *    ClientDetailPanel).
 *  - "Повторить аренду" — тоже делегируется наверх (onRepeat): открывает
 *    CreateRentalModal (он живёт в RentalsTab.tsx) с предзаполненным
 *    клиентом и позициями текущей аренды.
 *  - Частичный возврат по позициям и фотофиксация состояния — НОВЫЕ
 *    возможности, которых на карточке в списке никогда не было (там нечего
 *    было бы дублировать), поэтому реализованы прямо в панели, с
 *    собственными запросами к backend (POST .../return-items, GET/POST/
 *    DELETE .../photos через RentalPhotosSection).
 */
import { useEffect, useRef, useState } from "react";
import type { Rental } from "../../../api/types";
import { useData } from "../../../context/DataContext";
import { RENTAL_META, Badge, rentalDisplayStatus } from "../../../lib/statusMeta";
import { money, fmtDate, todayISO } from "../../../lib/format";
import { IconClose, IconUser, IconEdit, IconRepeat } from "../../../lib/icons";
import { itemRateLabel } from "./helpers";
import { api, ApiError } from "../../../api/client";
import { normalizePhoneDigits } from "../clients/helpers";
import { buildRentalSummaryText } from "../clients/summary";
import { MoreActionsMenu } from "../../../components/MoreActionsMenu";
import { RentalPhotosSection } from "./RentalPhotosSection";

/* ---------- Частичный возврат выбранных позиций ---------- */
function ReturnItemsModal({
  businessId,
  rental,
  equipmentIds,
  equipmentNames,
  onClose,
  onReturned,
}: {
  businessId: string;
  rental: Rental;
  equipmentIds: string[];
  equipmentNames: string;
  onClose: () => void;
  onReturned: () => Promise<void>;
}) {
  const [actualReturn, setActualReturn] = useState(todayISO());
  const [notes, setNotes] = useState("");
  const [damageFee, setDamageFee] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // ref + showModal() — тот же idiom, что и у FormModal/DocModal (RentalsTab.tsx/
  // documents.tsx): нативный <dialog> с атрибутом open="true" в JSX открылся бы
  // как НЕ-модальный (без ::backdrop и без UA-центрирования position:fixed) —
  // это разные вещи в спецификации, и без showModal() модалка выглядела бы
  // сломанной (не по центру экрана, без затемнения фона).
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.post(`/businesses/${businessId}/rentals/${rental.id}/return-items`, {
        equipment_ids: equipmentIds,
        actual_return: actualReturn || todayISO(),
        return_notes: notes.trim() || undefined,
        damage_fee: Number(damageFee) || 0,
      });
      await onReturned();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось оформить возврат позиций");
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      id="modal"
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form onSubmit={handleSubmit}>
        <div className="modal-head">
          <h3>Частичный возврат</h3>
          <button className="icon-btn" onClick={onClose} type="button">
            <IconClose />
          </button>
        </div>
        <div className="modal-body">
          <div className="field-hint" style={{ marginBottom: "10px" }}>
            Возвращаются позиции: {equipmentNames}. Остальное оборудование остаётся у клиента, аренда продолжается.
          </div>
          <div className="field">
            <label>Фактическая дата возврата</label>
            <input type="date" value={actualReturn} onChange={(e) => setActualReturn(e.target.value)} />
          </div>
          <div className="field">
            <label>Состояние при возврате (необязательно)</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Без повреждений…" />
          </div>
          <div className="field">
            <label>Доплата за повреждения этих позиций, ₽ (если есть)</label>
            <input type="number" min={0} value={damageFee} onChange={(e) => setDamageFee(e.target.value)} />
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose} type="button">
            Отмена
          </button>
          <button className="btn btn-primary" type="submit">
            {saving ? "Сохранение…" : "Оформить возврат"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function RentalDetailPanel({
  businessId,
  rentalId,
  onClose,
  onOpenClient,
  onOpenEquipment,
  onExtend,
  onRepeat,
}: {
  businessId: string;
  rentalId: string;
  onClose: () => void;
  onOpenClient: (clientId: string) => void;
  onOpenEquipment: (equipmentId: string) => void;
  // Открыть модалку быстрого продления (живёт в RentalsTab.tsx — см.
  // докстринг файла выше про "полностью read-only" в части правки аренды).
  onExtend: (rentalId: string) => void;
  // Открыть "Новую аренду", предзаполненную клиентом и позициями текущей
  // аренды (CreateRentalModal тоже живёт в RentalsTab.tsx).
  onRepeat: (clientId: string, equipmentIds: string[]) => void;
}) {
  const { equipment, clients, rentals, reloadRentals, reloadEquipment } = useData();
  const rental: Rental | undefined = rentals.find((r) => r.id === rentalId);
  const [selectedReturnIds, setSelectedReturnIds] = useState<string[]>([]);
  const [returnModalOpen, setReturnModalOpen] = useState(false);

  if (!rental) return null;

  const client = clients.find((c) => c.id === rental.client_id);
  const st = rentalDisplayStatus(rental);
  // Частичный возврат имеет смысл только пока аренда в работе (в т.ч.
  // просроченная — статус в БД у неё по-прежнему "active", см.
  // rentalDisplayStatus) — у забронированной ещё нечего возвращать, у уже
  // возвращённой/отменённой всё уже закрыто.
  const canPartialReturn = st === "active" || st === "overdue";

  function toggleReturnSelect(equipmentId: string) {
    setSelectedReturnIds((prev) => (prev.includes(equipmentId) ? prev.filter((id) => id !== equipmentId) : [...prev, equipmentId]));
  }

  const selectedNames = rental.items
    .filter((it) => selectedReturnIds.includes(it.equipment_id))
    .map((it) => equipment.find((e) => e.id === it.equipment_id)?.name ?? "—")
    .join(", ");

  return (
    <div className="slideover">
      <div className="slideover-head">
        <div>
          <h3>{client?.name ?? "Клиент удалён"}</h3>
          <div style={{ color: "var(--muted)", fontSize: "12.5px", marginTop: "2px" }}>
            {fmtDate(rental.start_date)} — {fmtDate(rental.end_date)}
            {rental.actual_return ? ` · возврат ${fmtDate(rental.actual_return)}` : ""}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose}>
          <IconClose />
        </button>
      </div>

      <div className="slideover-section" style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
        <Badge meta={RENTAL_META[st]} />
        {client && (
          <button className="btn btn-sm" onClick={() => onOpenClient(client.id)}>
            <IconUser /> Карточка клиента
          </button>
        )}
        {(st === "active" || st === "overdue") && (
          <button className="btn btn-sm" type="button" onClick={() => onExtend(rental.id)}>
            <IconEdit /> Продлить
          </button>
        )}
        <button
          className="btn btn-sm"
          type="button"
          onClick={() => onRepeat(rental.client_id, rental.items.map((it) => it.equipment_id))}
        >
          <IconRepeat /> Повторить аренду
        </button>
        {client && (client.phone || client.email) && (
          <MoreActionsMenu
            label="Написать клиенту"
            actions={[
              ...(client.phone
                ? [
                    {
                      key: "wa",
                      label: "Сводка в WhatsApp",
                      onClick: () =>
                        window.open(
                          `https://wa.me/${normalizePhoneDigits(client.phone)}?text=${encodeURIComponent(
                            buildRentalSummaryText(rental, client, equipment)
                          )}`,
                          "_blank",
                          "noreferrer"
                        ),
                    },
                  ]
                : []),
              ...(client.email
                ? [
                    {
                      key: "email",
                      label: "Сводка на почту",
                      onClick: () => {
                        window.location.href = `mailto:${client.email}?subject=${encodeURIComponent(
                          "Информация по аренде"
                        )}&body=${encodeURIComponent(buildRentalSummaryText(rental, client, equipment))}`;
                      },
                    },
                  ]
                : []),
            ]}
          />
        )}
      </div>

      <div className="slideover-section">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
          <h4 style={{ marginBottom: 0 }}>Оборудование</h4>
          {canPartialReturn && selectedReturnIds.length > 0 && (
            <button className="btn btn-primary btn-sm" type="button" onClick={() => setReturnModalOpen(true)}>
              Вернуть выбранное ({selectedReturnIds.length})
            </button>
          )}
        </div>
        {canPartialReturn && (
          <div className="field-hint" style={{ marginBottom: "8px" }}>
            Отметьте позиции, которые клиент вернул раньше остальных — остальное продолжит числиться в аренде.
          </div>
        )}
        {rental.items.map((it) => {
          const eq = equipment.find((e) => e.id === it.equipment_id);
          const returned = !!it.returned_at;
          return (
            <div
              className={"mini-item" + (eq ? " clickable" : "")}
              key={it.equipment_id}
              onClick={eq ? () => onOpenEquipment(eq.id) : undefined}
              title={eq ? "Открыть карточку оборудования" : undefined}
            >
              <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                {canPartialReturn && !returned && (
                  <input
                    type="checkbox"
                    checked={selectedReturnIds.includes(it.equipment_id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleReturnSelect(it.equipment_id)}
                    style={{ width: "16px", height: "16px" }}
                  />
                )}
                <span>{eq?.name ?? "—"}</span>
                {returned && (
                  <span style={{ fontSize: "11px", color: "var(--muted)" }}>
                    · возвращено {fmtDate(it.returned_at as string)}
                  </span>
                )}
              </span>
              <span className="mono">{itemRateLabel(it)}</span>
            </div>
          );
        })}
      </div>

      <div className="slideover-section">
        <h4>Финансы</h4>
        <div className="kv-grid">
          <span className="k">Плановых дней</span>
          <span className="mono">{rental.planned_days}</span>
          <span className="k">Фактических дней</span>
          <span className="mono">{rental.actual_return ? rental.actual_days : "—"}</span>
          <span className="k">Аренда</span>
          <span className="mono">{money(rental.base)}</span>
          {rental.late_fee > 0 && (
            <>
              <span className="k">Просрочка, {rental.late_days} дн.</span>
              <span className="mono">{money(rental.late_fee)}</span>
            </>
          )}
          {rental.damage_fee > 0 && (
            <>
              <span className="k">Повреждения</span>
              <span className="mono">{money(rental.damage_fee)}</span>
            </>
          )}
          {rental.discount > 0 && (
            <>
              <span className="k">Скидка</span>
              <span className="mono">−{money(rental.discount)}</span>
            </>
          )}
          <span className="k">Итого</span>
          <span className="mono" style={{ fontWeight: 700 }}>
            {money(rental.total)}
          </span>
          <span className="k">Депозит на удержании</span>
          <span className="mono">{money(rental.deposit_total)}</span>
        </div>
      </div>

      {(rental.issue_notes || rental.return_notes) && (
        <div className="slideover-section">
          <h4>Заметки</h4>
          {rental.issue_notes && (
            <div style={{ marginBottom: rental.return_notes ? "10px" : 0 }}>
              <div className="k" style={{ marginBottom: "4px" }}>
                При выдаче
              </div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: "13px" }}>{rental.issue_notes}</div>
            </div>
          )}
          {rental.return_notes && (
            <div>
              <div className="k" style={{ marginBottom: "4px" }}>
                При возврате
              </div>
              <div style={{ whiteSpace: "pre-wrap", fontSize: "13px" }}>{rental.return_notes}</div>
            </div>
          )}
        </div>
      )}

      <RentalPhotosSection businessId={businessId} rentalId={rental.id} />

      {returnModalOpen && (
        <ReturnItemsModal
          businessId={businessId}
          rental={rental}
          equipmentIds={selectedReturnIds}
          equipmentNames={selectedNames}
          onClose={() => setReturnModalOpen(false)}
          onReturned={async () => {
            await Promise.all([reloadRentals(), reloadEquipment()]);
            setSelectedReturnIds([]);
          }}
        />
      )}
    </div>
  );
}
