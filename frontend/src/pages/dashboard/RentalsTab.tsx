import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../api/client";
import { useData } from "../../context/DataContext";
import type { Rental } from "../../api/types";
import { money, fmtDate, fmtDateRange, dayDiff } from "../../lib/format";
import { RENTAL_META, Badge, rentalDisplayStatus, type StatusMeta } from "../../lib/statusMeta";
import {
  IconPrinter,
  IconEdit,
  IconAlert,
  IconCalendar,
  IconChevronDown,
  IconCheck,
  IconShield,
  IconMessages,
  IconFinance,
} from "../../lib/icons";
import { DocModal, buildContractDoc, buildIssueDoc, buildReturnDoc, buildBulkContractsDoc } from "./documents";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { usePersistedState } from "../../lib/persist";
import { Dropdown } from "../../components/Dropdown";
import { MoreActionsMenu } from "../../components/MoreActionsMenu";
import { clientDisplayRating, normalizePhoneDigits } from "./clients/helpers";
import { docNumber, isDepositDue, isUnpaid } from "./rentals/helpers";
import { exportRentalsCsv } from "./rentals/csv";
import { RentalDetailPanel, PaymentModal } from "./rentals/RentalDetailPanel";
import { CreateRentalModal } from "./rentals/CreateRentalModal";
import { EditRentalModal } from "./rentals/EditRentalModal";
import { ExtendRentalModal } from "./rentals/ExtendRentalModal";
import { CancelRentalModal } from "./rentals/CancelRentalModal";
import { BulkReminderModal } from "./rentals/BulkReminderModal";
import { BulkExtendModal } from "./rentals/BulkExtendModal";
import { IssueRentalModal } from "./rentals/IssueRentalModal";
import { ReturnRentalModal } from "./rentals/ReturnRentalModal";

// CreateRentalModal ре-экспортируется из ./rentals/CreateRentalModal без
// изменений — единственный внешний потребитель, Dashboard.tsx, импортирует
// его именно отсюда (import { RentalsTab, CreateRentalModal } from
// "./dashboard/RentalsTab") и не требует правок (тот же приём, что и
// EquipmentDetailPanel в EquipmentTab.tsx / ClientDetailPanel в
// ClientsTab.tsx).
export { CreateRentalModal };

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
 *
 * 52-й проход — файл разнесён по модулям в папке ./rentals/, по образцу
 * round 23/29 (EquipmentTab.tsx/ClientsTab.tsx): было 2730 строк, здесь
 * остались только константы фильтров/сортировки и сам компонент RentalsTab
 * (список, фильтры, сортировка, экспорт CSV, печать документов). Все формы
 * (создание/правка/продление/отмена/массовые действия/выдача/возврат),
 * FormModal (общий каркас) и EquipmentPicklist (мультивыбор оборудования)
 * — в отдельных файлах в ./rentals/, каждый со своим набором импортов.
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
      {/* unpaidOnly добавлен в полоску 50-м проходом (по итогам всестороннего
          обзора вкладки "Аренды") — тот же переключатель "Не оплачено" живёт
          в том же дропдауне "Фильтры", что и depositDueOnly/expiringOnly, но
          раньше не учитывался ни в тексте полоски, ни в "Сбросить" — при
          включённом только unpaidOnly полоска не появлялась вовсе, хотя
          список так же фильтровался. */}
      {(riskOnly || expiringOnly || depositDueOnly || unpaidOnly) && (
        <div className="active-filter-bar">
          <IconAlert />
          <span>
            Показаны только{" "}
            {[
              riskOnly && "рискованные клиенты",
              expiringOnly && "аренды, истекающие скоро",
              depositDueOnly && "закрытые аренды с невозвращённым депозитом",
              unpaidOnly && "неоплаченные аренды",
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
              setUnpaidOnly(false);
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
