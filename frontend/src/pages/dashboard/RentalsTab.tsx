import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../../api/client";
import { useData } from "../../context/DataContext";
import type { Client, Equipment, Rental, RentalItem } from "../../api/types";
import { money, fmtDate, fmtDateRange, dayDiff, todayISO, isoAddDays, spanDays, formatPhoneInput, formatPassportInput } from "../../lib/format";
import { RENTAL_META, Badge, rentalDisplayStatus, type StatusMeta } from "../../lib/statusMeta";
import {
  IconPrinter,
  IconEdit,
  IconClose,
  IconAlert,
  IconCalendar,
  IconChevronDown,
  IconCheck,
  IconShield,
  IconMessages,
  IconFinance,
  IconSearch,
} from "../../lib/icons";
import { DocModal, buildContractDoc, buildIssueDoc, buildReturnDoc, buildBulkContractsDoc } from "./documents";
import { useConfirm } from "../../components/ConfirmDialog";
import { useModalDialog } from "../../lib/useModalDialog";
import { useToast } from "../../components/Toast";
import { usePersistedState } from "../../lib/persist";
import { Dropdown } from "../../components/Dropdown";
import { MoreActionsMenu } from "../../components/MoreActionsMenu";
import { clientDisplayRating, normalizePhoneDigits } from "./clients/helpers";
import { buildRentalSummaryText } from "./clients/summary";
import {
  equipmentRateLabel,
  equipmentRateLabelTitle,
  itemRateLabel,
  itemRateLabelTitle,
  isEquipmentFreeForRange,
  conflictEndFor,
  docNumber,
  equipmentCostForDays,
  isDepositDue,
  isUnpaid,
} from "./rentals/helpers";
import { exportRentalsCsv } from "./rentals/csv";
import { RentalDetailPanel, PaymentModal } from "./rentals/RentalDetailPanel";

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
 * от фильтра по менеджеру, он держится не на ownerId, а на рейтинге клиента
 * ("на контроле"/"чёрный список"), которое в проде есть — по ошибке был
 * ранее записан в один список с фильтром по менеджеру и не перенесён.
 * Исправлено при третьей сверке с демо — реализован ниже (riskOnly). 39-й
 * проход, доработки по итогам обзора: сам riskOnly читал СЫРОЕ client.rating
 * ("normal"/"blacklist" — только формальный чёрный список), а не живой
 * clientDisplayRating (clients/helpers.tsx) — клиенты, у которых просрочка
 * прямо сейчас, но которых никто вручную не заносил в чёрный список,
 * фильтром не ловились. Исправлено — теперь используется clientDisplayRating,
 * тот же расчёт, что и бейдж рейтинга во вкладке "Клиенты".
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
  // "По долгу" (49-й проход, по итогам обзора списка "Аренды") — "По сумме"
  // сортирует по общей стоимости аренды, а не по непогашенному остатку; для
  // приоритизации звонков должникам (крупные долги наверх) нужна отдельная
  // сортировка именно по остатку, см. debtOf ниже.
  { id: "debt", label: "По долгу" },
];

// Тексты по умолчанию для textarea выдачи/возврата — 1:1 с демо
// (issueRentalForm/returnRentalForm) и с DEFAULT_ISSUE_NOTES/DEFAULT_RETURN_NOTES
// на backend'е (app/api/routes/rentals.py) — если поле не тронуто, отправляем
// именно этот текст явно (backend и сам подставит его при пустом значении,
// но так пользователь видит тот же дефолт, что и в форме демо).
const DEFAULT_ISSUE_NOTES = "Комплектация полная, состояние исправное.";
const DEFAULT_RETURN_NOTES = "Без повреждений, комплектация полная.";

// rangesOverlap/isEquipmentFreeForRange/conflictEndFor (проверка
// пересечения ЛЮБОГО booked/active бронирования с произвольным диапазоном
// дат — порт isEquipmentFree/nextFreeDate демо) вынесены в rentals/helpers.ts
// (41-й проход) — понадобились ещё и в ExtendRentalModal (проверка
// конфликта при быстром продлении) и CreateRentalModal (фильтр
// предзаполненных позиций при "Повторить аренду"), дублировать три функции
// ради этого было бы ошибкой.

function isUnderMaintenanceOn(eq: Equipment, dateIso: string): boolean {
  if (eq.status !== "maintenance") return false;
  if (!eq.maintenance_until) return true;
  return dateIso <= eq.maintenance_until;
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
  const afterUnit = it.after_period_days_snapshot;
  // Блочная надбавка (двадцатый проход) — см. financeCalc.ts:itemCostForDays,
  // та же формула, продублированная здесь по тому же принципу, что и раньше.
  if (afterUnit) {
    const blocks = Math.ceil(extraDays / afterUnit);
    return periodPrice + blocks * (periodPriceAfter || 0);
  }
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
  // Доп. услуги (46-й проход) — фиксированное значение аренды, здесь не
  // редактируется (это делает CreateRentalModal/EditRentalModal), просто
  // должно попадать в итоговую сумму предпросмотра возврата — см. ниже.
  extraFee: number;
  extraFeeNote: string | null;
  discount: number;
  total: number;
}

// isDepositDue/isUnpaid перенесены в rentals/helpers.ts (49-й проход) —
// понадобились и в Dashboard.tsx (сводка долга в шапке вкладки), см. импорт
// ниже.

function previewReturnFinance(r: Rental, actualReturn: string, damageFee: number): FinancePreview {
  const plannedDays = spanDays(r.start_date, r.end_date);
  const endForCalc = actualReturn || (dayDiff(r.end_date) < 0 ? todayISO() : r.end_date);
  const actualDays = spanDays(r.start_date, endForCalc);
  const lateDays = Math.max(0, actualDays - plannedDays);
  const base = Math.round(itemsCostForDays(r.items, plannedDays));
  const actualCost = Math.round(itemsCostForDays(r.items, actualDays));
  const lateFee = Math.max(0, actualCost - base);
  const discount = r.discount || 0;
  const extraFee = r.extra_fee || 0;
  const total = Math.max(0, base + lateFee + damageFee + extraFee - discount);
  return {
    plannedDays,
    lateDays,
    base,
    lateFee,
    damage: damageFee,
    extraFee,
    extraFeeNote: r.extra_fee_note,
    discount,
    total,
  };
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
      {fin.extraFee > 0 && (
        <div className="summary-row">
          <span>{fin.extraFeeNote ? `Доп. услуги — ${fin.extraFeeNote}` : "Доп. услуги"}</span>
          <span className="v">{money(fin.extraFee)}</span>
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
  // Красная кнопка отправки (43-й проход, п.5 обзора — CancelRentalModal) —
  // необязательный проп, по умолчанию false, старое поведение (btn-primary)
  // не меняется ни для одной из уже существующих форм на FormModal.
  danger,
  // Итоговая сумма в футере (46-й проход, повторный обзор формы "Новая
  // аренда") — необязательный проп, по умолчанию отсутствует, старое
  // поведение футера (просто кнопки, прижатые вправо) не меняется ни для
  // одной из форм, которые его не передают. Раньше итог показывался
  // "прилипающим" блоком внутри прокручиваемого тела формы (.summary-box.
  // sticky-summary) — по итогам обзора пользователь указал, что при
  // длинном списке оборудования это одновременно съедает видимую высоту
  // списка И визуально наезжает на соседние поля (скидка/доп. услуги),
  // когда список короткий. Футер модалки в принципе никогда не скроллится
  // — это НАСТОЯЩАЯ фиксация, а не CSS sticky-трюк, поэтому вынести туда
  // только сам итог (без построчной разбивки, которая остаётся в теле
  // формы обычным, не прилипающим блоком) решает обе жалобы сразу.
  footerExtra,
  // Защита от случайного закрытия (повторный обзор формы "Новая аренда") —
  // тот же принцип, что уже реализован в EquipmentFormModal/ClientFormModal:
  // если передан onRequestClose, ИМЕННО он вызывается из X/"Отмена"/Esc/
  // клика по фону вместо прямого onClose — вызывающий компонент сам решает,
  // нужно ли спросить подтверждение при несохранённых изменениях. Если проп
  // не передан (все остальные формы на FormModal — Выдача, Возврат,
  // Продление и т.д.) — поведение остаётся прежним, один-в-один.
  onRequestClose,
  // Второй <dialog> подтверждения ("Несохранённые изменения будут
  // потеряны") от useConfirm() вызывающего компонента — рендерится ПОСЛЕ
  // </form>, но всё ещё внутри этого же внешнего <dialog>, тем же приёмом,
  // что и discardDialog в EquipmentFormModal/ClientFormModal.
  afterForm,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  submitLabel?: string;
  wide?: boolean;
  error?: string | null;
  danger?: boolean;
  footerExtra?: ReactNode;
  onRequestClose?: () => void;
  afterForm?: ReactNode;
  children: ReactNode;
}) {
  const { ref, handleNativeClose } = useModalDialog(open);
  const requestClose = onRequestClose ?? onClose;

  return (
    <dialog
      id="modal"
      className={wide ? "wide" : undefined}
      ref={ref}
      onClose={() => handleNativeClose(onClose)}
      onCancel={(e) => {
        // Esc закрывает <dialog> сам — трактуем как запрос на закрытие,
        // а не как безусловное закрытие (тот же приём, что и в
        // EquipmentFormModal/ClientFormModal).
        e.preventDefault();
        requestClose();
      }}
      onClick={(e) => {
        // Клик по затемнённому фону закрывает модалку — тот же идиом, что и
        // в EquipmentTab.tsx (16-й проход, п.2 обзора). Раньше здесь этого
        // не было, хотя визуально модалка выглядит идентично.
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <form onSubmit={onSubmit}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={requestClose} type="button">
            <IconClose />
          </button>
        </div>
        <div className="modal-body">
          {children}
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className={"modal-foot" + (footerExtra ? " modal-foot-split" : "")}>
          {footerExtra && <div className="modal-foot-total">{footerExtra}</div>}
          <div className="modal-foot-actions">
            <button className="btn" onClick={requestClose} type="button">
              Отмена
            </button>
            <button className={"btn " + (danger ? "btn-danger" : "btn-primary")} type="submit">
              {submitLabel}
            </button>
          </div>
        </div>
      </form>
      {afterForm}
    </dialog>
  );
}

/** Мультивыбор оборудования с проверкой занятости на диапазон [start, end] —
 * порт общей разметки .eq-picklist/.eq-pick-row демо, используется и в
 * создании, и в правке аренды.
 *
 * 46-й проход, по итогам обзора формы "Новая аренда" (пользователь принял
 * все три моих предложения из обзора целиком, поиск — единственное из его
 * собственных трёх вопросов, на которое тоже согласился):
 *  - список теперь отсортирован (категория → название → номер) и разбит на
 *    подписанные группы по категории — раньше порядок совпадал с тем, как
 *    записи лежат в базе (фактически случайным для пользователя), из-за
 *    чего несколько одинаковых по названию единиц оказывались вперемешку с
 *    другим оборудованием без всякой системы;
 *  - под названием — номер (Equipment.code) и склад, тот же принцип
 *    подписи, что "№ …" на вкладке "Оборудование" (EquipmentTab.tsx) —
 *    раньше несколько единиц с одинаковым названием были неотличимы друг от
 *    друга в этом списке;
 *  - ставка сопровождается title-подсказкой (equipmentRateLabelTitle) —
 *    расшифровка ступенчатого тарифа полным предложением при наведении;
 *  - строка поиска по названию/номеру/категории — тот же .search-box, что
 *    в общем поиске шапки (Dashboard.tsx);
 *  - заголовок каждой группы кликабелен — сворачивает/разворачивает её
 *    содержимое (по просьбе пользователя — сезонное оборудование, которое
 *    не нужно видеть полгода). Состояние "что свёрнуто" запоминается
 *    насовсем на конкретный бизнес (usePersistedState — тот же приём, что
 *    уже хранит сортировку/колонки на "Оборудовании"), иначе пришлось бы
 *    заново сворачивать категорию при каждом открытии формы. Пока идёт
 *    активный поиск — сворачивание игнорируется (см. visible ниже): прятать
 *    от пользователя совпадения его же собственного запроса было бы хуже,
 *    чем просто временно проигнорировать его же ранее сохранённые настройки
 *    свёрнутости.
 */
function EquipmentPicklist({
  items,
  start,
  end,
  rentals,
  excludeRentalId,
  checkedIds,
  onToggle,
  onClearAll,
  alwaysShowIds,
  businessId,
}: {
  items: Equipment[];
  start: string;
  end: string;
  rentals: Rental[];
  excludeRentalId?: string;
  checkedIds: string[];
  onToggle: (id: string) => void;
  // Сброс всего выбранного разом (четвёртый обзор той же формы) — раньше
  // снять отметки можно было только по одной, кликая крестик на каждом
  // чипе; при случайно отмеченных позициях в разных категориях это
  // неудобно. Необязательный проп — родитель решает, что значит "очистить"
  // (просто setCheckedIds([])).
  onClearAll?: () => void;
  alwaysShowIds?: string[];
  businessId: string;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = usePersistedState<string[]>(`eq-picklist-collapsed:${businessId}`, []);

  function toggleCollapsed(category: string) {
    setCollapsed((prev) => (prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]));
  }

  const base = items.filter(
    (e) => (alwaysShowIds?.includes(e.id) ?? false) || (e.status !== "retired" && !isUnderMaintenanceOn(e, start))
  );
  const sorted = [...base].sort((a, b) => {
    const byCategory = a.category.localeCompare(b.category, "ru");
    if (byCategory !== 0) return byCategory;
    const byName = a.name.localeCompare(b.name, "ru");
    if (byName !== 0) return byName;
    return (a.code ?? "").localeCompare(b.code ?? "", "ru");
  });
  const q = query.trim().toLowerCase();
  const visible = q
    ? sorted.filter((e) => (e.name + " " + e.category + " " + (e.code ?? "")).toLowerCase().includes(q))
    : sorted;
  // Во время поиска сворачивание не действует (см. докстринг выше) —
  // применяем сохранённое collapsed только когда поле поиска пустое.
  const collapseActive = !q;

  // Счётчик позиций в каждой категории (повторный обзор формы "Новая
  // аренда") — считается от того же visible, что и сам список: пока идёт
  // поиск, число в свёрнутом заголовке — это то, сколько там совпадений
  // запроса, а не общее число позиций категории вслепую.
  const categoryCounts = new Map<string, number>();
  for (const e of visible) categoryCounts.set(e.category, (categoryCounts.get(e.category) ?? 0) + 1);
  // Сколько из них уже отмечено (четвёртый обзор той же формы) — раньше
  // заголовок свёрнутой категории показывал только общее число позиций, но
  // не намекал, есть ли внутри уже выбранное: отметив пару позиций и
  // свернув категорию, легко забыть, что там что-то выбрано.
  const categorySelected = new Map<string, number>();
  for (const e of visible) {
    if (checkedIds.includes(e.id)) categorySelected.set(e.category, (categorySelected.get(e.category) ?? 0) + 1);
  }

  // Стоимость за весь выбранный срок, а не только ставка за сутки
  // (повторный обзор формы "Новая аренда") — то же previewDays, что
  // считают CreateRentalModal/EditRentalModal для итоговой суммы формы.
  const previewDays = end >= start ? spanDays(start, end) : 0;

  let lastCategory: string | null = null;

  return (
    <div>
      <div className="search-box eq-search-sticky" style={{ width: "100%", marginBottom: "8px" }}>
        <IconSearch width={14} height={14} />
        <input
          type="text"
          placeholder="Поиск по названию, номеру, категории…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {checkedIds.length > 0 && (
        <div className="eq-pick-chips">
          {checkedIds.map((id) => {
            const eq = items.find((e) => e.id === id);
            if (!eq) return null;
            return (
              <span className="eq-pick-chip" key={id}>
                <span>{eq.name}</span>
                <button type="button" onClick={() => onToggle(id)} aria-label={`Убрать «${eq.name}» из выбранного`}>
                  <IconClose />
                </button>
              </span>
            );
          })}
          {onClearAll && (
            <button type="button" className="link-btn" onClick={onClearAll}>
              Очистить
            </button>
          )}
        </div>
      )}
      <div className="eq-picklist">
        {visible.length === 0 ? (
          <div className="empty-note" style={{ padding: "10px 12px" }}>
            Ничего не найдено
          </div>
        ) : (
          visible.map((e) => {
            const free = isEquipmentFreeForRange(e.id, start, end, rentals, excludeRentalId);
            const conflictEnd = free ? null : conflictEndFor(e.id, start, end, rentals, excludeRentalId);
            const checked = checkedIds.includes(e.id);
            const showGroup = e.category !== lastCategory;
            lastCategory = e.category;
            const isCollapsed = collapseActive && collapsed.includes(e.category);
            return (
              // Fragment, а не оборачивающий <div> — .eq-pick-row:last-child
              // (снимает нижнюю границу у последней строки списка) полагается
              // на то, что строки остаются ПРЯМЫМИ детьми .eq-picklist;
              // обёртка сделала бы каждую строку "последним ребёнком" своего
              // персонального div и убрала бы разделители между позициями.
              <Fragment key={e.id}>
                {showGroup && (
                  <button
                    type="button"
                    className={"eq-pick-group" + (isCollapsed ? " collapsed" : "")}
                    onClick={() => toggleCollapsed(e.category)}
                  >
                    <IconChevronDown />
                    <span className="eq-pick-group-name">{e.category}</span>
                    <span className="eq-pick-group-count">
                      {(() => {
                        const selected = categorySelected.get(e.category) ?? 0;
                        const total = categoryCounts.get(e.category);
                        return selected > 0 ? `(${selected} из ${total})` : `(${total})`;
                      })()}
                    </span>
                  </button>
                )}
                {!isCollapsed && (
                  <label className={`eq-pick-row${free ? "" : " disabled"}`}>
                    <input type="checkbox" checked={checked} disabled={!free} onChange={() => onToggle(e.id)} />
                    <span className="eq-pick-info">
                      <span className="eq-pick-name">{e.name}</span>
                      <span className="eq-pick-sub">
                        № {e.code ?? "—"}
                        {e.warehouse ? ` · ${e.warehouse}` : ""}
                      </span>
                    </span>
                    {/* Плашка "занято до" стоит ДО суммы, а не после (третий
                        обзор той же формы) — раньше она была последним flex-
                        элементом строки и, появляясь только у части позиций,
                        отжимала .eq-pick-cost влево ровно на свою ширину: суммы
                        занятых и свободных позиций оказывались на разной
                        горизонтали, мешая сравнивать их взглядом сверху вниз.
                        Теперь у .eq-pick-cost зафиксирована собственная ширина
                        (см. styles.css), и порядок элементов в строке гарантирует,
                        что она всегда последняя — сумма садится в одно и то же
                        место независимо от того, есть плашка или нет. */}
                    {!free && conflictEnd && <span className="eq-pick-conflict">занято до {fmtDate(conflictEnd)}</span>}
                    <span className="eq-pick-cost" title={equipmentRateLabelTitle(e)}>
                      {previewDays > 0 && (
                        <span className="eq-pick-cost-total">{money(equipmentCostForDays(e, previewDays))}</span>
                      )}
                      <span className="eq-pick-cost-rate">{equipmentRateLabel(e)}</span>
                    </span>
                  </label>
                )}
              </Fragment>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ---------- Новая аренда ---------- */
export function CreateRentalModal({
  businessId,
  clients,
  equipment,
  rentals,
  initialClientId,
  initialEquipmentIds,
  onClose,
  onCreated,
}: {
  businessId: string;
  clients: Client[];
  equipment: Equipment[];
  rentals: Rental[];
  // Предзаполненный клиент (25-й проход, п.1 обзора: "+ Новая аренда" прямо
  // из карточки клиента) — необязательный, при обычном открытии кнопкой в
  // шапке/вкладке "Аренды" его нет, и клиента выбирают вручную как раньше.
  // Поле выбора клиента при этом остаётся редактируемым (не блокируется) —
  // предзаполнение не должно мешать передумать прямо в форме.
  initialClientId?: string;
  // Предзаполненные позиции оборудования (41-й проход — "Повторить аренду"
  // из RentalDetailPanel: та же техника, что клиент брал в прошлый раз).
  // Отмечаются галочкой только те, что реально свободны на дефолтный
  // диапазон дат (todayISO()..+2, см. ниже) — а не все переданные вслепую:
  // иначе чекбокс был бы виден отмеченным, но disabled (занято), что и
  // выглядит как баг, и не даёт пользователю понять, что вообще произошло.
  initialEquipmentIds?: string[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [clientId, setClientId] = useState(initialClientId ?? "");
  const [startDate, setStartDate] = useState(todayISO());
  const [endDate, setEndDate] = useState(isoAddDays(todayISO(), 2));
  const [checkedIds, setCheckedIds] = useState<string[]>(() =>
    (initialEquipmentIds ?? []).filter((id) => isEquipmentFreeForRange(id, todayISO(), isoAddDays(todayISO(), 2), rentals))
  );
  const [discount, setDiscount] = useState("");
  // Доп. услуги (46-й проход) — по образцу discount выше: одно поле суммы +
  // короткая подпись, за что взяли деньги (см. Rental.extra_fee/
  // extra_fee_note). В отличие от discount, у extra_fee нет "автоподстановки
  // по умолчанию" — просто 0/пусто, если сотрудник ничего не вписал.
  const [extraFee, setExtraFee] = useState("");
  const [extraFeeNote, setExtraFeeNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Быстрое добавление клиента прямо из формы "Новая аренда" (по итогам
  // обзора — "нужно ли иметь возможность добавить нового клиента"). Только
  // самые необходимые поля, без полной карточки клиента (тип/скидка/теги и
  // т.д. дозаполняются потом через полноценную карточку) — но паспорт/ИНН
  // здесь ОБЯЗАТЕЛЬНЫ (хотя бы одно из двух), по прямому указанию: в отличие
  // от полной формы клиента, где для физлица оба поля необязательны.
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [qaName, setQaName] = useState("");
  const [qaPhone, setQaPhone] = useState("");
  const [qaDoc, setQaDoc] = useState("");
  const [qaInn, setQaInn] = useState("");
  const [qaError, setQaError] = useState<string | null>(null);
  const [qaSaving, setQaSaving] = useState(false);

  const { reloadClients } = useData();
  const { confirm: confirmDiscard, dialog: discardDialog } = useConfirm();

  // Защита от случайного закрытия (повторный обзор — "как на страницах
  // Оборудование и Клиенты"). Модалка монтируется заново при каждом
  // открытии (родитель рендерит её условно), поэтому исходный снимок формы
  // достаточно снять один раз прямо на первом рендере через useRef — не
  // нужен сброс по open, как в формах Оборудования/Клиентов, которые не
  // размонтируются между открытиями.
  const initialSnapshotRef = useRef({
    clientId,
    startDate,
    endDate,
    checkedIds,
    discount,
    extraFee,
    extraFeeNote,
    quickAddOpen,
    qaName,
    qaPhone,
    qaDoc,
    qaInn,
  });
  const initialSnapshot = initialSnapshotRef.current;
  const isDirty =
    clientId !== initialSnapshot.clientId ||
    startDate !== initialSnapshot.startDate ||
    endDate !== initialSnapshot.endDate ||
    checkedIds.length !== initialSnapshot.checkedIds.length ||
    checkedIds.some((id) => !initialSnapshot.checkedIds.includes(id)) ||
    discount !== initialSnapshot.discount ||
    extraFee !== initialSnapshot.extraFee ||
    extraFeeNote !== initialSnapshot.extraFeeNote ||
    quickAddOpen !== initialSnapshot.quickAddOpen ||
    qaName !== initialSnapshot.qaName ||
    qaPhone !== initialSnapshot.qaPhone ||
    qaDoc !== initialSnapshot.qaDoc ||
    qaInn !== initialSnapshot.qaInn;

  async function requestClose() {
    if (saving) return;
    if (isDirty) {
      if (!(await confirmDiscard("Несохранённые изменения будут потеряны.", { confirmLabel: "Закрыть без сохранения" })))
        return;
    }
    onClose();
  }

  async function handleQuickAddClient() {
    setQaError(null);
    const name = qaName.trim();
    const doc = qaDoc.trim();
    const inn = qaInn.trim();
    if (!name) {
      setQaError("Укажите имя клиента");
      return;
    }
    // Проверки формата (тот же принцип, что validateLocally в
    // ClientFormModal.tsx — телефон/ИНН) — поля уже отформатированы маской
    // по мере ввода (formatPhoneInput/formatPassportInput), здесь только
    // финальная проверка длины перед отправкой.
    if (qaPhone.trim()) {
      const digits = qaPhone.replace(/\D/g, "").length;
      if (digits < 10 || digits > 15) {
        setQaError("Похоже на некорректный номер телефона — должно быть от 10 до 15 цифр");
        return;
      }
    }
    if (doc && doc.replace(/\D/g, "").length !== 10) {
      setQaError("Паспорт должен содержать 10 цифр (серия + номер)");
      return;
    }
    if (inn && ![10, 12].includes(inn.length)) {
      setQaError("ИНН должен состоять из 10 цифр (организация) или 12 цифр (ИП/физлицо)");
      return;
    }
    if (!doc && !inn) {
      setQaError("Укажите паспорт или ИНН — хотя бы одно из двух");
      return;
    }
    setQaSaving(true);
    try {
      const created = await api.post<Client>(`/businesses/${businessId}/clients`, {
        name,
        phone: qaPhone.trim() || null,
        email: null,
        doc: doc || null,
        notes: null,
        client_type: "individual",
        contact_person: null,
        inn: inn || null,
        default_discount_percent: null,
        tags: null,
        birthday: null,
        additional_contacts: null,
      });
      // reloadClients() обновляет общий список в DataContext — тот же
      // источник, откуда родитель (RentalsTab) берёт clients и передаёт
      // сюда пропом, так что новый клиент появится в Dropdown сам по себе
      // при следующем рендере, без ручного хранения локальной копии списка.
      await reloadClients();
      setClientId(created.id);
      setQuickAddOpen(false);
      setQaName("");
      setQaPhone("");
      setQaDoc("");
      setQaInn("");
    } catch (err) {
      setQaError(err instanceof ApiError ? err.message : "Не удалось создать клиента");
    } finally {
      setQaSaving(false);
    }
  }

  const selectedClient = clients.find((c) => c.id === clientId);

  // Живая оценка стоимости (43-й проход, п.1 обзора) — до сих пор сумма
  // появлялась только ПОСЛЕ оформления аренды, в самом акте выдачи; здесь же
  // сотрудник ещё выбирает состав/даты и не знает, на что вообще
  // ориентировать клиента по телефону. Формула — 1:1 копия расчёта скидки в
  // create_rental (app/api/routes/rentals.py): явное значение поля "Скидка"
  // имеет приоритет, иначе — процент по умолчанию у клиента (округление тем
  // же Math.round, что и backend'ский round()), иначе скидки нет. base
  // считается по ЖИВОМУ тарифу оборудования (equipmentCostForDays) — как и
  // сделает backend при создании, снимков позиций аренды ещё не существует.
  const previewDays = endDate >= startDate ? spanDays(startDate, endDate) : 0;
  const previewBase =
    previewDays > 0
      ? checkedIds.reduce((sum, id) => {
          const eq = equipment.find((e) => e.id === id);
          return eq ? sum + equipmentCostForDays(eq, previewDays) : sum;
        }, 0)
      : 0;
  const explicitDiscount = discount.trim() === "" ? null : Number(discount);
  const previewDiscount =
    explicitDiscount != null
      ? explicitDiscount
      : selectedClient?.default_discount_percent
        ? Math.round((previewBase * selectedClient.default_discount_percent) / 100)
        : 0;
  const previewExtraFee = Number(extraFee) || 0;
  const previewTotal = Math.max(0, previewBase + previewExtraFee - previewDiscount);

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
        // 25-й проход, п.7: если поле оставлено пустым — backend сам
        // подставит скидку из Client.default_discount_percent выбранного
        // клиента (см. app/api/routes/rentals.py:create_rental), фронту не
        // нужно повторять расчёт по ступенчатому тарифу. Явное значение (в
        // том числе 0) отправляется как есть и имеет приоритет.
        discount: discount.trim() === "" ? undefined : Number(discount),
        // Доп. услуги — необязательное поле, при пустом вводе не отправляем
        // вовсе (backend оставит extra_fee=0 по умолчанию для новой аренды).
        extra_fee: extraFee.trim() === "" ? undefined : Number(extraFee),
        extra_fee_note: extraFeeNote.trim() === "" ? undefined : extraFeeNote.trim(),
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
      onRequestClose={requestClose}
      afterForm={discardDialog}
      onSubmit={handleSubmit}
      submitLabel={saving ? "Сохранение…" : "Оформить"}
      wide
      error={error}
      footerExtra={previewDays > 0 && checkedIds.length > 0 ? `К оплате: ${money(previewTotal)}` : undefined}
    >
      <div className="field">
        <label>Клиент</label>
        {/* Поиск (46-й проход, по итогам обзора формы "Новая аренда" — при
            росте базы клиентов простой скролл по кнопкам перестаёт работать)
            — searchable уже был готов в самом Dropdown (используется, например,
            в подборе клиента при объединении дублей), здесь просто не был
            включён. Список отсортирован по алфавиту — иначе даже до начала
            поиска порядок опций был бы "как лежат в базе", случайным на вид. */}
        <Dropdown
          value={clientId}
          onChange={setClientId}
          placeholder="Выберите клиента"
          searchable
          searchPlaceholder="Поиск клиента…"
          options={[...clients]
            .sort((a, b) => a.name.localeCompare(b.name, "ru"))
            .map((c) => ({ value: c.id, label: c.name + (c.phone ? ` · ${c.phone}` : "") }))}
        />
        {/* 26-й проход, проф. обзор: раньше рейтинг "чёрный список" нигде не
            всплывал в момент, когда это важнее всего — при оформлении НОВОЙ
            аренды. Не блокирует (решение по-прежнему за сотрудником — клиент
            мог уже всё вернуть/загладить), но предупреждает явно. */}
        {selectedClient?.rating === "blacklist" && (
          <div className="form-error" style={{ marginTop: "6px" }}>
            Клиент в чёрном списке{selectedClient.blacklist_reason ? `: ${selectedClient.blacklist_reason}` : ""}
          </div>
        )}
        {/* Быстрое добавление клиента (повторный обзор — "нужно ли иметь
            возможность добавить нового клиента на этапе оформления аренды")
            — вместо вложенного <dialog> (см. обсуждение: стек модалок на
            <dialog> сам по себе источник багов, см. useModalDialog.ts) это
            обычная встроенная панель внутри тела формы, разворачивающаяся
            по клику. Не трогает сам Dropdown — тот остаётся полностью
            переиспользуемым общим компонентом. */}
        {!quickAddOpen ? (
          // display: "block" обязателен явно (по итогам обзора — "кнопка
          // по прежнему вплотную к Dropdown'у") — обёртка Dropdown'а
          // (.cat-filter) сама по себе display: inline-block, поэтому
          // marginTop сам по себе не переносил ссылку на новую строку: она
          // просто вставала СПРАВА от закрытой кнопки дропдауна на той же
          // строке, если по ширине хватало места. block гарантированно
          // переносит её под поле независимо от его ширины.
          <button
            type="button"
            className="link-btn"
            style={{ display: "block", marginTop: "12px" }}
            onClick={() => setQuickAddOpen(true)}
          >
            + Добавить нового клиента
          </button>
        ) : (
          <div style={{ marginTop: "12px", padding: "10px", background: "var(--surface-2)", borderRadius: "8px" }}>
            <div className="field-row">
              <div className="field">
                <label>Имя</label>
                <input
                  type="text"
                  value={qaName}
                  onChange={(e) => setQaName(e.target.value)}
                  placeholder="Имя клиента"
                  autoFocus
                />
              </div>
              <div className="field">
                <label>Телефон</label>
                {/* Маска ввода (по итогам обзора — "ко всем полям маску") —
                    та же formatPhoneInput, что и в форме клиента
                    (ClientFormModal.tsx). */}
                <input
                  type="text"
                  value={qaPhone}
                  onChange={(e) => setQaPhone(formatPhoneInput(e.target.value))}
                  placeholder="+7 900 000-00-00"
                />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Паспорт</label>
                {/* На вкладке "Клиенты" поле "Документ" — простой текст без
                    маски (там оно должно вмещать и загранпаспорт, и другие
                    документы). Здесь поле называется конкретно "Паспорт",
                    так что маска серии+номера уместна — новая функция
                    formatPassportInput в lib/format.ts. */}
                <input
                  type="text"
                  value={qaDoc}
                  onChange={(e) => setQaDoc(formatPassportInput(e.target.value))}
                  placeholder="45 03 123456"
                />
              </div>
              <div className="field">
                <label>ИНН</label>
                <input
                  type="text"
                  value={qaInn}
                  onChange={(e) => setQaInn(e.target.value.replace(/\D/g, "").slice(0, 12))}
                  placeholder="ИНН"
                />
              </div>
            </div>
            <div className="field-hint">Укажите паспорт или ИНН — хотя бы одно из двух обязательно.</div>
            {qaError && <div className="form-error">{qaError}</div>}
            <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
              <button
                type="button"
                className="btn"
                disabled={qaSaving}
                onClick={() => {
                  setQuickAddOpen(false);
                  setQaError(null);
                }}
              >
                Отмена
              </button>
              <button type="button" className="btn btn-primary" disabled={qaSaving} onClick={() => void handleQuickAddClient()}>
                {qaSaving ? "Сохранение…" : "Добавить клиента"}
              </button>
            </div>
          </div>
        )}
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
        <label>Оборудование{checkedIds.length > 0 ? ` — выбрано: ${checkedIds.length}` : ""}</label>
        <EquipmentPicklist
          items={equipment}
          start={startDate}
          end={endDate}
          rentals={rentals}
          checkedIds={checkedIds}
          onToggle={toggle}
          onClearAll={() => setCheckedIds([])}
          businessId={businessId}
        />
        <div className="field-hint">Занятые на выбранные даты позиции недоступны для выбора.</div>
      </div>
      <div className="field">
        <label>Скидка, ₽ (необязательно)</label>
        <input type="number" min={0} value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0" />
        {selectedClient?.default_discount_percent ? (
          <div className="field-hint">
            У клиента скидка по умолчанию {selectedClient.default_discount_percent}% — если оставить поле пустым, она
            применится автоматически.
          </div>
        ) : (
          <div className="field-hint">Если не указать — скидки не будет (если у клиента не задана скидка по умолчанию).</div>
        )}
      </div>
      <div className="field-row">
        <div className="field">
          <label>Доп. услуги, ₽ (необязательно)</label>
          <input type="number" min={0} value={extraFee} onChange={(e) => setExtraFee(e.target.value)} placeholder="0" />
        </div>
        <div className="field">
          <label>За что</label>
          <input
            type="text"
            maxLength={200}
            value={extraFeeNote}
            onChange={(e) => setExtraFeeNote(e.target.value)}
            placeholder="Например, доставка"
          />
        </div>
      </div>
      {previewDays > 0 && checkedIds.length > 0 && (
        <div className="summary-box summary-box-outcome">
          <div className="summary-row">
            <span>Аренда, {previewDays} дн.</span>
            <span className="v">{money(previewBase)}</span>
          </div>
          {previewExtraFee > 0 && (
            <div className="summary-row">
              <span>{extraFeeNote.trim() ? `Доп. услуги — ${extraFeeNote.trim()}` : "Доп. услуги"}</span>
              <span className="v">{money(previewExtraFee)}</span>
            </div>
          )}
          {previewDiscount > 0 && (
            <div className="summary-row">
              <span>Скидка</span>
              <span className="v">−{money(previewDiscount)}</span>
            </div>
          )}
          <div className="summary-row total">
            <span>Ориентировочно к оплате</span>
            <span className="v">{money(previewTotal)}</span>
          </div>
        </div>
      )}
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
  // Доп. услуги (46-й проход) — предзаполняем текущим значением аренды.
  // ВАЖНО: в отличие от полей выше, extra_fee/extra_fee_note ВСЕГДА
  // отправляются в PATCH явно (см. handleSubmit) — backend не умеет отличить
  // "поле не трогали" от "обнулили", если поле вообще не прислано, он его не
  // трогает; но раз форма показывает и позволяет менять оба поля сразу,
  // текущее значение должно уходить обратно даже если пользователь его не
  // редактировал (тот же принцип, что уже применяется здесь для discount).
  const [extraFee, setExtraFee] = useState(rental.extra_fee ? String(rental.extra_fee) : "");
  const [extraFeeNote, setExtraFeeNote] = useState(rental.extra_fee_note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Защита от случайного закрытия (тот же приём, что и в CreateRentalModal
  // выше — тем же принципом мирроринга, что уже применялся ко всем прошлым
  // правкам этой формы в паре с CreateRentalModal). Модалка монтируется
  // заново при каждом открытии карточки правки, так что снимок исходных
  // значений достаточно снять один раз на первом рендере.
  const { confirm: confirmDiscard, dialog: discardDialog } = useConfirm();
  const initialSnapshotRef = useRef({ startDate, endDate, checkedIds, discount, extraFee, extraFeeNote });
  const initialSnapshot = initialSnapshotRef.current;
  const isDirty =
    startDate !== initialSnapshot.startDate ||
    endDate !== initialSnapshot.endDate ||
    checkedIds.length !== initialSnapshot.checkedIds.length ||
    checkedIds.some((id) => !initialSnapshot.checkedIds.includes(id)) ||
    discount !== initialSnapshot.discount ||
    extraFee !== initialSnapshot.extraFee ||
    extraFeeNote !== initialSnapshot.extraFeeNote;

  async function requestClose() {
    if (saving) return;
    if (isDirty) {
      if (!(await confirmDiscard("Несохранённые изменения будут потеряны.", { confirmLabel: "Закрыть без сохранения" })))
        return;
    }
    onClose();
  }

  // Живая оценка стоимости при правке (43-й проход, п.1 обзора) — тот же
  // принцип, что и в CreateRentalModal, но проще: PATCH .../rentals/{id}
  // (app/api/routes/rentals.py:edit_rental) НЕ подставляет скидку по
  // умолчанию сама, всегда берёт то, что явно передано в форме (см.
  // handleSubmit ниже — Number(discount) || 0), так что превью здесь без
  // веток на default_discount_percent клиента.
  const previewDays = endDate >= startDate ? spanDays(startDate, endDate) : 0;
  const previewBase =
    previewDays > 0
      ? checkedIds.reduce((sum, id) => {
          const eq = equipment.find((e) => e.id === id);
          return eq ? sum + equipmentCostForDays(eq, previewDays) : sum;
        }, 0)
      : 0;
  const previewDiscount = Number(discount) || 0;
  const previewExtraFee = Number(extraFee) || 0;
  const previewTotal = Math.max(0, previewBase + previewExtraFee - previewDiscount);

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
        // Доп. услуги — ВСЕГДА отправляем текущее значение полей формы явно
        // (не undefined), включая случай "поле очищено" — extra_fee_note
        // должно уйти как "" (не отсутствовать в теле запроса), чтобы
        // backend понял, что подпись явно стёрли, а не просто не тронули
        // (см. RentalEdit.extra_fee_note в app/schemas/inventory.py).
        extra_fee: Number(extraFee) || 0,
        extra_fee_note: extraFeeNote.trim(),
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
      onRequestClose={requestClose}
      afterForm={discardDialog}
      onSubmit={handleSubmit}
      submitLabel={saving ? "Сохранение…" : "Сохранить"}
      wide
      error={error}
      footerExtra={previewDays > 0 && checkedIds.length > 0 ? `К оплате: ${money(previewTotal)}` : undefined}
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
      {/* Без style={{ marginTop: -8 }} — этот отрицательный отступ ничем не
          компенсировался (у .field-row нет собственного margin-bottom) и
          физически затягивал текст подсказки на 8px внутрь полей дат выше
          (обратная связь по карточке аренды, 48-й проход; подтверждено
          локальным Playwright-замером getBoundingClientRect). Без
          переопределения остаётся обычный margin-top: 4px у .field-hint,
          как и у всех остальных подсказок под полями. */}
      {isActive && (
        <div className="field-hint">
          Дата начала зафиксирована: оборудование уже выдано клиенту.
        </div>
      )}
      <div className="field">
        <label>Оборудование{checkedIds.length > 0 ? ` — выбрано: ${checkedIds.length}` : ""}</label>
        <EquipmentPicklist
          items={equipment}
          start={startDate}
          end={endDate}
          rentals={rentals}
          excludeRentalId={rental.id}
          checkedIds={checkedIds}
          onToggle={toggle}
          onClearAll={() => setCheckedIds([])}
          alwaysShowIds={currentIds}
          businessId={businessId}
        />
        <div className="field-hint">Занятые на выбранные даты позиции недоступны для выбора.</div>
      </div>
      <div className="field">
        <label>Скидка, ₽ (по договорённости)</label>
        <input type="number" min={0} value={discount} placeholder="0" onChange={(e) => setDiscount(e.target.value)} />
      </div>
      <div className="field-row">
        <div className="field">
          <label>Доп. услуги, ₽ (необязательно)</label>
          <input type="number" min={0} value={extraFee} onChange={(e) => setExtraFee(e.target.value)} placeholder="0" />
        </div>
        <div className="field">
          <label>За что</label>
          <input
            type="text"
            maxLength={200}
            value={extraFeeNote}
            onChange={(e) => setExtraFeeNote(e.target.value)}
            placeholder="Например, доставка"
          />
        </div>
      </div>
      {previewDays > 0 && checkedIds.length > 0 && (
        <div className="summary-box summary-box-outcome">
          <div className="summary-row">
            <span>Аренда, {previewDays} дн.</span>
            <span className="v">{money(previewBase)}</span>
          </div>
          {previewExtraFee > 0 && (
            <div className="summary-row">
              <span>{extraFeeNote.trim() ? `Доп. услуги — ${extraFeeNote.trim()}` : "Доп. услуги"}</span>
              <span className="v">{money(previewExtraFee)}</span>
            </div>
          )}
          {previewDiscount > 0 && (
            <div className="summary-row">
              <span>Скидка</span>
              <span className="v">−{money(previewDiscount)}</span>
            </div>
          )}
          <div className="summary-row total">
            <span>Ориентировочно к оплате</span>
            <span className="v">{money(previewTotal)}</span>
          </div>
        </div>
      )}
    </FormModal>
  );
}

/* ---------- Быстрое продление (41-й проход) ---------- */
/**
 * Отдельная от EditRentalModal форма — там правится ВСЁ сразу (даты,
 * состав оборудования, скидка) и это осознанный полный набор полей "Изменить
 * аренду". Для самого частого случая — "клиент попросил ещё на пару дней" —
 * не нужно открывать весь этот набор и заново отмечать те же чекбоксы
 * оборудования: RentalEdit на backend'е (app/schemas/inventory.py) — все
 * поля опциональны, так что PATCH с одним end_date полностью безопасен и не
 * трогает остальные поля аренды. Открывается из RentalDetailPanel.tsx (кнопка
 * "Продлить") и из "Ещё" на самой карточке — RentalDetailPanel специально
 * НЕ делает сам PATCH-запрос (см. докстринг файла), а делегирует сюда через
 * onExtend, чтобы вся логика правки аренды жила в одном месте.
 */
function ExtendRentalModal({
  businessId,
  rental,
  client,
  rentals,
  onClose,
  onSaved,
}: {
  businessId: string;
  rental: Rental;
  client: Client | undefined;
  rentals: Rental[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [endDate, setEndDate] = useState(isoAddDays(rental.end_date, 7));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (endDate <= rental.end_date) {
      setError("Новая дата окончания должна быть позже текущей.");
      return;
    }
    const conflict = rental.items
      .map((it) => conflictEndFor(it.equipment_id, rental.start_date, endDate, rentals, rental.id))
      .find((until) => until != null);
    if (conflict) {
      setError(`Часть оборудования уже забронирована на новый период (занято до ${fmtDate(conflict)}) — выберите более раннюю дату.`);
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/businesses/${businessId}/rentals/${rental.id}`, { end_date: endDate });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось продлить аренду");
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormModal
      title={`Продлить аренду — ${client?.name ?? "—"}`}
      open
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel={saving ? "Сохранение…" : "Продлить"}
      error={error}
    >
      <div className="field">
        <label>Текущая дата окончания</label>
        <div style={{ padding: "9px 11px", background: "var(--surface-2)", borderRadius: 8, fontSize: 13.5, fontWeight: 600 }}>
          {fmtDate(rental.end_date)}
        </div>
      </div>
      <div className="field">
        <label>Новая дата окончания</label>
        <input type="date" value={endDate} min={isoAddDays(rental.end_date, 1)} onChange={(e) => setEndDate(e.target.value)} />
      </div>
      <div className="field-hint">Состав оборудования и скидка не меняются — только дата.</div>
    </FormModal>
  );
}

/* ---------- Отменить аренду (43-й проход, п.5 обзора) ---------- */
/**
 * Раньше "Отменить" сразу вызывал generic useConfirm() (да/нет, без полей
 * ввода) — причину нельзя было указать, хотя backend (POST .../cancel,
 * body: RentalCancel | None) её уже принимает и пишет в журнал (см.
 * RentalHistorySection.tsx — entryDetails, case "cancel"). Отдельная
 * маленькая форма вместо расширения useConfirm полем ввода: useConfirm —
 * общий на десяток разных да/нет-подтверждений по всему приложению,
 * прикручивать к нему один текстовый инпут ради одного сценария было бы
 * менее точечным изменением, чем отдельная модалка на существующем
 * FormModal (тот же паттерн, что ExtendRentalModal чуть выше).
 */
function CancelRentalModal({
  businessId,
  rental,
  client,
  onClose,
  onCancelled,
}: {
  businessId: string;
  rental: Rental;
  client: Client | undefined;
  onClose: () => void;
  onCancelled: () => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const trimmed = reason.trim();
      await api.post(`/businesses/${businessId}/rentals/${rental.id}/cancel`, trimmed ? { reason: trimmed } : undefined);
      await onCancelled();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось отменить аренду");
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormModal
      title={`Отменить аренду — ${client?.name ?? "—"}`}
      open
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel={saving ? "Отмена…" : "Отменить аренду"}
      danger
      error={error}
    >
      <div className="field">
        <label>Причина отмены (необязательно)</label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Клиент передумал, нашёл дешевле у конкурента…"
        />
      </div>
      <div className="field-hint">Причина попадёт в журнал изменений аренды — видна только сотрудникам.</div>
    </FormModal>
  );
}

/* ---------- Массовое напоминание (43-й проход, п.6 обзора) ---------- */
/**
 * Список выбранных аренд с кнопками WhatsApp/почта на КАЖДУЮ строку отдельно
 * — намеренно НЕ один "разослать всем" клик: и wa.me, и mailto: — это
 * переход по ссылке в новой вкладке/почтовом клиенте, который требует
 * пользовательского жеста на каждый вызов (браузеры блокируют несколько
 * одновременных window.open()/переходов по сгенерированному в JS клику без
 * прямого клика пользователя как всплывающие окна). Текст сообщения и сама
 * ссылка — переиспользование buildRentalSummaryText/normalizePhoneDigits из
 * clients/summary.ts и clients/helpers.ts, тех же, что уже использует
 * одиночная кнопка "Написать клиенту" в RentalDetailPanel.tsx — одна
 * формула сводки на все три места (детали аренды, карточка клиента, массовая
 * рассылка).
 */
function BulkReminderModal({
  rentals,
  clients,
  equipment,
  onClose,
}: {
  rentals: Rental[];
  clients: Client[];
  equipment: Equipment[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const rows = rentals
    .map((r) => ({ rental: r, client: clients.find((c) => c.id === r.client_id) }))
    .filter((x): x is { rental: Rental; client: Client } => !!x.client && !!(x.client.phone || x.client.email));

  return (
    <dialog id="modal" ref={ref} onClose={onClose} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-head">
        <h3>Напомнить клиентам ({rows.length})</h3>
        <button className="icon-btn" onClick={onClose} type="button">
          <IconClose />
        </button>
      </div>
      <div className="modal-body">
        {rows.length === 0 ? (
          <div className="empty-note">
            У выбранных аренд нет клиентов с телефоном или почтой — отправить напоминание некому.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {rows.map(({ rental, client }) => (
              <div
                key={rental.id}
                className="summary-box"
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{client.name}</div>
                  <div style={{ color: "var(--muted)", fontSize: "12.5px" }}>
                    {fmtDate(rental.start_date)} — {fmtDate(rental.end_date)} · {money(rental.total)}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "6px" }}>
                  {client.phone && (
                    <button
                      className="btn btn-sm"
                      type="button"
                      onClick={() =>
                        window.open(
                          `https://wa.me/${normalizePhoneDigits(client.phone)}?text=${encodeURIComponent(
                            buildRentalSummaryText(rental, client, equipment)
                          )}`,
                          "_blank",
                          "noreferrer"
                        )
                      }
                    >
                      WhatsApp
                    </button>
                  )}
                  {client.email && (
                    <button
                      className="btn btn-sm"
                      type="button"
                      onClick={() => {
                        window.location.href = `mailto:${client.email}?subject=${encodeURIComponent(
                          "Информация по аренде"
                        )}&body=${encodeURIComponent(buildRentalSummaryText(rental, client, equipment))}`;
                      }}
                    >
                      Почта
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose} type="button">
          Закрыть
        </button>
      </div>
    </dialog>
  );
}

/* ---------- Массовое продление (43-й проход, п.8 обзора) ---------- */
/**
 * В отличие от ExtendRentalModal (одна аренда — проверка конфликта по
 * каждой её позиции через conflictEndFor до отправки), здесь одна дата
 * применяется сразу к нескольким разным арендам через Promise.allSettled —
 * предварительно проверять конфликт по всем позициям всех аренд разом
 * избыточно (backend и так отклонит конкретный PATCH при конфликте, см.
 * edit_rental), а allSettled уже даёт честный подсчёт "скольким реально
 * удалось продлить", как и handleBulkCancel чуть выше по файлу.
 */
function BulkExtendModal({
  businessId,
  rentals,
  onClose,
  onDone,
}: {
  businessId: string;
  rentals: Rental[];
  onClose: () => void;
  onDone: (result: { ok: number; failed: number }) => Promise<void>;
}) {
  const latestCurrentEnd = rentals.reduce((max, r) => (r.end_date > max ? r.end_date : max), rentals[0]?.end_date ?? todayISO());
  const [endDate, setEndDate] = useState(isoAddDays(latestCurrentEnd, 7));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (endDate <= latestCurrentEnd) {
      setError("Новая дата окончания должна быть позже текущей даты окончания у всех выбранных аренд.");
      return;
    }
    setSaving(true);
    try {
      const results = await Promise.allSettled(
        rentals.map((r) => api.patch(`/businesses/${businessId}/rentals/${r.id}`, { end_date: endDate }))
      );
      const failed = results.filter((res) => res.status === "rejected").length;
      await onDone({ ok: rentals.length - failed, failed });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormModal
      title={`Продлить аренды (${rentals.length})`}
      open
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel={saving ? "Сохранение…" : "Продлить все"}
      error={error}
    >
      <div className="field">
        <label>Новая дата окончания</label>
        <input type="date" value={endDate} min={isoAddDays(latestCurrentEnd, 1)} onChange={(e) => setEndDate(e.target.value)} />
      </div>
      <div className="field-hint">
        Применится ко всем выбранным арендам ({rentals.length}) — состав оборудования и скидка не меняются. Если у части
        оборудования на новый период уже есть конфликт с другой бронью, для соответствующей аренды продление не пройдёт — об
        этом будет сказано в итоговом сообщении.
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
              <span className="mono" title={itemRateLabelTitle(it)}>
                {itemRateLabel(it)}
              </span>
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
  onOpenClient,
  onOpenEquipment,
  onOpenCalendar,
}: {
  businessId: string;
  search: string;
  filter: string;
  setFilter: (f: string) => void;
  // Открыть карточку клиента с дашборд-уровня (39-й проход) — тот же
  // кросс-вкладочный механизм dashClientId/setDashClientId, что уже
  // используют DashboardTab и ClientsTab (см. Dashboard.tsx), нужен здесь
  // для кнопки "Карточка клиента" внутри RentalDetailPanel.
  onOpenClient: (clientId: string) => void;
  // То же самое для оборудования (40-й проход, по итогам обзора панели
  // деталей аренды) — dashEquipmentId/setDashEquipmentId, нужен для клика
  // по позиции в разделе "Оборудование" внутри RentalDetailPanel.
  onOpenEquipment: (equipmentId: string) => void;
  // Перейти на вкладку "Календарь" и сразу показать даты этой аренды
  // (42-й проход, п.5 обзора) — навигация с переключением View живёт в
  // Dashboard.tsx (navigate(...) + calendarFocus), сюда приходит только
  // дата, на которую нужно перепрыгнуть.
  onOpenCalendar: (date: string) => void;
}) {
  const { equipment, clients, rentals, reloadRentals, reloadEquipment } = useData();
  // usePersistedState — девятнадцатый проход, п.4 обзора «Оборудования»:
  // сортировка переживает обновление страницы (та же механика, что и в
  // EquipmentTab, отдельно на каждый businessId).
  const [sort, setSort] = usePersistedState(`rentals-sort:${businessId}`, "date");
  const [riskOnly, setRiskOnly] = useState(false);
  // "Истекает скоро" (39-й проход, доработки по итогам обзора) — тот же
  // порог daysLeft<=2, что уже красит карточку жёлтым бейджем ниже
  // (soonBadge), но раньше это можно было увидеть только пролистывая весь
  // список "В работе" глазами; теперь это ещё и фильтруемый переключатель,
  // тем же паттерном, что riskOnly.
  const [expiringOnly, setExpiringOnly] = useState(false);
  // Индикатор "депозит не возвращён" (43-й проход, п.2 обзора) — для уже
  // закрытых (возвращённых) аренд с ненулевым депозитом, у которых
  // deposit_returned_at ещё не проставлен (см. чекбокс в
  // RentalDetailPanel.tsx, 42-й проход): раньше единственный способ это
  // заметить — открыть карточку каждой закрытой аренды по очереди, тут же
  // видно сразу в списке, тем же паттерном, что riskOnly/expiringOnly.
  const [depositDueOnly, setDepositDueOnly] = useState(false);
  // "Не оплачено" (46-й проход, по итогам обзора — "чего не хватает на
  // главной странице") — тот же паттерн переключателя, что и три выше, см.
  // isUnpaid.
  const [unpaidOnly, setUnpaidOnly] = useState(false);
  // Дропдаун "Фильтры" (46-й проход, по итогам обзора — "Клиенты"/
  // "Оборудование" собирают редкие/переключаемые фильтры в один дропдаун
  // с чекбоксами вместо отдельных кнопок в ряду; три круглые icon-only
  // кнопки здесь были единственным местом в приложении с другой
  // стилизацией фильтров). Тот же idiom, что moreFiltersOpen/Ref в
  // ClientsTab.tsx — клик вне панели закрывает её.
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const moreFiltersRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreFiltersOpen) return;
    function onDocClick(e: MouseEvent) {
      if (moreFiltersRef.current && !moreFiltersRef.current.contains(e.target as Node)) setMoreFiltersOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [moreFiltersOpen]);
  // "Рискованные клиенты" — отдельная кнопка на первой строке (по просьбе
  // пользователя, скриншот), не входит в дропдаун "Фильтры" и его счётчик.
  const moreFiltersActiveCount = (expiringOnly ? 1 : 0) + (depositDueOnly ? 1 : 0) + (unpaidOnly ? 1 : 0);
  const [showCreate, setShowCreate] = useState(false);
  // Предзаполнение "Новой аренды" клиентом+позициями текущей (41-й проход,
  // "Повторить аренду" из RentalDetailPanel) — null при обычном открытии
  // кнопкой "+ Новая аренда", тогда форма пустая, как раньше.
  const [repeatDraft, setRepeatDraft] = useState<{ clientId: string; equipmentIds: string[] } | null>(null);
  const [editRental, setEditRental] = useState<Rental | null>(null);
  const [issueRental, setIssueRental] = useState<Rental | null>(null);
  const [returnRental, setReturnRental] = useState<Rental | null>(null);
  // Быстрая запись оплаты прямо с карточки списка (49-й проход, по итогам
  // обзора списка "Аренды" — "нужен ли механизм записи оплаты не открывая
  // панель деталей"), тем же принципом, что editRental/returnRental выше —
  // сама модалка (PaymentModal) экспортирована из RentalDetailPanel.tsx, где
  // и продолжает жить основная реализация (используется и там, и здесь).
  const [paymentRental, setPaymentRental] = useState<Rental | null>(null);
  const [extendRental, setExtendRental] = useState<Rental | null>(null);
  const [cancelRental, setCancelRental] = useState<Rental | null>(null);
  const [openRentalId, setOpenRentalId] = useState<string | null>(null);
  const [docModal, setDocModal] = useState<{ title: string; node: ReactNode } | null>(null);
  // Массовые действия по списку аренд (42-й проход, п.3 обзора) — карточки,
  // в отличие от табличных ClientsTab/EquipmentTab, ЧЕКБОКСЫ ПОКАЗЫВАЮТ
  // ТОЛЬКО в режиме выбора (selectMode), а не постоянно: список карточек и
  // так плотный (даты/сумма/бейджи/кнопки), лишний чекбокс на каждой в
  // обычном режиме просмотра был бы шумом без пользы большую часть времени.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Массовое напоминание (43-й проход, п.6 обзора) — список аренд для
  // BulkReminderModal, а не булев флаг: сама модалка не пересчитывает
  // "выбранные сейчас" заново (после закрытия selectedIds может уже
  // измениться), список фиксируется в момент открытия.
  const [reminderRentals, setReminderRentals] = useState<Rental[] | null>(null);
  // Массовое продление (43-й проход, п.8 обзора) — тот же принцип, что и
  // reminderRentals выше: список фиксируется на момент открытия модалки, а
  // не выбирается заново из selectedIds/rentals при каждом рендере.
  const [bulkExtendRentals, setBulkExtendRentals] = useState<Rental[] | null>(null);
  // Раскрытие блока "старые закрытые" (43-й проход, п.9) — по умолчанию
  // свёрнут, см. isOldClosed/oldClosed ниже.
  const [showOldClosed, setShowOldClosed] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { notify } = useToast();

  function toggleSelectMode() {
    setSelectMode((v) => !v);
    setSelectedIds(new Set());
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Базовый список (статус-сегмент + поиск, БЕЗ трёх переключателей ниже) —
  // выделен отдельно (46-й проход), чтобы посчитать, сколько аренд попадёт
  // под каждый переключатель дропдауна "Фильтры", тем же принципом, что
  // dormantCount/birthdayCount в ClientsTab.tsx (счётчик — "сколько найдётся,
  // если включить именно этот", а не "сколько уже видно с учётом него же").
  const bySearch = rentals.filter((r) => {
    const st = rentalDisplayStatus(r);
    const statusOk = filter === "all" ? true : filter === "active" ? st === "active" || st === "overdue" : st === filter;
    if (!statusOk) return false;

    const client = clients.find((c) => c.id === r.client_id);
    const names = r.items.map((it) => equipment.find((e) => e.id === it.equipment_id)?.name ?? "").join(" ");
    // Поиск теперь захватывает и заметки при выдаче/возврате (39-й проход,
    // п.5 обзора) — раньше можно было найти аренду только по клиенту/
    // оборудованию, хотя в заметках нередко записано что-то по-настоящему
    // уникальное для конкретной сделки ("оставил в залог паспорт", "просил
    // доставку к 9 утра"). И номер договора (43-й проход, п.7) — тот же
    // короткий номер, что напечатан на договоре/актах (docNumber), клиент
    // по телефону обычно называет именно его, а не своё полное имя.
    const haystack = [client?.name ?? "", names, r.issue_notes ?? "", r.return_notes ?? "", docNumber(r)]
      .join(" ")
      .toLowerCase();
    // Поиск по телефону клиента (49-й проход, по итогам обзора списка
    // "Аренды" — "звонит клиент, и первое, что есть под рукой — номер, а не
    // имя"). Отдельная, цифровая проверка, а не просто добавление
    // client.phone в haystack выше: телефон хранится с форматированием
    // ("+7 900 000-00-00"), и посимвольный поиск не находил бы номер, если
    // ввести его без пробелов/дефисов — normalizePhoneDigits (та же
    // функция, что уже нормализует ввод в ClientsTab.tsx) сравнивает только
    // цифры с обеих сторон. searchDigits.length > 0 обязателен — иначе
    // пустая строка (когда в запросе вообще нет цифр, например "костыли")
    // оказалась бы "подстрокой" любого номера и пропускала бы всё подряд.
    let searchDigits = search.replace(/\D/g, "");
    // Ведущая "8" → "7" — та же замена, что formatPhoneInput (lib/format.ts)
    // уже делает при ВВОДЕ телефона в поле клиента, поэтому все сохранённые
    // номера в базе начинаются на 7. Без этой же замены здесь поиск по
    // привычному "8900…" (а не "+7900…") ничего бы не находил — цифры
    // совпадали бы кроме самой первой.
    if (searchDigits[0] === "8" && searchDigits.length <= 11) searchDigits = "7" + searchDigits.slice(1);
    const matchesPhone = searchDigits.length > 0 && normalizePhoneDigits(client?.phone).includes(searchDigits);
    if (search && !haystack.includes(search.toLowerCase()) && !matchesPhone) return false;

    return true;
  });
  const expiringCount = bySearch.filter((r) => rentalDisplayStatus(r) === "active" && dayDiff(r.end_date) <= 2).length;
  const depositDueCount = bySearch.filter(isDepositDue).length;
  const unpaidCount = bySearch.filter(isUnpaid).length;

  const list = bySearch.filter((r) => {
    const client = clients.find((c) => c.id === r.client_id);
    // Живой рейтинг (клиент "на контроле" вычисляется по текущей
    // просрочке — см. clientDisplayRating), а не сырое client.rating: до
    // исправления в 39-м проходе фильтр ловил только формальный чёрный
    // список, но не текущую просрочку, из-за чего реально рискованные
    // клиенты в него не попадали.
    if (riskOnly && (!client || clientDisplayRating(client, rentals) === "normal")) return false;

    if (expiringOnly && !(rentalDisplayStatus(r) === "active" && dayDiff(r.end_date) <= 2)) return false;

    if (depositDueOnly && !isDepositDue(r)) return false;

    if (unpaidOnly && !isUnpaid(r)) return false;

    return true;
  });

  const sorted = [...list].sort((a, b) => {
    if (sort === "amount") return b.total - a.total;
    if (sort === "debt") return b.total - b.paid_amount - (a.total - a.paid_amount);
    if (sort === "client") {
      const ca = clients.find((c) => c.id === a.client_id)?.name ?? "";
      const cb = clients.find((c) => c.id === b.client_id)?.name ?? "";
      return ca.localeCompare(cb, "ru");
    }
    return b.start_date.localeCompare(a.start_date);
  });

  // Свёрнутые по умолчанию старые завершённые аренды (43-й проход, п.9
  // обзора) — список рос неограниченно (аренды никогда физически не
  // удаляются), и через несколько месяцев работы бизнеса он становится
  // длинным и тяжёлым для скролла/рендера, при том что "Возвращено"/
  // "Отменено" месячной-двух давности почти никогда не открывают повторно.
  // "Возраст" считается от даты фактического закрытия: actual_return для
  // возвращённых (если возврат ещё не проставлен — от end_date, как раньше
  // делал общий сорт), created_at для отменённых (у отменённой брони
  // end_date мог быть и в будущем — важна дата САМОЙ отмены, а не
  // несостоявшегося периода). Работает поверх любого фильтра — свернутся,
  // только когда список и правда содержит старые закрытые записи.
  const OLD_CLOSED_DAYS = 30;
  function isOldClosed(r: Rental): boolean {
    if (r.status === "returned") return -dayDiff(r.actual_return || r.end_date) > OLD_CLOSED_DAYS;
    if (r.status === "cancelled") return -dayDiff(r.created_at.slice(0, 10)) > OLD_CLOSED_DAYS;
    return false;
  }
  const visibleSorted = sorted.filter((r) => !isOldClosed(r));
  const oldClosed = sorted.filter(isOldClosed);

  function openDoc(title: string, node: ReactNode) {
    setDocModal({ title, node });
  }

  /** Печать договоров пачкой (42-й проход, п.3 обзора) — один DocModal,
   * несколько .doc-page подряд с разрывом страницы между ними (см.
   * page-break-after в styles.css), а не поочерёдная печать каждого
   * договора отдельно. */
  function handleBulkContracts() {
    const chosen = sorted.filter((r) => selectedIds.has(r.id));
    if (chosen.length === 0) return;
    openDoc(
      `Договоры (${chosen.length} шт.)`,
      buildBulkContractsDoc(
        chosen.map((r) => ({ rental: r, client: clients.find((c) => c.id === r.client_id) })),
        equipment
      )
    );
  }

  /** Массовая отмена (42-й проход, п.3 обзора) — только для брони (status
   * "booked"), тот же принцип, что и у одиночной кнопки "Отменить" на
   * карточке выше: она тоже видна ТОЛЬКО у забронированных аренд, "В
   * работе"/"Возвращена" через список массово не отменяются (для активной
   * аренды отмена — редкое, требующее внимания действие с откатом статуса
   * оборудования, для неё нарочно оставлена только одиночная кнопка на
   * карточке в явном контексте, не пакетная операция вслепую по списку).
   */
  async function handleBulkCancel() {
    const chosen = sorted.filter((r) => selectedIds.has(r.id));
    const cancellable = chosen.filter((r) => r.status === "booked");
    const skipped = chosen.length - cancellable.length;
    if (cancellable.length === 0) return;
    if (
      !(await confirm(`Отменить ${cancellable.length} брон${cancellable.length === 1 ? "ь" : "и"}?`, {
        danger: true,
        confirmLabel: "Отменить",
      }))
    )
      return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(
        cancellable.map((r) => api.post(`/businesses/${businessId}/rentals/${r.id}/cancel`))
      );
      const failed = results.filter((res) => res.status === "rejected").length;
      await Promise.all([reloadRentals(), reloadEquipment()]);
      setSelectedIds(new Set());
      const parts = [
        `Отменено ${cancellable.length - failed} из ${cancellable.length}.`,
        skipped > 0 ? `Пропущено (не бронь): ${skipped}.` : "",
        failed > 0 ? `Ошибок: ${failed}.` : "",
      ].filter(Boolean);
      notify(parts.join(" "), failed > 0 ? "error" : "info");
    } finally {
      setBulkBusy(false);
    }
  }

  /** Открывает BulkExtendModal только для реально продлеваемых аренд
   * (status="active" — то же самое множество, что и "В работе"/"Просрочено"
   * в rentalDisplayStatus, см. статус-бейджи выше): "Возвращено"/"Отменено"/
   * "Забронировано" продлевать бессмысленно — брони переносят через "Изменить",
   * а не через "Продлить". */
  function handleBulkExtendOpen() {
    const chosen = sorted.filter((r) => selectedIds.has(r.id));
    const extendable = chosen.filter((r) => r.status === "active");
    const skipped = chosen.length - extendable.length;
    if (extendable.length === 0) {
      notify("Среди выбранных нет аренд в статусе «В аренде»/«Просрочено» — продлевать нечего.");
      return;
    }
    if (skipped > 0) {
      notify(`В продление войдут только аренды в статусе «В аренде»/«Просрочено» (${extendable.length} из ${chosen.length}).`);
    }
    setBulkExtendRentals(extendable);
  }

  // Карточка аренды — вынесена в функцию (43-й проход, п.9 обзора), а не
  // инлайн-колбэк внутри одного .map(): теперь рендерится ДВУМЯ разными
  // списками (visibleSorted и — только если развёрнут блок "старые
  // закрытые" — oldClosed), см. JSX ниже. Само тело/разметка карточки не
  // менялись, только вынесены в отдельную функцию.
  function renderCard(r: Rental): ReactNode {
    const client = clients.find((c) => c.id === r.client_id);
    const st = rentalDisplayStatus(r);
    const daysLeft = dayDiff(r.end_date);
    const soonBadge: StatusMeta | null =
      st === "active" && daysLeft <= 2
        ? { label: daysLeft <= 0 ? "Истекает сегодня" : `Осталось ${daysLeft} дн.`, tone: "warning" }
        : null;
    // Группировка одинаковых позиций с количеством (49-й проход, обратная
    // связь по списку "Аренды" — "Подлокотные костыли, Подлокотные костыли"
    // вместо "Подлокотные костыли ×2"). Map сохраняет порядок первого
    // появления имени — порядок строки не "прыгает" по сравнению со старым
    // .map().join(", ") при том же составе позиций.
    const itemNameCounts = new Map<string, number>();
    for (const it of r.items) {
      const name = equipment.find((e) => e.id === it.equipment_id)?.name ?? "—";
      itemNameCounts.set(name, (itemNameCounts.get(name) ?? 0) + 1);
    }
    const itemNames = [...itemNameCounts.entries()]
      .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
      .join(", ");
    // Прогресс частичного возврата (41-й проход) — видно на самой
    // карточке, не открывая панель деталей: если часть позиций уже
    // вернулась отдельно (RentalDetailPanel → "Вернуть выбранное"), а
    // часть всё ещё у клиента, аренда по-прежнему "В аренде"/"Просрочено"
    // целиком — без этого бейджа непонятно, что возврат уже частично идёт.
    const returnedCount = r.items.filter((it) => it.returned_at).length;
    const partialBadge: StatusMeta | null =
      r.status === "active" && returnedCount > 0 && returnedCount < r.items.length
        ? { label: `Возвращено ${returnedCount}/${r.items.length}`, tone: "info" }
        : null;
    const depositBadge: StatusMeta | null = isDepositDue(r) ? { label: "Депозит не возвращён", tone: "warning" } : null;
    // Бейдж оплаты (46-й проход, доработан в 49-м) — тем же принципом, что
    // depositBadge выше: виден только когда есть о чём предупредить (реально
    // не хватает денег), а не на каждой карточке подряд. "частично" отличает
    // случай, когда что-то уже внесли, от полного нуля — сотруднику это важно
    // видеть с одного взгляда на список, не открывая карточку.
    //
    // 49-й проход, по итогам обзора списка "Аренды": раньше бейдж был
    // бинарным ("Не оплачено"/"Оплата частично") без суммы — приходилось
    // открывать карточку, чтобы узнать остаток долга. Теперь сумма прямо в
    // бейдже. Тон сменён с "warning" на "critical" — по тому же обзору,
    // "Не оплачено" и "Осталось N дн." (soonBadge выше) визуально сливались
    // в одну и ту же тёплую жёлтую гамму, хотя это разные по срочности вещи:
    // долг — финансовая проблема, срок — просто напоминание. tone-critical
    // уже используется для "Просрочено"/"Чёрный список" (см. statusMeta.tsx)
    // — тот же язык тревожности, а не новый цвет.
    const debt = r.total - r.paid_amount;
    // Title-подсказка с разбивкой (49-й проход, по итогам обзора) — при
    // частичной оплате в самом бейдже видно только остаток, а сколько уже
    // внесено — только открыв карточку. Подсказка при наведении показывает
    // то же "оплачено N из M", что и в панели деталей, без удлинения бейджа.
    const paymentBadge: StatusMeta | null = isUnpaid(r)
      ? {
          label: r.paid_amount > 0 ? `Долг ${money(debt)}` : `Не оплачено: ${money(debt)}`,
          tone: "critical",
          title: r.paid_amount > 0 ? `Оплачено ${money(r.paid_amount)} из ${money(r.total)}` : undefined,
        }
      : null;

    return (
      // Карточка кликабельна целиком — открывает RentalDetailPanel (39-й
      // проход; раньше это было отложено TODO'шкой, ждавшей общего
      // механизма "открыть клиента" между вкладками — он появился ещё в
      // 25-м проходе для ClientsTab/DashboardTab, здесь просто наконец
      // подключён). Кнопки внутри .rental-actions останавливают
      // всплытие (stopPropagation ниже), чтобы клик по ним не открывал
      // панель поверх уже выполняемого действия.
      <div
        className="rental-card clickable"
        key={r.id}
        onClick={() => (selectMode ? toggleSelected(r.id) : setOpenRentalId(r.id))}
      >
        <div className="rental-main">
          <div className="rental-top">
            {selectMode && (
              <input
                type="checkbox"
                checked={selectedIds.has(r.id)}
                onChange={() => toggleSelected(r.id)}
                onClick={(e) => e.stopPropagation()}
                style={{ width: "16px", height: "16px" }}
              />
            )}
            <span className="rental-client">{client?.name ?? "Клиент удалён"}</span>
            <Badge meta={RENTAL_META[st]} />
            {/* Долг — сразу после статуса, перед сроком/депозитом (49-й
                проход, по итогам обзора списка "Аренды" — единственный
                красный (critical) бейдж в ряду раньше стоял последним и
                терялся при нескольких бейджах на карточке; самое тревожное
                должно быть видно первым). */}
            {paymentBadge && <Badge meta={paymentBadge} />}
            {soonBadge && <Badge meta={soonBadge} />}
            {partialBadge && <Badge meta={partialBadge} />}
            {depositBadge && <Badge meta={depositBadge} />}
          </div>
          <div className="rental-items">{itemNames}</div>
          <div className="rental-meta">
            <span>
              {fmtDateRange(r.start_date, r.end_date)}
              {r.actual_return ? " · возврат " + fmtDate(r.actual_return) : ""}
            </span>
            <span className="amount-mono mono">{money(r.total)}</span>
          </div>
        </div>

        {/* Клик по кнопкам не должен всплывать до карточки — в демо это было
            бесплатно за счёт делегирования через closest() на уровне всего
            документа (обработчик разбирал event.target независимо от того,
            где именно во вложенной разметке произошёл клик). Теперь у
            самой карточки есть onClick (открывает RentalDetailPanel, см.
            выше) — stopPropagation здесь обязателен, иначе, например,
            клик по "Отменить" ещё и открывал бы панель деталей поверх
            диалога подтверждения. */}
        <div className="rental-actions" onClick={(e) => e.stopPropagation()}>
          {r.status === "booked" && (
            <>
              <button className="btn btn-primary btn-sm" type="button" onClick={() => setIssueRental(r)}>
                Выдать
              </button>
              <button className="btn btn-sm" type="button" onClick={() => setEditRental(r)}>
                <IconEdit /> Изменить
              </button>
              <button className="btn btn-danger-ghost btn-sm" type="button" onClick={() => setCancelRental(r)}>
                Отменить
              </button>
            </>
          )}
          {r.status === "active" && (
            <>
              {/* Приоритет главной кнопки по контексту (49-й проход, по
                  итогам обзора списка "Аренды" — "Принять возврат" была
                  главной кнопкой всегда, даже когда за аренду не заплачено, а
                  самым вероятным следующим шагом скорее является запись
                  оплаты). Если есть долг — "Записать оплату" становится
                  главной (btn-primary), "Принять возврат" — второстепенной;
                  без долга порядок и вид кнопок остаются прежними. */}
              {isUnpaid(r) ? (
                <>
                  <button className="btn btn-primary btn-sm" type="button" onClick={() => setPaymentRental(r)}>
                    Записать оплату
                  </button>
                  <button className="btn btn-sm" type="button" onClick={() => setReturnRental(r)}>
                    Принять возврат
                  </button>
                </>
              ) : (
                <button className="btn btn-primary btn-sm" type="button" onClick={() => setReturnRental(r)}>
                  Принять возврат
                </button>
              )}
              <button className="btn btn-sm" type="button" onClick={() => setEditRental(r)}>
                <IconEdit /> Изменить
              </button>
            </>
          )}
          {/* Печать (акты/договор) — под "Ещё" (40-й проход, по итогам
              обзора: раньше три отдельные кнопки-принтера растягивали
              столбец действий заметно выше основного текста карточки).
              "Договор" доступен всегда, вне зависимости от статуса —
              тот же список, что был раньше безусловной кнопкой ниже
              всех остальных. */}
          <MoreActionsMenu
            align="right"
            actions={[
              // Быстрое продление (41-й проход) — под "Ещё", а не отдельной
              // кнопкой в основном ряду: тот же принцип декомпозиции, что
              // уже применён к печати актов ниже — часто нужны только
              // Выдать/Принять возврат/Изменить, продление реже.
              ...(r.status === "active"
                ? [
                    {
                      key: "extend",
                      label: "Продлить",
                      icon: <IconEdit />,
                      onClick: () => setExtendRental(r),
                    },
                  ]
                : []),
              ...(r.status === "active"
                ? [
                    {
                      key: "issue-doc",
                      label: "Акт выдачи",
                      icon: <IconPrinter />,
                      onClick: () => openDoc("Акт приёма-передачи", buildIssueDoc(r, client, equipment)),
                    },
                  ]
                : []),
              ...(r.status === "returned"
                ? [
                    {
                      key: "return-doc",
                      label: "Акт возврата",
                      icon: <IconPrinter />,
                      onClick: () => openDoc("Акт возврата", buildReturnDoc(r, client, equipment)),
                    },
                  ]
                : []),
              {
                key: "contract-doc",
                label: "Договор",
                icon: <IconPrinter />,
                onClick: () => openDoc("Договор аренды", buildContractDoc(r, client, equipment)),
              },
            ]}
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="tab-toolbar-grid">
        {/* Левый кластер: две строки (45-й проход, по итогам обзора верхней
            части "Аренды"/"Клиенты"/"Оборудование" разом; 46-й проход —
            фикс регрессии + перестановка). "align-items: flex-start" на
            колоночном флекс-контейнере обязателен: без него у флекс-детей
            действует значение по умолчанию "stretch" — сегменты (div
            .segmented, сам по себе inline-flex и должен занимать только
            свою ширину) как флекс-item колоночного родителя растягивались
            на всю ширину строки, вместе с собственной серой рамкой/фоном
            .segmented — рамка "заливала" всю строку до конца, а не только
            область вокруг вкладок. Ровно то, на что жаловался пользователь
            (скриншот) — эта же поправка нужна и в ClientsTab.tsx, там та
            же причина.

            "Рискованные клиенты" — отдельная icon-only круглая кнопка на
            первой строке, рядом с сегментами статусов (через
            .toolbar-divider — тот же приём, что и "Недавние" на
            ClientsTab.tsx), в точности как до 46-го прохода — только эта
            кнопка вернулась к прежнему виду, остальные две (истекает скоро/
            депозит) остались в дропдауне "Фильтры" по просьбе пользователя.
            Дропдаун "Фильтры" — на второй строке, ПЕРЕД сортировкой
            (перестановка по просьбе пользователя, скриншот). */}
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", alignItems: "flex-start" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <div className="segmented">
              {FILTERS.map((f) => (
                <button key={f.id} type="button" className={filter === f.id ? "active" : ""} onClick={() => setFilter(f.id)}>
                  {f.label}
                </button>
              ))}
            </div>
            <div className="toolbar-divider" />
            {/* icon-only (41-й проход, возвращено в 46-м после короткого
                эксперимента с текстовой кнопкой) — title/aria-label и так
                объясняют смысл кнопки при наведении. */}
            <button
              type="button"
              className={"btn btn-icon-only" + (riskOnly ? " btn-primary" : "")}
              title="Показать только клиентов «на контроле» или из чёрного списка"
              aria-label="Только рискованные"
              onClick={() => setRiskOnly((v) => !v)}
            >
              <IconAlert />
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            {/* Дропдаун "Фильтры" (46-й проход) — тот же .cat-filter*-idiom,
                счётчики — из expiringCount/depositDueCount/unpaidCount выше
                (сколько найдётся по базовому списку — статус+поиск, — если
                включить именно этот переключатель). "Рискованные" сюда не
                входят — у них своя круглая кнопка на первой строке. Порядок
                "Фильтры" → сортировка (по просьбе пользователя, скриншот). */}
            <div className="cat-filter" ref={moreFiltersRef}>
              <button
                type="button"
                className={"btn cat-filter-btn" + (moreFiltersActiveCount > 0 ? " btn-primary" : "")}
                onClick={() => setMoreFiltersOpen((v) => !v)}
              >
                {moreFiltersActiveCount === 0 ? "Фильтры" : `Фильтры: ${moreFiltersActiveCount}`}
                <IconChevronDown />
              </button>
              {moreFiltersOpen && (
                <div className="cat-filter-panel">
                  <label className={"cat-filter-option" + (expiringOnly ? " checked" : "")}>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={expiringOnly}
                      onChange={() => setExpiringOnly((v) => !v)}
                    />
                    <span className="cat-filter-check">{expiringOnly && <IconCheck />}</span>
                    <span className="cat-filter-name" title="Аренды в работе, которые истекают в ближайшие 2 дня">
                      <IconCalendar width={14} height={14} /> Истекает скоро
                    </span>
                    <span className="cat-filter-count">{expiringCount}</span>
                  </label>
                  <label className={"cat-filter-option" + (depositDueOnly ? " checked" : "")}>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={depositDueOnly}
                      onChange={() => setDepositDueOnly((v) => !v)}
                    />
                    <span className="cat-filter-check">{depositDueOnly && <IconCheck />}</span>
                    <span className="cat-filter-name" title="Закрытые аренды с невозвращённым депозитом">
                      <IconShield width={14} height={14} /> Депозит не возвращён
                    </span>
                    <span className="cat-filter-count">{depositDueCount}</span>
                  </label>
                  <label className={"cat-filter-option" + (unpaidOnly ? " checked" : "")}>
                    <input type="checkbox" className="sr-only" checked={unpaidOnly} onChange={() => setUnpaidOnly((v) => !v)} />
                    <span className="cat-filter-check">{unpaidOnly && <IconCheck />}</span>
                    <span className="cat-filter-name" title="Оплачено меньше, чем начислено на данный момент">
                      <IconFinance width={14} height={14} /> Не оплачено
                    </span>
                    <span className="cat-filter-count">{unpaidCount}</span>
                  </label>
                </div>
              )}
            </div>
            <Dropdown
              value={sort}
              onChange={setSort}
              placeholder={SORTS[0]?.label ?? ""}
              options={SORTS.map((s) => ({ value: s.id, label: s.label }))}
            />
          </div>
        </div>
        {/* Колонка кнопок в .tab-toolbar-grid — тот же фикс, что и в
            ClientsTab.tsx/EquipmentTab.tsx (30-й проход): держит эту
            группу у верхнего правого угла независимо от переноса строк
            слева (см. styles.css, .tab-toolbar-grid). Теперь тут ровно тот
            же состав, что и у "Оборудования"/"Клиентов" — "Ещё" и основная
            кнопка действия (плюс временная "Готово" в активном режиме
            выбора, см. ниже) — а не семь вперемешку с фильтрами. */}
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <MoreActionsMenu
            actions={[
              {
                key: "export",
                label: "Экспорт CSV",
                onClick: () => exportRentalsCsv(sorted, clients, equipment),
              },
              // Массовые действия (42-й проход, п.3 обзора) — точка ВХОДА в
              // режим выбора спрятана в "Ещё", пока он выключен (та же
              // логика, что у "Настроить столбцы" в EquipmentTab.tsx: не
              // рядовое ежедневное действие, как "+ Новая аренда"). Пока
              // включён — пункт меню убран, выход из режима ("Готово")
              // вынесен в открытую ниже: спрятанный выход из активного
              // режима неочевиден.
              ...(selectMode ? [] : [{ key: "select", label: "Выбрать", onClick: toggleSelectMode }]),
            ]}
          />
          {selectMode && (
            <button type="button" className="btn btn-primary" onClick={toggleSelectMode}>
              Готово
            </button>
          )}
          <button className="btn btn-primary" type="button" onClick={() => setShowCreate(true)}>
            + Новая аренда
          </button>
        </div>
      </div>

      {selectMode && (
        <div className="panel" style={{ marginBottom: "10px" }}>
          <div className="panel-body" style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <strong>Выбрано: {selectedIds.size}</strong>
            <button
              className="btn btn-sm"
              type="button"
              disabled={selectedIds.size === 0}
              // Только видимые сейчас карточки (43-й проход, п.9 обзора) —
              // свёрнутые "старые закрытые" ниже списка не попадают в выбор
              // молча, иначе "Выбрано: N" разошлось бы с тем, что реально
              // отмечено галочками на экране.
              onClick={() => setSelectedIds(new Set((showOldClosed ? sorted : visibleSorted).map((r) => r.id)))}
            >
              Выбрать все ({(showOldClosed ? sorted : visibleSorted).length})
            </button>
            <button
              className="btn btn-sm"
              type="button"
              disabled={selectedIds.size === 0 || bulkBusy}
              onClick={handleBulkContracts}
            >
              <IconPrinter /> Договоры пачкой
            </button>
            <button
              className="btn btn-sm"
              type="button"
              disabled={selectedIds.size === 0 || bulkBusy}
              onClick={() => setReminderRentals(sorted.filter((r) => selectedIds.has(r.id)))}
            >
              <IconMessages /> Напомнить
            </button>
            <button
              className="btn btn-sm"
              type="button"
              disabled={selectedIds.size === 0 || bulkBusy}
              onClick={handleBulkExtendOpen}
            >
              <IconCalendar /> Продлить (выбранные)
            </button>
            <button
              className="btn btn-sm btn-danger-ghost"
              type="button"
              disabled={selectedIds.size === 0 || bulkBusy}
              onClick={() => void handleBulkCancel()}
            >
              Отменить бронь (выбранные)
            </button>
            <button className="btn btn-sm" type="button" disabled={bulkBusy} onClick={() => setSelectedIds(new Set())}>
              Снять выделение
            </button>
          </div>
        </div>
      )}

      {/* Напоминание о включённом переключателе (41-й проход, по итогам
          обзора) — раньше единственным признаком был подсвеченный
          btn-primary в тулбаре, который легко потерять из виду, прокрутив
          длинный список вниз: непонятно, список правда короткий или просто
          отфильтрован. Полоска над самим списком, у самых карточек —
          труднее пропустить, чем кнопку в тулбаре наверху. "Сбросить" одним
          кликом снимает оба переключателя разом. */}
      {(riskOnly || expiringOnly || depositDueOnly) && (
        <div className="active-filter-bar">
          <IconAlert />
          <span>
            Показаны только{" "}
            {[
              riskOnly && "рискованные клиенты",
              expiringOnly && "аренды, истекающие скоро",
              depositDueOnly && "закрытые аренды с невозвращённым депозитом",
            ]
              .filter(Boolean)
              .join(" и ")}
          </span>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setRiskOnly(false);
              setExpiringOnly(false);
              setDepositDueOnly(false);
            }}
          >
            Сбросить
          </button>
        </div>
      )}

      {visibleSorted.map(renderCard)}

      {oldClosed.length > 0 && (
        <div className="panel" style={{ marginTop: "10px" }}>
          <div className="panel-body" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span className="field-hint" style={{ margin: 0 }}>
              {showOldClosed
                ? `Показаны старые завершённые аренды (${oldClosed.length}, закрыты более ${OLD_CLOSED_DAYS} дн. назад).`
                : `Скрыто старых завершённых аренд: ${oldClosed.length} (закрыты более ${OLD_CLOSED_DAYS} дн. назад).`}
            </span>
            <button className="btn btn-sm" type="button" onClick={() => setShowOldClosed((v) => !v)}>
              {showOldClosed ? "Свернуть" : "Показать"}
            </button>
          </div>
        </div>
      )}

      {showOldClosed && oldClosed.map(renderCard)}

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
          initialClientId={repeatDraft?.clientId}
          initialEquipmentIds={repeatDraft?.equipmentIds}
          onClose={() => {
            setShowCreate(false);
            setRepeatDraft(null);
          }}
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
            // Предложить записать оплату остатка (49-й проход, по итогам
            // обзора списка "Аренды" — "приём возврата и оплата остатка —
            // два отдельных действия, а в жизни клиент чаще платит именно
            // в момент возврата"). Сам эндпоинт /return не меняется и
            // платёж не собирает — это просто удобный переход ко второму,
            // отдельному шагу (та же PaymentModal, что и кнопка "Записать
            // оплату" на карточке), если после возврата долг всё ещё есть.
            if (isUnpaid(updated)) {
              const remaining = updated.total - updated.paid_amount;
              if (
                await confirm(`Остался долг ${money(remaining)} — записать оплату?`, {
                  confirmLabel: "Записать оплату",
                })
              ) {
                setPaymentRental(updated);
              }
            }
          }}
        />
      )}

      {/* Быстрая запись оплаты с карточки списка (49-й проход) — та же
          PaymentModal, что и внутри RentalDetailPanel, см. импорт вверху
          файла. onPaid перезагружает только аренды — статья долга (total/
          paid_amount) считается на backend'е и приходит уже готовой в
          Rental, оборудование этот платёж не затрагивает. */}
      {paymentRental && (
        <PaymentModal
          businessId={businessId}
          rental={paymentRental}
          onClose={() => setPaymentRental(null)}
          onPaid={async () => {
            await reloadRentals();
          }}
        />
      )}

      {extendRental && (
        <ExtendRentalModal
          businessId={businessId}
          rental={extendRental}
          client={clients.find((c) => c.id === extendRental.client_id)}
          rentals={rentals}
          onClose={() => setExtendRental(null)}
          onSaved={async () => {
            await reloadRentals();
          }}
        />
      )}

      {cancelRental && (
        <CancelRentalModal
          businessId={businessId}
          rental={cancelRental}
          client={clients.find((c) => c.id === cancelRental.client_id)}
          onClose={() => setCancelRental(null)}
          onCancelled={async () => {
            await Promise.all([reloadRentals(), reloadEquipment()]);
          }}
        />
      )}

      {reminderRentals && (
        <BulkReminderModal
          rentals={reminderRentals}
          clients={clients}
          equipment={equipment}
          onClose={() => setReminderRentals(null)}
        />
      )}

      {bulkExtendRentals && (
        <BulkExtendModal
          businessId={businessId}
          rentals={bulkExtendRentals}
          onClose={() => setBulkExtendRentals(null)}
          onDone={async ({ ok, failed }) => {
            await Promise.all([reloadRentals(), reloadEquipment()]);
            setSelectedIds(new Set());
            notify(
              failed > 0 ? `Продлено ${ok} из ${ok + failed}. Ошибок: ${failed}.` : `Продлено аренд: ${ok}.`,
              failed > 0 ? "error" : "info"
            );
          }}
        />
      )}

      <DocModal title={docModal?.title ?? ""} open={!!docModal} onClose={() => setDocModal(null)}>
        {docModal?.node}
      </DocModal>

      {/* Слайдовер деталей аренды (39-й проход) — тот же приём, что и
          слайдовер клиента/оборудования с дашборда: затемнённый фон + панель
          поверх текущей вкладки, закрывается кликом по фону или крестиком. */}
      {openRentalId && <div className="slideover-backdrop" onClick={() => setOpenRentalId(null)} />}
      {openRentalId && (
        <RentalDetailPanel
          businessId={businessId}
          rentalId={openRentalId}
          onClose={() => setOpenRentalId(null)}
          // Карточка клиента/оборудования (обратная связь пользователя,
          // 43-й проход — "закрыл карточку клиента, а карточка аренды тоже
          // закрылась"): раньше здесь стоял setOpenRentalId(null) перед
          // открытием — панель клиента/оборудования рендерится в
          // Dashboard.tsx отдельным слайдовером ПОВЕРХ этого (тот же
          // z-index, но позже в DOM), так что оставлять openRentalId как
          // есть — этого достаточно, чтобы после закрытия верхней панели
          // снова стала видна карточка аренды под ней, без отдельного
          // стека "куда вернуться".
          onOpenClient={(clientId) => onOpenClient(clientId)}
          onOpenEquipment={(equipmentId) => onOpenEquipment(equipmentId)}
          // Продление (41-й проход) НЕ закрывает панель — быстрое действие,
          // после которого логично остаться на месте и увидеть обновлённые
          // даты в самой панели (rentals перечитываются из контекста).
          onExtend={(rentalId) => {
            const r = rentals.find((x) => x.id === rentalId);
            if (r) setExtendRental(r);
          }}
          // Выдать/Принять возврат/Изменить/Отменить (повторный обзор — "из
          // панели деталей ничего не сделать") — тот же принцип, что и
          // onExtend выше: панель не закрывается, статус/бейджи обновятся в
          // ней же после reloadRentals() внутри соответствующей модалки.
          onIssue={(rentalId) => {
            const r = rentals.find((x) => x.id === rentalId);
            if (r) setIssueRental(r);
          }}
          onReturn={(rentalId) => {
            const r = rentals.find((x) => x.id === rentalId);
            if (r) setReturnRental(r);
          }}
          onEdit={(rentalId) => {
            const r = rentals.find((x) => x.id === rentalId);
            if (r) setEditRental(r);
          }}
          onCancel={(rentalId) => {
            const r = rentals.find((x) => x.id === rentalId);
            if (r) setCancelRental(r);
          }}
          // "Повторить аренду" открывает форму как нативный <dialog> — она
          // и так рендерится в top layer браузера поверх слайдовера (тот же
          // принцип, что и onEdit/onExtend и т.п. выше: не трогаем
          // openRentalId, обратная связь 43-го прохода). Раньше панель
          // закрывалась перед открытием формы, и после отмены формы
          // карточка аренды пропадала целиком.
          onRepeat={(clientId, equipmentIds) => {
            setRepeatDraft({ clientId, equipmentIds });
            setShowCreate(true);
          }}
          // Переход в "Календарь" — тоже уводит с вкладки "Аренды" целиком,
          // тот же принцип закрытия панели, что и выше.
          onOpenCalendar={(date) => {
            setOpenRentalId(null);
            onOpenCalendar(date);
          }}
        />
      )}

      {confirmDialog}
    </div>
  );
}
