/**
 * Вкладка «Клиенты» — 38-й проход разнёс этот файл (было 3600+ строк) по
 * отдельным модулям в папке ./clients/ (форма, детали, журнал, документы,
 * импорт/корзина/слияние, CSV, мелкие хелперы) — по тому же образцу, что и
 * EquipmentTab.tsx в 22-м проходе (см. докстринг там же). Здесь остались
 * только список/фильтрация/сортировка/массовые действия и сам компонент
 * ClientsTab. ClientDetailPanel ре-экспортируется из ./clients/ClientDetailPanel
 * НИЖЕ по файлу без изменений — единственный внешний потребитель,
 * Dashboard.tsx, импортирует его именно отсюда и не требует правок.
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";
import { useData } from "../../context/DataContext";
import type { Client } from "../../api/types";
import { Badge, rentalDisplayStatus } from "../../lib/statusMeta";
import { initials, formatPhoneInput } from "../../lib/format";
import {
  IconCheck,
  IconTrash,
  IconEdit,
  IconGift,
  IconSliders,
  IconGrip,
  IconEye,
  IconEyeOff,
  IconChevronDown,
} from "../../lib/icons";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { usePersistedState } from "../../lib/persist";
import { MoreActionsMenu } from "../../components/MoreActionsMenu";
import { Dropdown } from "../../components/Dropdown";
import {
  EMPTY_CLIENT_FORM,
  formFromClient,
  clientFormToPayload,
  type ClientFormState,
} from "./clients/formHelpers";
import { ClientFormModal } from "./clients/ClientFormModal";
import { ClientImportModal } from "./clients/ClientImportModal";
import { ClientTrashModal } from "./clients/ClientTrashModal";
import { exportClientsCsv } from "./clients/csv";
import { findPossibleDuplicate } from "./clients/duplicates";
import {
  CLIENT_TOGGLEABLE_COLUMN_IDS,
  DEFAULT_CLIENT_COLUMNS_PREFS,
  DORMANT_DAYS_THRESHOLD,
  RATING_FILTERS,
  VALUE_TIER_META,
  clientDisplayRating,
  clientHasOpenRental,
  clientHasOverdueNow,
  clientLifetimeRevenue,
  computeClientValueTiers,
  isBirthdayThisWeek,
  isDormantClient,
  isIncompleteProfile,
  lastRentalDate,
  renderClientCell,
  sortClientList,
  visibleClientColumns,
  type ClientCellContext,
  type ClientColumnsPrefs,
  type ClientSort,
} from "./clients/helpers";
import { ClientDetailPanel } from "./clients/ClientDetailPanel";

export { ClientDetailPanel };

export function ClientsTab({
  businessId,
  search,
  onCreateRental,
}: {
  businessId: string;
  search: string;
  // Необязательный — прокидывается с уровня DashboardShell (см. Dashboard.tsx),
  // где живёт общая глобальная модалка "Новая аренда" (25-й проход, п.1
  // обзора: кнопка из карточки клиента, без перехода на вкладку "Аренды").
  onCreateRental?: (clientId: string) => void;
}) {
  const { clients, rentals, reloadClients } = useData();
  const [sort, setSort] = usePersistedState<ClientSort>(`client-sort:${businessId}`, { key: null, dir: "asc" });
  const [ratingFilter, setRatingFilter] = useState("all");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [dormantOnly, setDormantOnly] = useState(false);
  // 26-й проход, «глазами обычного пользователя», п.4: фильтр по дням
  // рождения на этой неделе — тем же принципом, что и dormantOnly выше.
  const [birthdayOnly, setBirthdayOnly] = useState(false);
  // Панель "Фильтры" (30-й проход — пользователь заметил, что "Не арендовали
  // N+ дней" и "Дни рождения" нарушают согласованность со страницей
  // «Оборудование», где нет подобных доп. тумблеров). В отличие от
  // "Просрочка сейчас" (нужна каждый день — оставлена отдельной кнопкой,
  // это клиентский аналог статуса "Просрочено" на «Оборудовании»), эти два
  // фильтра нужны раз в одну-две недели, поэтому свёрнуты в один компактный
  // дропдаун с чекбоксами — тот же .cat-filter* idiom, что и у фильтров
  // категорий/складов на «Оборудовании» (EquipmentTab.tsx). Сами данные и
  // счётчики никуда не делись, просто не занимают место в первом ряду.
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
  const moreFiltersActiveCount = (dormantOnly ? 1 : 0) + (birthdayOnly ? 1 : 0);
  const [modalMode, setModalMode] = useState<"add" | "edit" | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [openClientId, setOpenClientId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkRating, setBulkRating] = useState("");
  // Массовое добавление тега (26-й проход, проф. обзор, п.7) — отдельное
  // текстовое поле от bulkRating выше, оба массовых действия применяются
  // независимо друг от друга к одному и тому же выделению.
  const [bulkTag, setBulkTag] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [showImport, setShowImport] = useState(false);
  // Корзина (29-й проход, п.14 обзора) — тем же принципом, что и showImport
  // выше: модалка сама грузит свой список при открытии, не тащим его в
  // общий DataContext.
  const [showTrash, setShowTrash] = useState(false);
  // Настройка столбцов таблицы (29-й проход, п.11 обзора) — 1:1 перенесённое
  // из EquipmentTab.tsx состояние (columnsPrefs БЕЗ businessId в ключе — см.
  // докстринг ClientColumnsPrefs в clients/helpers.ts, personal browser
  // preference, а не данные бизнеса).
  const [columnsPrefs, setColumnsPrefs] = usePersistedState<ClientColumnsPrefs>(
    "client-columns-v1",
    DEFAULT_CLIENT_COLUMNS_PREFS
  );
  const [columnsEditMode, setColumnsEditMode] = useState(false);
  const clientColumns = visibleClientColumns(columnsPrefs);

  function toggleColumnHidden(key: string) {
    setColumnsPrefs((prev) => {
      const hidden = prev.hidden.includes(key) ? prev.hidden.filter((k) => k !== key) : [...prev.hidden, key];
      return { ...prev, hidden };
    });
  }

  function moveColumn(dragged: string, target: string) {
    if (!dragged || !target || dragged === target) return;
    setColumnsPrefs((prev) => {
      const known = prev.order.filter((id) => CLIENT_TOGGLEABLE_COLUMN_IDS.includes(id));
      const extra = CLIENT_TOGGLEABLE_COLUMN_IDS.filter((id) => !known.includes(id));
      const order = known.concat(extra);
      const from = order.indexOf(dragged);
      const to = order.indexOf(target);
      if (from === -1 || to === -1) return prev;
      order.splice(from, 1);
      order.splice(to, 0, dragged);
      return { ...prev, order };
    });
  }
  // "Недавно просмотренные" (26-й проход, «глазами обычного пользователя»,
  // п.7) — id последних открытых карточек, per-бизнес, тем же persisted-
  // механизмом, что и sort выше. Храним максимум RECENT_CLIENTS_LIMIT штук,
  // самые новые в начале.
  const [recentIds, setRecentIds] = usePersistedState<string[]>(`client-recent:${businessId}`, []);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { confirm: confirmBulk, dialog: bulkConfirmDialog } = useConfirm();
  const { confirm: confirmDuplicate, dialog: duplicateDialog } = useConfirm();
  const { notify } = useToast();

  const q = search.trim().toLowerCase();
  // Поиск теперь заглядывает и в заметку, не только в имя/телефон/email/
  // документ (24-й проход, п.3 обзора: значимая информация о клиенте часто
  // осядет именно в заметке).
  const bySearch = clients.filter(
    (c) =>
      !q ||
      (
        c.name +
        " " +
        (c.phone ?? "") +
        " " +
        (c.email ?? "") +
        " " +
        (c.doc ?? "") +
        " " +
        (c.notes ?? "") +
        " " +
        (c.tags ?? "") +
        " " +
        (c.contact_person ?? "")
      )
        .toLowerCase()
        .includes(q)
  );
  // Счётчики на кнопках рейтинга считаются от уже применённого поиска, но НЕ
  // от самого фильтра рейтинга — тот же принцип, что и statusCounts в
  // EquipmentTab.tsx (иначе на остальных кнопках всегда было бы "0").
  const ratingCounts: Record<string, number> = { all: bySearch.length };
  for (const f of RATING_FILTERS) {
    if (f.id === "all") continue;
    ratingCounts[f.id] = bySearch.filter((c) => clientDisplayRating(c, rentals) === f.id).length;
  }
  // Уровень ценности считается по ВСЕМ клиентам бизнеса (не по bySearch/
  // byRating) — см. комментарий у computeClientValueTiers: иначе бейдж
  // "прыгал" бы при смене поиска/фильтра.
  const valueTiers = computeClientValueTiers(clients, rentals);
  const byRating = bySearch.filter((c) => ratingFilter === "all" || clientDisplayRating(c, rentals) === ratingFilter);
  const overdueNowCount = byRating.filter((c) => clientHasOverdueNow(c.id, rentals)).length;
  const dormantCount = byRating.filter((c) => isDormantClient(c.id, rentals)).length;
  const birthdayCount = byRating.filter((c) => isBirthdayThisWeek(c.birthday)).length;
  const withFilters = byRating
    .filter((c) => !overdueOnly || clientHasOverdueNow(c.id, rentals))
    .filter((c) => !dormantOnly || isDormantClient(c.id, rentals))
    .filter((c) => !birthdayOnly || isBirthdayThisWeek(c.birthday));
  const list = sortClientList(withFilters, sort, rentals);
  const recentClients = recentIds.map((id) => clients.find((c) => c.id === id)).filter((c): c is Client => !!c);

  // Сброс выделения при смене фильтров/поиска — тот же принцип, что и в
  // EquipmentTab.tsx: иначе массовое действие могло бы применяться к
  // строкам, которые сейчас не видны на экране.
  useEffect(() => {
    setSelectedIds(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratingFilter, overdueOnly, dormantOnly, birthdayOnly, search]);

  // 5 вместо прежних 8 (29-й проход, ещё один повторный обзор — "Недавние"
  // выглядели тяжеловесно) — это подсказка-ярлык для беглого взгляда, а не
  // ещё один список, который стоит сканировать целиком.
  const RECENT_CLIENTS_LIMIT = 5;
  function openClient(id: string) {
    setOpenClientId(id);
    setRecentIds((prev) => [id, ...prev.filter((x) => x !== id)].slice(0, RECENT_CLIENTS_LIMIT));
  }

  function toggleSort(key: string) {
    setSort((prev) => {
      if (prev.key === key) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
      return { key, dir: "asc" };
    });
  }

  function openAddModal() {
    setEditingId(null);
    setFormError(null);
    setModalMode("add");
  }

  function openEditModal(id: string) {
    setEditingId(id);
    setFormError(null);
    setModalMode("edit");
  }

  function closeFormModal() {
    setModalMode(null);
    setEditingId(null);
    setFormError(null);
  }

  async function handleSubmitForm(form: ClientFormState) {
    setFormError(null);
    try {
      if (modalMode === "edit" && editingId) {
        await api.patch(`/businesses/${businessId}/clients/${editingId}`, clientFormToPayload(form));
      } else {
        // Предупреждение о возможном дубле (24-й проход, п.3 обзора) — только
        // при добавлении нового клиента, не при правке существующего (там
        // совпадение с самим собой было бы ложным срабатыванием). Мягкое —
        // не блокирует, просто просит подтвердить осознанно.
        const dup = findPossibleDuplicate(form, clients);
        if (dup) {
          const reasonLabel =
            dup.reason === "phone"
              ? "совпадает телефон"
              : dup.reason === "name"
              ? "совпадает имя"
              : "похожее имя, возможно опечатка";
          const proceed = await confirmDuplicate(
            `Похожий клиент уже есть в базе: «${dup.client.name}»${dup.client.phone ? ` · ${dup.client.phone}` : ""} (${reasonLabel}). Всё равно добавить нового?`,
            { confirmLabel: "Добавить всё равно" }
          );
          if (!proceed) return;
        }
        const created = await api.post<Client>(`/businesses/${businessId}/clients`, clientFormToPayload(form));
        // Загрузка документов, прикреплённых ДО сохранения (37-й проход —
        // см. комментарий у pendingDocuments в clients/formHelpers.ts). До
        // этой строки клиента ещё не существовало на backend, поэтому
        // раньше грузить файлы было некуда — теперь есть created.id. Как и в
        // ClientDocumentsSection, по одному запросу на файл (не Promise.all)
        // и один неудачный файл не отменяет остальные — но, в отличие от
        // неё, здесь клиент к этому моменту уже точно сохранён, так что при
        // сбое части файлов не откатываем и не блокируем создание клиента,
        // просто мягко предупреждаем через notify() после закрытия модалки.
        if (form.pendingDocuments.length > 0) {
          let failed = 0;
          for (const file of form.pendingDocuments) {
            try {
              const body = new FormData();
              body.append("file", file);
              await api.postForm(`/businesses/${businessId}/clients/${created.id}/documents`, body);
            } catch {
              failed++;
            }
          }
          if (failed > 0) {
            notify(
              `Клиент сохранён, но не удалось загрузить файлов: ${failed} из ${form.pendingDocuments.length}. Прикрепите их из карточки клиента.`,
              "info"
            );
          }
        }
      }
      await reloadClients();
      closeFormModal();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Не удалось сохранить клиента");
    }
  }

  /** Удаление одного клиента — используется и кнопкой в строке таблицы, и
   * слайдовером (ClientDetailPanel.onDelete). Проверка открытой аренды ДО
   * подтверждения — тот же порядок, что и в EquipmentDetailPanel.handleDelete:
   * не тратим клик пользователя на подтверждение действия, которое backend
   * всё равно отклонит. 29-й проход, п.14 обзора: "удаление" теперь всегда
   * МЯГКОЕ (см. app/services/trash.py) — клиент уходит в корзину и
   * восстановим 30 дней. */
  async function handleDelete(id: string) {
    const client = clients.find((c) => c.id === id);
    if (clientHasOpenRental(id, rentals)) {
      notify("Нельзя удалить: у клиента есть аренда в работе или бронь. Сначала завершите её.");
      return;
    }
    if (
      !(await confirm(`Клиент «${client?.name ?? ""}» будет перемещён в корзину. Его можно восстановить в течение 30 дней.`, {
        danger: true,
        confirmLabel: "В корзину",
      }))
    )
      return;
    try {
      await api.delete(`/businesses/${businessId}/clients/${id}`);
      if (openClientId === id) setOpenClientId(null);
      await reloadClients();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось удалить");
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => (prev.size === list.length ? new Set() : new Set(list.map((c) => c.id))));
  }

  async function handleBulkRating() {
    if (!bulkRating || selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      const ids = [...selectedIds];
      const results = await Promise.allSettled(
        ids.map((id) => api.patch(`/businesses/${businessId}/clients/${id}`, { rating: bulkRating }))
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      await reloadClients();
      setBulkRating("");
      setSelectedIds(new Set());
      if (failed > 0) notify(`Рейтинг изменён у ${ids.length - failed} из ${ids.length}. Ошибок: ${failed}.`, "info");
    } finally {
      setBulkBusy(false);
    }
  }

  /** Массовое добавление тега (26-й проход, проф. обзор, п.7) — тег
   * ДОБАВЛЯЕТСЯ к уже имеющимся у каждого клиента, а не заменяет их (в
   * отличие от bulkRating выше, где "заменить" — единственный разумный
   * смысл для одиночного значения; у тегов, в отличие от рейтинга, у
   * клиента их обычно уже несколько, и массовое действие явно про
   * "добавить ещё один", а не "оставить только этот"). Дубли не создаются —
   * если тег уже есть у клиента, пропускается без отдельного запроса. */
  async function handleBulkTag() {
    const tag = bulkTag.trim();
    if (!tag || selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      const ids = [...selectedIds];
      const targets = ids
        .map((id) => clients.find((c) => c.id === id))
        .filter((c): c is Client => !!c)
        .filter((c) => !(c.tags ?? "").split(",").map((t) => t.trim()).includes(tag));
      const results = await Promise.allSettled(
        targets.map((c) => {
          const nextTags = [...(c.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean), tag].join(",");
          return api.patch(`/businesses/${businessId}/clients/${c.id}`, { tags: nextTags });
        })
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      await reloadClients();
      setBulkTag("");
      setSelectedIds(new Set());
      const skipped = ids.length - targets.length;
      if (failed > 0 || skipped > 0) {
        notify(
          `Тег добавлен у ${targets.length - failed} из ${ids.length}.` +
            (skipped > 0 ? ` Уже был у ${skipped}.` : "") +
            (failed > 0 ? ` Ошибок: ${failed}.` : ""),
          "info"
        );
      }
    } finally {
      setBulkBusy(false);
    }
  }

  /** Массовое удаление — клиенты с ОТКРЫТОЙ арендой/бронью пропускаются без
   * попытки удаления, тот же принцип, что и handleBulkDelete в
   * EquipmentTab.tsx. 29-й проход, п.14 обзора: удаление теперь мягкое (см.
   * комментарий у handleDelete выше) — клиентов с ЗАКРЫТОЙ историей аренд
   * больше не нужно заранее отфильтровывать, backend их принимает и уводит
   * в корзину. */
  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    const blocked = ids.filter((id) => clientHasOpenRental(id, rentals));
    const deletable = ids.filter((id) => !clientHasOpenRental(id, rentals));
    if (deletable.length === 0) {
      notify("Ни одного из выбранных клиентов нельзя удалить: у каждого есть аренда в работе или бронь.");
      return;
    }
    const message =
      blocked.length > 0
        ? `Будет перемещено в корзину клиентов: ${deletable.length} из ${ids.length}. Остальные ${blocked.length} пропущены — у них аренда в работе или бронь. Восстановить можно в течение 30 дней.`
        : `Будет перемещено в корзину клиентов: ${deletable.length}. Восстановить можно в течение 30 дней.`;
    if (!(await confirmBulk(message, { danger: true, confirmLabel: "В корзину" }))) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(deletable.map((id) => api.delete(`/businesses/${businessId}/clients/${id}`)));
      const failed = results.filter((r) => r.status === "rejected").length;
      await reloadClients();
      setSelectedIds(new Set());
      if (failed > 0 || blocked.length > 0) {
        notify(
          `Удалено: ${deletable.length - failed}.` +
            (failed > 0 ? ` Ошибок: ${failed}.` : "") +
            (blocked.length > 0 ? ` Пропущено (аренда в работе или бронь): ${blocked.length}.` : ""),
          "info"
        );
      }
    } finally {
      setBulkBusy(false);
    }
  }

  const editingClient = editingId ? clients.find((c) => c.id === editingId) ?? null : null;
  const formTitle = modalMode === "edit" ? "Изменить клиента" : "Новый клиент";
  const formInitial = modalMode === "edit" && editingClient ? formFromClient(editingClient) : EMPTY_CLIENT_FORM;

  return (
    <div>
      <div className="tab-toolbar-grid">
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <div className="segmented">
            {RATING_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={ratingFilter === f.id ? "active" : ""}
                onClick={() => setRatingFilter(f.id)}
              >
                {f.label} ({ratingCounts[f.id] ?? 0})
              </button>
            ))}
          </div>
          {/* Разделитель между сегментом рейтинга и группой доп. фильтров
              (32-й проход — обзор оформления: без него все три контрола в
              ряду выглядели одинаковыми пилюлями, хотя ведут себя по-разному
              — вкладки против независимых тумблеров/дропдауна). См.
              .toolbar-divider в styles.css. */}
          <div className="toolbar-divider" />
          {/* Группа "Просрочка сейчас" + "Фильтры" (31-й проход — "свежим
              взглядом" обзор всех кнопок разом): раньше "Просрочка сейчас"
              была на btn-sm (меньше и более округлая — пилюля 16px), а
              "Фильтры" — на .cat-filter-btn (выше и более прямоугольная —
              8px), из-за чего в одном ряду встречались три разных высоты
              кнопок (сегменты рейтинга, эта пара, "Ещё"/"+Добавить") — ряд
              выглядел "рябым". Обе теперь одной высоты (плюс обёрнуты в
              общий div БЕЗ собственного flexWrap — переносятся на новую
              строку только вдвоём, если не помещаются, а не порознь, как
              вышло с "Все категории"/"Все склады" на «Оборудовании»).
              "Просрочка сейчас" нужна каждый день (клиентский аналог
              статуса "Просрочено" на «Оборудовании») — отдельная кнопка.
              "Не арендовали"/"Дни рождения" нужны реже — свёрнуты в
              дропдаун "Фильтры", данные и счётчики никуда не делись. */}
          <div style={{ display: "flex", gap: "10px" }}>
            <button
              type="button"
              className={"btn" + (overdueOnly ? " btn-primary" : "")}
              onClick={() => setOverdueOnly((v) => !v)}
              title="Показать только клиентов с просрочкой прямо сейчас"
            >
              Просрочка сейчас ({overdueNowCount})
            </button>
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
                  <label className={"cat-filter-option" + (dormantOnly ? " checked" : "")}>
                    <input type="checkbox" className="sr-only" checked={dormantOnly} onChange={() => setDormantOnly((v) => !v)} />
                    <span className="cat-filter-check">{dormantOnly && <IconCheck />}</span>
                    <span
                      className="cat-filter-name"
                      title={`Клиенты, у которых была хотя бы одна аренда, но не за последние ${DORMANT_DAYS_THRESHOLD} дней — повод напомнить о себе`}
                    >
                      Не арендовали {DORMANT_DAYS_THRESHOLD}+ дней
                    </span>
                    <span className="cat-filter-count">{dormantCount}</span>
                  </label>
                  <label className={"cat-filter-option" + (birthdayOnly ? " checked" : "")}>
                    <input type="checkbox" className="sr-only" checked={birthdayOnly} onChange={() => setBirthdayOnly((v) => !v)} />
                    <span className="cat-filter-check">{birthdayOnly && <IconCheck />}</span>
                    <span
                      className="cat-filter-name"
                      title="Клиенты, у которых день рождения в ближайшие 7 дней — повод поздравить/предложить скидку"
                    >
                      <IconGift width={14} height={14} /> Дни рождения
                    </span>
                    <span className="cat-filter-count">{birthdayCount}</span>
                  </label>
                </div>
              )}
            </div>
          </div>
        </div>
        {/* Колонка кнопок в .tab-toolbar-grid (30-й проход — ещё один
            повторный обзор, "прибить Ещё/+Добавить к верхнему правому
            углу"): Grid-родитель (styles.css, .tab-toolbar-grid) резервирует
            под эту колонку место с самого начала и держит её у верхнего
            края — кнопки в углу, независимо от того, на сколько строк
            перенеслись фильтры слева. */}
        <div style={{ display: "flex", gap: "8px" }}>
          {/* Редкие служебные действия спрятаны за одной кнопкой "⋯ Ещё"
              (29-й проход, ещё один повторный обзор — "верхняя часть
              страницы перегружена кнопками"): настройку столбцов, импорт/
              экспорт CSV и корзину открывают не каждый день, в отличие от
              "+ Добавить" — незачем держать их все на виду тем же весом,
              что и главное действие. См. components/MoreActionsMenu.tsx. */}
          <MoreActionsMenu
            actions={[
              // "Настроить столбцы" — только точка ВХОДА в режим редактирования,
              // пока он выключен. Пока включён, кнопка выхода из него ("Готово")
              // намеренно вынесена из меню в открытую (см. ниже) — спрятанный
              // выход из активного режима редактирования неочевиден, а не
              // рядовое редкое действие вроде экспорта, поэтому исключение из
              // общего правила "прятать всё редкое" оправдано.
              ...(columnsEditMode
                ? []
                : [
                    {
                      key: "columns",
                      icon: <IconSliders />,
                      label: "Настроить столбцы",
                      onClick: () => setColumnsEditMode(true),
                    },
                  ]),
              { key: "import", label: "Импорт CSV", onClick: () => setShowImport(true) },
              {
                key: "export",
                label: "Экспорт CSV",
                onClick: () => exportClientsCsv(list, rentals),
                disabled: list.length === 0,
              },
              { key: "trash", icon: <IconTrash />, label: "Корзина", onClick: () => setShowTrash(true) },
            ]}
          />
          {columnsEditMode && (
            <button type="button" className="btn btn-primary" onClick={() => setColumnsEditMode(false)}>
              <IconSliders /> Готово
            </button>
          )}
          <button className="btn btn-primary" onClick={openAddModal}>
            + Добавить
          </button>
        </div>
      </div>

      {columnsEditMode && (
        <div className="panel" style={{ marginBottom: "10px" }}>
          <div className="panel-body">
            <div className="field-hint" style={{ marginBottom: "8px" }}>
              Перетащите карточку, чтобы изменить порядок столбцов, или нажмите на глаз, чтобы скрыть/показать. Столбец «Имя» всегда виден и всегда первый.
            </div>
            <div className="col-edit-row">
              {visibleClientColumns({ ...columnsPrefs, hidden: [] }).map((col) => {
                const hiddenCol = columnsPrefs.hidden.includes(col.key);
                return (
                  <div
                    key={col.key}
                    className={"dash-block-cell col-edit-chip" + (hiddenCol ? " dash-block-hidden" : "")}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", col.key);
                      e.dataTransfer.effectAllowed = "move";
                      e.currentTarget.classList.add("dragging");
                    }}
                    onDragEnd={(e) => e.currentTarget.classList.remove("dragging")}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      e.currentTarget.classList.add("drag-over");
                    }}
                    onDragLeave={(e) => e.currentTarget.classList.remove("drag-over")}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.currentTarget.classList.remove("drag-over");
                      const dragged = e.dataTransfer.getData("text/plain");
                      if (dragged) moveColumn(dragged, col.key);
                    }}
                  >
                    <div className="dash-handle">
                      <span className="dash-grip" title="Перетащите, чтобы изменить порядок">
                        <IconGrip />
                      </span>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => toggleColumnHidden(col.key)}
                        title={hiddenCol ? "Показать столбец" : "Скрыть столбец"}
                      >
                        {hiddenCol ? <IconEyeOff /> : <IconEye />}
                      </button>
                    </div>
                    <span className="col-edit-chip-label">{col.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* "Недавно просмотренные" (26-й проход, «глазами обычного
          пользователя», п.7) — быстрый доступ к последним открытым
          карточкам, для сотрудника, который весь день переключается между
          несколькими постоянными клиентами. Не показывается, пока ничего ещё
          не открывали, и не зависит от текущего поиска/фильтра — это ярлыки,
          а не ещё один список. Оформлены заметно тише самих кнопок-действий
          (29-й проход, ещё один повторный обзор — были такими же по весу,
          как настоящие кнопки; см. .chip-quiet в styles.css). */}
      {recentClients.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap", marginBottom: "10px" }}>
          <span style={{ color: "var(--muted)", fontSize: "12.5px", marginRight: "2px" }}>Недавние:</span>
          {recentClients.map((c) => (
            <button key={c.id} type="button" className="chip-quiet" onClick={() => openClient(c.id)}>
              {c.name}
            </button>
          ))}
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="panel" style={{ marginBottom: "10px" }}>
          <div className="panel-body" style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <strong>Выбрано: {selectedIds.size}</strong>
            {/* "На контроле" убран из выбора (29-й проход, п.6 обзора) — это
                больше не ручное значение, см. clientDisplayRating: рейтинг
                "на контроле" вычисляется сам по текущей просрочке. */}
            <Dropdown
              value={bulkRating}
              onChange={setBulkRating}
              placeholder="Изменить рейтинг…"
              disabled={bulkBusy}
              style={{ maxWidth: "200px" }}
              options={[
                { value: "normal", label: "Надёжный" },
                { value: "blacklist", label: "Чёрный список" },
              ]}
            />
            <button className="btn btn-sm" disabled={!bulkRating || bulkBusy} onClick={() => void handleBulkRating()}>
              Применить
            </button>
            {/* Массовое добавление тега (26-й проход) — отдельное поле от
                смены рейтинга выше, оба действия независимы. */}
            <input
              className="table-input"
              style={{ maxWidth: "160px" }}
              value={bulkTag}
              onChange={(e) => setBulkTag(e.target.value)}
              placeholder="Добавить тег…"
              disabled={bulkBusy}
            />
            <button className="btn btn-sm" disabled={!bulkTag.trim() || bulkBusy} onClick={() => void handleBulkTag()}>
              Добавить тег
            </button>
            <button className="btn btn-sm btn-danger-ghost" disabled={bulkBusy} onClick={() => void handleBulkDelete()}>
              Удалить выбранные
            </button>
            <button className="btn btn-sm" disabled={bulkBusy} onClick={() => setSelectedIds(new Set())}>
              Снять выделение
            </button>
          </div>
        </div>
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
                <th style={{ width: "1%" }}>
                  <input
                    type="checkbox"
                    checked={list.length > 0 && selectedIds.size === list.length}
                    onChange={toggleSelectAll}
                    title="Выбрать все"
                  />
                </th>
                {/* "Имя" — всегда первый и всегда виден, вне настройки
                    столбцов (см. CLIENT_TOGGLEABLE_COLUMN_IDS в
                    clients/helpers.ts). */}
                <th className={"sortable" + (sort.key === "name" ? " active" : "")} onClick={() => toggleSort("name")}>
                  Имя
                  <span className={"sort-arrow" + (sort.key === "name" ? "" : " sort-arrow-idle")}>
                    {sort.key === "name" ? (sort.dir === "desc" ? "▼" : "▲") : "↕"}
                  </span>
                </th>
                {clientColumns.map((col) => {
                  const active = sort.key === col.key;
                  return (
                    <th key={col.key} className={"sortable" + (active ? " active" : "")} onClick={() => toggleSort(col.key)}>
                      {col.label}
                      <span className={"sort-arrow" + (active ? "" : " sort-arrow-idle")}>
                        {active ? (sort.dir === "desc" ? "▼" : "▲") : "↕"}
                      </span>
                    </th>
                  );
                })}
                {/* row-actions на самом <th> — не только на <td> (33-й проход,
                    ремонт находки предыдущего прохода): в одном из браузеров
                    колонка с кнопками "Изменить"/"Удалить" схлопывалась до
                    нулевой ширины в состоянии покоя (opacity: 0). Явный width
                    на ОБЕИХ ячейках колонки (здесь и в styles.css) не
                    оставляет браузеру пространства для интерпретации. */}
                <th className="row-actions"></th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => {
                const clientRentals = rentals.filter((r) => r.client_id === c.id);
                const activeCount = clientRentals.filter((r) => {
                  const s = rentalDisplayStatus(r);
                  return s === "active" || s === "overdue";
                }).length;
                const overdueNow = clientRentals.filter((r) => rentalDisplayStatus(r) === "overdue").length;
                const lastRental = lastRentalDate(c.id, rentals);
                const tagList = (c.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
                const cellCtx: ClientCellContext = {
                  clientRentals,
                  activeCount,
                  overdueNow,
                  lastRental,
                  displayRating: clientDisplayRating(c, rentals),
                  revenue: clientLifetimeRevenue(c.id, rentals),
                };
                return (
                  <tr key={c.id} data-clickable="true" onClick={() => openClient(c.id)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selectedIds.has(c.id)} onChange={() => toggleSelected(c.id)} />
                    </td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        {/* Аватар из инициалов, нейтральный цвет — тот же приём,
                            что и у сотрудников в сайдбаре (initials из
                            lib/format.ts), 25-й проход, п.3 обзора; цвет сделан
                            единым (37-й проход) — см. .avatar в styles.css. */}
                        <span className="avatar">{initials(c.name)}</span>
                        <div>
                          {/* cell-name-wrap (32-й проход — обзор оформления,
                              п. "Удалить съезжает за край экрана"): у клиента с
                              несколькими бейджами разом (Орг. + уровень +
                              день рождения + "Неполный профиль") имя раньше
                              росло одной нерастяжимой строкой — при
                              table-layout:auto это раздувало всю таблицу шире
                              контейнера, и последняя колонка с кнопками
                              "Изменить"/"Удалить" уезжала за правый край
                              экрана. flex-wrap переносит бейджи на вторую
                              строку внутри своей же колонки вместо того, чтобы
                              раздувать её вширь. */}
                          <div className="cell-name cell-name-wrap">
                            <span>{c.name}</span>
                            {c.client_type === "company" && (
                              <span className="badge-tag" title="Организация">
                                Орг.
                              </span>
                            )}
                            {/* Уровень ценности клиента по выручке (26-й проход) —
                                отдельная ось от рейтинга надёжности слева в
                                своей колонке, поэтому здесь, у имени. */}
                            {valueTiers.has(c.id) && (
                              <span style={{ display: "inline-block" }}>
                                <Badge meta={VALUE_TIER_META[valueTiers.get(c.id)!]} />
                              </span>
                            )}
                            {isBirthdayThisWeek(c.birthday) && (
                              <span title="День рождения на этой неделе" style={{ display: "inline-flex", verticalAlign: "middle" }}>
                                <IconGift width={14} height={14} />
                              </span>
                            )}
                            {/* "Неполный профиль" (26-й проход, проф. обзор, п.6) —
                                нет ни телефона, ни документа: риск отдать технику
                                клиенту, с которым потом не связаться. */}
                            {isIncompleteProfile(c) && (
                              <span style={{ display: "inline-block" }}>
                                <Badge meta={{ label: "Неполный профиль", tone: "warning" }} />
                              </span>
                            )}
                            {/* Произвольные теги клиента (34-й проход, обзор
                                колонки "Имя") — в общем переносимом по ширине
                                ряду вместе с системными бейджами. Класс
                                .badge-tag-custom (не .badge-tag, которым
                                рисуется "Орг." выше) — контурная, а не
                                заливная пилюля: "Орг."/уровень
                                ценности/"Неполный профиль" — то, что посчитала
                                система, тег — то, что вписал вручную менеджер. */}
                            {tagList.map((t) => (
                              <span key={t} className="badge-tag-custom">
                                {t}
                              </span>
                            ))}
                          </div>
                          {/* 29-й проход, п. из обзора "иконки звонок/WhatsApp/
                              email в строке" — убраны; быстрый доступ к
                              контактам уже есть в карточке клиента (раздел
                              "Контакты" — кликабельные tel:/mailto: ссылки).
                              Телефон в строке остаётся обычным текстом.
                              Форматирование через formatPhoneInput (34-й
                              проход) — на случай, если номер попал в систему
                              не через маску набора в форме (импорт, API). */}
                          <div className="cell-sub">
                            <span>{c.phone ? formatPhoneInput(c.phone) : "—"}</span>
                          </div>
                        </div>
                      </div>
                    </td>
                    {clientColumns.map((col) => (
                      <td key={col.key}>{renderClientCell(col.key, c, cellCtx)}</td>
                    ))}
                    {/* row-actions (32-й проход, обзор оформления) — кнопки
                        видны только при наведении/фокусе на строку, чтобы не
                        превращаться в "стену иконок" на длинном списке
                        клиентов; см. .row-actions в styles.css. */}
                    <td onClick={(e) => e.stopPropagation()} className="row-actions" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button type="button" className="icon-btn" title="Изменить" onClick={() => openEditModal(c.id)}>
                        <IconEdit />
                      </button>{" "}
                      <button type="button" className="icon-btn" title="Удалить" onClick={() => void handleDelete(c.id)}>
                        <IconTrash />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ClientFormModal
        open={modalMode !== null}
        title={formTitle}
        mode={modalMode === "edit" ? "edit" : "add"}
        initial={formInitial}
        error={formError}
        onClose={closeFormModal}
        onSubmit={(form) => handleSubmitForm(form)}
      />

      <ClientImportModal
        open={showImport}
        businessId={businessId}
        onClose={() => setShowImport(false)}
        onImported={() => void reloadClients()}
      />

      <ClientTrashModal
        open={showTrash}
        businessId={businessId}
        onClose={() => setShowTrash(false)}
        onRestored={() => void reloadClients()}
      />

      {openClientId && <div className="slideover-backdrop" onClick={() => setOpenClientId(null)} />}
      {openClientId && (
        <ClientDetailPanel
          businessId={businessId}
          clientId={openClientId}
          onClose={() => setOpenClientId(null)}
          onEdit={(id) => {
            setOpenClientId(null);
            openEditModal(id);
          }}
          onDelete={handleDelete}
          onCreateRental={
            onCreateRental
              ? (id) => {
                  setOpenClientId(null);
                  onCreateRental(id);
                }
              : undefined
          }
        />
      )}

      {confirmDialog}
      {bulkConfirmDialog}
      {duplicateDialog}
    </div>
  );
}
