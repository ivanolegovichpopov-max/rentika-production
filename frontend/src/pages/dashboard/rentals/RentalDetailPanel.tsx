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
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Rental } from "../../../api/types";
import { useData } from "../../../context/DataContext";
import { RENTAL_META, Badge, rentalDisplayStatus } from "../../../lib/statusMeta";
import { money, fmtDate, todayISO } from "../../../lib/format";
import { IconClose, IconUser, IconEdit, IconRepeat, IconCalendar } from "../../../lib/icons";
import { itemRateLabel, itemRateLabelTitle } from "./helpers";
import { api, ApiError } from "../../../api/client";
import { normalizePhoneDigits } from "../clients/helpers";
import { buildRentalSummaryText } from "../clients/summary";
import { MoreActionsMenu } from "../../../components/MoreActionsMenu";
import { RentalPhotosSection } from "./RentalPhotosSection";
import { RentalHistorySection } from "./RentalHistorySection";
import { DocModal, buildPartialReturnDoc } from "../documents";

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
  // Сообщает наверх параметры ИМЕННО этого возврата (не финальное состояние
  // аренды после reload) — родитель строит по ним акт частичного возврата
  // (42-й проход, п.4 обзора), см. buildPartialReturnDoc в documents.tsx.
  onReturned: (info: { equipmentIds: string[]; damageFee: number; returnDate: string }) => Promise<void>;
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
      const returnDate = actualReturn || todayISO();
      const fee = Number(damageFee) || 0;
      await api.post(`/businesses/${businessId}/rentals/${rental.id}/return-items`, {
        equipment_ids: equipmentIds,
        actual_return: returnDate,
        return_notes: notes.trim() || undefined,
        damage_fee: fee,
      });
      // Закрываем это модальное окно ПЕРЕД тем, как родитель откроет акт —
      // оба используют один и тот же native <dialog id="modal">, и открытыми
      // одновременно им быть не должно (см. общий idiom DocModal/FormModal).
      onClose();
      await onReturned({ equipmentIds, damageFee: fee, returnDate });
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

/* ---------- Запись платежа по аренде (46-й проход) ---------- */
function PaymentModal({
  businessId,
  rental,
  onClose,
  onPaid,
}: {
  businessId: string;
  rental: Rental;
  onClose: () => void;
  onPaid: () => Promise<void>;
}) {
  // Подсказываем остаток как значение по умолчанию — самый частый случай
  // (доплата до полной суммы), но поле остаётся редактируемым: платёж может
  // быть частичным, а отрицательное значение — исправлением ошибки.
  const remaining = Math.max(0, rental.total - rental.paid_amount);
  const [amount, setAmount] = useState(remaining > 0 ? String(remaining) : "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const value = Number(amount);
    if (!value) {
      setError("Введите сумму платежа");
      return;
    }
    setSaving(true);
    try {
      await api.post(`/businesses/${businessId}/rentals/${rental.id}/payment`, { amount: value });
      onClose();
      await onPaid();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось записать платёж");
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
          <h3>Записать платёж</h3>
          <button className="icon-btn" onClick={onClose} type="button">
            <IconClose />
          </button>
        </div>
        <div className="modal-body">
          <div className="field-hint" style={{ marginBottom: "10px" }}>
            Уже оплачено {money(rental.paid_amount)} из {money(rental.total)}
            {remaining > 0 ? ` · остаток ${money(remaining)}` : ""}.
          </div>
          <div className="field">
            <label>Сумма платежа, ₽</label>
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          </div>
          <div className="field-hint">Отрицательное значение — исправление ошибочно внесённой суммы.</div>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose} type="button">
            Отмена
          </button>
          <button className="btn btn-primary" type="submit">
            {saving ? "Сохранение…" : "Записать"}
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
  onOpenCalendar,
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
  // Перейти на вкладку "Календарь" с фокусом на дату начала этой аренды
  // (42-й проход, п.5 обзора) — переключение View живёт в Dashboard.tsx,
  // здесь просто передаём дату наверх.
  onOpenCalendar: (date: string) => void;
}) {
  const { equipment, clients, rentals, reloadRentals, reloadEquipment } = useData();
  const rental: Rental | undefined = rentals.find((r) => r.id === rentalId);
  const [depositSaving, setDepositSaving] = useState(false);
  const [depositError, setDepositError] = useState<string | null>(null);

  // Возврат депозита клиенту (42-й проход) — отдельный факт от закрытия
  // самой аренды, переключается в любую сторону (см. докстринг
  // Rental.deposit_returned_at в api/types.ts). Дату не спрашиваем отдельным
  // полем — POST .../deposit-return без returned_at сам подставляет
  // "сегодня" (см. app/api/routes/rentals.py:set_deposit_returned), этого
  // достаточно для галочки "вернули/не вернули".
  async function toggleDepositReturned() {
    if (!rental) return;
    setDepositSaving(true);
    setDepositError(null);
    try {
      await api.post(`/businesses/${businessId}/rentals/${rental.id}/deposit-return`, {
        returned: !rental.deposit_returned_at,
      });
      await reloadRentals();
    } catch (err) {
      setDepositError(err instanceof ApiError ? err.message : "Не удалось изменить отметку о депозите");
    } finally {
      setDepositSaving(false);
    }
  }
  const [selectedReturnIds, setSelectedReturnIds] = useState<string[]>([]);
  const [returnModalOpen, setReturnModalOpen] = useState(false);
  // Акт частичного возврата (42-й проход, п.4 обзора) — открывается сразу
  // после успешного оформления, тот же принцип автопоказа, что и у
  // openDoc("Акт возврата", ...) после полного возврата в RentalsTab.tsx.
  const [returnDoc, setReturnDoc] = useState<ReactNode | null>(null);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);

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
        <button className="btn btn-sm" type="button" onClick={() => onOpenCalendar(rental.start_date)}>
          <IconCalendar /> В календаре
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
              <span className="mono" title={itemRateLabelTitle(it)}>
                {itemRateLabel(it)}
              </span>
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
          <span className="k">Оплачено</span>
          <span className="mono" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "10px" }}>
            {money(rental.paid_amount)}
            <button className="btn btn-sm" type="button" onClick={() => setPaymentModalOpen(true)}>
              Записать платёж
            </button>
          </span>
          {rental.paid_amount < rental.total && (
            <>
              <span className="k">Остаток к оплате</span>
              <span className="mono" style={{ fontWeight: 600 }}>
                {money(rental.total - rental.paid_amount)}
              </span>
            </>
          )}
          <span className="k">Депозит на удержании</span>
          <span className="mono" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "10px" }}>
            {money(rental.deposit_total)}
            {rental.deposit_total > 0 && (
              <label
                style={{ display: "flex", alignItems: "center", gap: "5px", fontWeight: 400, fontSize: "11.5px", color: "var(--muted)", cursor: depositSaving ? "wait" : "pointer" }}
              >
                <input
                  type="checkbox"
                  checked={!!rental.deposit_returned_at}
                  disabled={depositSaving}
                  onChange={toggleDepositReturned}
                  style={{ width: "14px", height: "14px" }}
                />
                {rental.deposit_returned_at ? `возвращён ${fmtDate(rental.deposit_returned_at)}` : "возвращён клиенту"}
              </label>
            )}
          </span>
        </div>
        {depositError && <div className="form-error">{depositError}</div>}
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

      <RentalHistorySection businessId={businessId} rentalId={rental.id} />

      {returnModalOpen && (
        <ReturnItemsModal
          businessId={businessId}
          rental={rental}
          equipmentIds={selectedReturnIds}
          equipmentNames={selectedNames}
          onClose={() => setReturnModalOpen(false)}
          onReturned={async (info) => {
            // Акт строим ДО reload'а, на снимке rental, который уже
            // захвачен в этом замыкании — buildPartialReturnDoc сам
            // выясняет "что осталось" через параметр equipmentIds,
            // returned_at ещё не проставленных позиций для этого не нужен.
            setReturnDoc(buildPartialReturnDoc(rental, client, equipment, info.equipmentIds, info.damageFee, info.returnDate));
            await Promise.all([reloadRentals(), reloadEquipment()]);
            setSelectedReturnIds([]);
          }}
        />
      )}

      <DocModal title="Акт частичного возврата" open={!!returnDoc} onClose={() => setReturnDoc(null)}>
        {returnDoc}
      </DocModal>

      {paymentModalOpen && (
        <PaymentModal
          businessId={businessId}
          rental={rental}
          onClose={() => setPaymentModalOpen(false)}
          onPaid={reloadRentals}
        />
      )}
    </div>
  );
}
