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
import { IconClose, IconUser, IconEdit, IconRepeat, IconCalendar, IconCard } from "../../../lib/icons";
import { itemRateLabel, itemRateLabelTitle } from "./helpers";
import { api, ApiError } from "../../../api/client";
import { normalizePhoneDigits } from "../clients/helpers";
import { buildRentalSummaryText } from "../clients/summary";
import { MoreActionsMenu } from "../../../components/MoreActionsMenu";
import { RentalPhotosSection } from "./RentalPhotosSection";
import { RentalHistorySection } from "./RentalHistorySection";
import { DocModal, buildPartialReturnDoc, buildIssueDoc, buildReturnDoc, buildContractDoc } from "../documents";

/** Не оплачено (полностью или частично) — 1:1 та же формула, что и isUnpaid
 * в RentalsTab.tsx (бейдж на карточке списка), продублирована здесь, а не
 * импортирована оттуда: RentalsTab.tsx сам импортирует RentalDetailPanel
 * (см. докстринг файла выше), обратный импорт создал бы циклическую
 * зависимость между модулями. Однострочная чистая функция — риск разъехаться
 * с оригиналом минимален. */
function isUnpaid(r: Rental): boolean {
  return r.status !== "cancelled" && r.total - r.paid_amount > 0.01;
}

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

  // Предупреждение о переплате (48-й проход, обратная связь по карточке
  // аренды) — раньше форма молча принимала любую сумму: опечатка или
  // повторный клик создавали переплату, которую нигде не было видно (см.
  // симметричную строку "Переплата" в Финансах ниже). Не блокирует сабмит —
  // отрицательные и "странные" суммы остаются легитимным исправлением
  // ошибки, просто теперь видно заранее, к чему приведёт платёж.
  const numAmount = Number(amount) || 0;
  const overpayAfter = rental.paid_amount + numAmount - rental.total;

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
          {numAmount !== 0 && overpayAfter > 0.01 && (
            <div className="field-hint" style={{ color: "var(--warning-ink)", marginTop: "4px" }}>
              После этого платежа возникнет переплата: {money(overpayAfter)}.
            </div>
          )}
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
  onIssue,
  onReturn,
  onEdit,
  onCancel,
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
  // Основные действия по аренде (повторный обзор — "из панели деталей
  // нельзя ничего сделать, приходится закрывать её и искать ту же карточку
  // в списке") — тем же принципом, что и onExtend выше: сами модалки
  // (IssueRentalModal/ReturnRentalModal/EditRentalModal/CancelRentalModal)
  // не экспортированы из RentalsTab.tsx и продолжают жить там же, здесь
  // только сигнал "открой их для этой аренды". Ни одно из действий не
  // закрывает панель — после reload аренд из контекста статус/бейджи в уже
  // открытой панели обновятся сами, тот же принцип, что и у "Продлить".
  onIssue: (rentalId: string) => void;
  onReturn: (rentalId: string) => void;
  onEdit: (rentalId: string) => void;
  onCancel: (rentalId: string) => void;
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
  // Печать документов прямо из панели (повторный обзор — "Договор"/акты
  // раньше были доступны только с карточки в списке) — самостоятельный
  // локальный DocModal, а не делегирование наверх через ещё один проп: сами
  // build*Doc-функции чистые (клиент+аренда+оборудование → готовая
  // разметка), backend не трогают, тем же принципом, что и "Написать
  // клиенту" (buildRentalSummaryText) чуть выше — уже реализовано прямо
  // здесь, без похода в RentalsTab.tsx.
  const [printDoc, setPrintDoc] = useState<{ title: string; node: ReactNode } | null>(null);
  // Вкладки (по итогам обзора "карточка перегружена" — 1:1 тот же приём,
  // что уже применён на ClientDetailPanel.tsx в 35-м проходе: "Обзор" —
  // то, что нужно чаще всего, без скролла; "История" — заметки/фото/журнал,
  // то, что открывают редко, обычно чтобы разобраться в чём-то задним
  // числом). Два таба, а не три, как у клиента — у аренды меньше
  // самостоятельных смысловых блоков (нет отдельного "Журнала" заметок
  // сотрудника, который был бы третьим).
  const [panelTab, setPanelTab] = useState<"overview" | "history">("overview");

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
          {/* "Карточка клиента" перенесена сюда, к имени, из общего ряда
              действий ниже (обратная связь пользователя по карточке аренды:
              это ссылка про идентичность клиента, а не операция над самой
              арендой — по смыслу ей место рядом с именем, а не в одном ряду
              с "Выдать"/"Изменить"). .link-btn — тихая текстовая ссылка, а
              не полноценная кнопка: вес как у подсказки под заголовком, не
              как у действия. */}
          {client && (
            <button
              type="button"
              className="link-btn"
              style={{ display: "inline-flex", alignItems: "center", gap: "4px", marginTop: "4px" }}
              onClick={() => onOpenClient(client.id)}
            >
              <IconUser /> Карточка клиента
            </button>
          )}
          {/* Чёрный список клиента (повторный обзор — тот же контекст, что
              уже показывается в форме "Новая аренда" при выборе клиента, но
              раньше нигде не всплывал здесь, хотя карточка аренды — ровно то
              место, где это важно увидеть перед выдачей/продлением). */}
          {client?.rating === "blacklist" && (
            <div className="form-error" style={{ marginTop: "6px" }}>
              Клиент в чёрном списке{client.blacklist_reason ? `: ${client.blacklist_reason}` : ""}
            </div>
          )}
        </div>
        {/* "Ещё" перенесена в шапку, рядом с крестиком закрытия — тот же
            приём и та же причина, что и на ClientDetailPanel.tsx (37-й
            проход, обзор "кнопка Ещё рвёт карточку клиента"): в общем ряду
            действий кнопка не помещалась по ширине и переносилась на
            отдельную строку. Здесь всегда достаточно места, а по смыслу
            даже точнее: крестик и "Ещё" — управление самой карточкой
            (закрыть / прочие действия над ней), а "Выдать"/"Принять
            возврат"/"Изменить" в ряду ниже — операции с самой арендой, две
            разные категории кнопок больше не смешаны в одном ряду. */}
        <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <MoreActionsMenu
            align="right"
            iconOnly
            actions={[
              ...(st === "booked" ? [{ key: "cancel", label: "Отменить", onClick: () => onCancel(rental.id) }] : []),
              ...(st === "active" || st === "overdue"
                ? [{ key: "extend", label: "Продлить", icon: <IconEdit />, onClick: () => onExtend(rental.id) }]
                : []),
              {
                key: "repeat",
                label: "Повторить аренду",
                icon: <IconRepeat />,
                onClick: () => onRepeat(rental.client_id, rental.items.map((it) => it.equipment_id)),
              },
              { key: "calendar", label: "В календаре", icon: <IconCalendar />, onClick: () => onOpenCalendar(rental.start_date) },
              ...(st === "active" || st === "overdue"
                ? [
                    {
                      key: "issue-doc",
                      label: "Акт выдачи",
                      onClick: () => setPrintDoc({ title: "Акт приёма-передачи", node: buildIssueDoc(rental, client, equipment) }),
                    },
                  ]
                : []),
              ...(st === "returned"
                ? [
                    {
                      key: "return-doc",
                      label: "Акт возврата",
                      onClick: () => setPrintDoc({ title: "Акт возврата", node: buildReturnDoc(rental, client, equipment) }),
                    },
                  ]
                : []),
              {
                key: "contract-doc",
                label: "Договор",
                onClick: () => setPrintDoc({ title: "Договор аренды", node: buildContractDoc(rental, client, equipment) }),
              },
              ...(client?.phone
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
              ...(client?.email
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
          <button className="icon-btn" onClick={onClose}>
            <IconClose />
          </button>
        </div>
      </div>

      <div className="slideover-section" style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
        <Badge meta={RENTAL_META[st]} />
        {/* Бейдж оплаты (повторный обзор — та же логика, что и на карточке в
            списке, isUnpaid выше) — виден только когда реально не хватает
            денег, чтобы не грузить строку бейджей на каждой аренде подряд. */}
        {isUnpaid(rental) && <Badge meta={{ label: rental.paid_amount > 0 ? "Оплата частично" : "Не оплачено", tone: "warning" }} />}
        {/* Главное действие по статусу + "Изменить" — единственные два
            действия, оставленные на виду (по итогам обзора "карточка
            перегружена" — 1:1 тот же приём, что и на ClientDetailPanel.tsx,
            35-й проход: в основном ряду только то, что нужно каждый день,
            остальное — в "Ещё" в шапке выше). st includes "overdue" отдельно
            от "active" (см. rentalDisplayStatus), но по факту это та же
            "active"-аренда в БД. */}
        {st === "booked" && (
          <button className="btn btn-primary btn-sm" type="button" onClick={() => onIssue(rental.id)}>
            Выдать
          </button>
        )}
        {(st === "active" || st === "overdue") && (
          <button className="btn btn-primary btn-sm" type="button" onClick={() => onReturn(rental.id)}>
            Принять возврат
          </button>
        )}
        {(st === "booked" || st === "active" || st === "overdue") && (
          <button className="btn btn-sm" type="button" onClick={() => onEdit(rental.id)}>
            <IconEdit /> Изменить
          </button>
        )}
      </div>

      {/* Вкладки (см. комментарий у panelTab выше). margin-bottom: 4px, а не
          margin слева — тот же приём, что и на ClientDetailPanel.tsx: у
          .slideover уже есть свой padding, свой left-margin только увёл бы
          вкладки правее заголовков секций под ними. */}
      <div className="segmented" style={{ margin: "0 0 4px" }}>
        <button type="button" className={panelTab === "overview" ? "active" : ""} onClick={() => setPanelTab("overview")}>
          Обзор
        </button>
        <button type="button" className={panelTab === "history" ? "active" : ""} onClick={() => setPanelTab("history")}>
          История
        </button>
      </div>

      {panelTab === "overview" && (
      <>
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

      {/* "Финансы" разбита на три блока (48-й проход, обратная связь по
          карточке аренды: "один сплошной kv-grid мешает стоимость, оплату и
          депозит") — раньше это была одна секция с одним kv-grid на всё, и
          глаз не сразу считывал, где кончается "из чего сложилась цена" и
          начинается "что по деньгам сделано". "Депозит" вынесен в отдельную
          секцию ещё и потому, что его чекбоксу с подписью тесно в общей
          узкой колонке значений — см. отдельный блок ниже, не kv-grid. */}
      <div className="slideover-section">
        <h4>Стоимость</h4>
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
          {rental.extra_fee > 0 && (
            <>
              <span className="k">{rental.extra_fee_note ? `Доп. услуги — ${rental.extra_fee_note}` : "Доп. услуги"}</span>
              <span className="mono">{money(rental.extra_fee)}</span>
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
        </div>
      </div>

      <div className="slideover-section">
        <h4>Оплата</h4>
        <div className="kv-grid">
          <span className="k">Оплачено</span>
          <span className="mono" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "8px" }}>
            {money(rental.paid_amount)}
            {/* Иконка вместо текстовой кнопки (48-й проход, обратная связь
                по карточке аренды) — в строке "Оплачено" рядом с суммой
                текстовая кнопка выглядела тяжелее самого значения. */}
            <button className="icon-btn" type="button" title="Записать платёж" onClick={() => setPaymentModalOpen(true)}>
              <IconCard />
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
          {/* Переплата (48-й проход, обратная связь) — раньше при
              paid_amount > total карточка вообще ничего не показывала: была
              только строка на случай недоплаты, симметричной на случай
              переплаты не было, и оператор мог не заметить, что клиенту
              нужно вернуть лишнее. */}
          {rental.paid_amount - rental.total > 0.01 && (
            <>
              <span className="k">Переплата</span>
              <span className="mono" style={{ fontWeight: 600, color: "var(--warning-ink)" }}>
                {money(rental.paid_amount - rental.total)}
              </span>
            </>
          )}
        </div>
      </div>

      {rental.deposit_total > 0 && (
        <div className="slideover-section">
          <h4>Депозит</h4>
          <div className="kv-grid">
            <span className="k">Сумма на удержании</span>
            <span className="mono" style={{ fontWeight: 600 }}>{money(rental.deposit_total)}</span>
          </div>
          {/* Чекбокс возврата — отдельной строкой на всю ширину, а не втиснут
              в узкую колонку значений рядом с суммой (48-й проход, обратная
              связь: подпись "возвращён клиенту" переносилась посередине
              слова, когда делила колонку с суммой и чекбоксом). Явный
              flexDirection: "row" обязателен — базовый global `label {
              flex-direction: column }` (styles.css) иначе ставит чекбокс НАД
              текстом, а не рядом (тот же баг, что и вызвал перенос в старой
              вёрстке — inline style без flexDirection не перебивает это
              свойство, только display/gap/alignItems). */}
          <label
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: "6px",
              marginTop: "8px",
              fontSize: "12.5px",
              color: "var(--muted)",
              cursor: depositSaving ? "wait" : "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={!!rental.deposit_returned_at}
              disabled={depositSaving}
              onChange={toggleDepositReturned}
              style={{ width: "14px", height: "14px" }}
            />
            {rental.deposit_returned_at ? `Возвращён клиенту ${fmtDate(rental.deposit_returned_at)}` : "Возвращён клиенту"}
          </label>
          {depositError && <div className="form-error" style={{ marginTop: "6px" }}>{depositError}</div>}
        </div>
      )}
      </>
      )}

      {panelTab === "history" && (
        <>
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
        </>
      )}

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

      <DocModal title={printDoc?.title ?? ""} open={!!printDoc} onClose={() => setPrintDoc(null)}>
        {printDoc?.node}
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
