/**
 * Дашборд — перенесён 1:1 из демо-прототипа (oborot-crm-prototype.html),
 * плюс несколько возможностей, которых в демо не было (запрошены
 * пользователем отдельно):
 *
 * 1. Каждую стат-плашку и панель можно скрыть лично для себя ("Настроить
 *    дашборд"), а видимые — перетащить: плашки верхнего ряда только по
 *    горизонтали, панели — по вертикали и с возможностью поставить две
 *    рядом на одном уровне (как "Ближайшие возвраты"/"Загрузка по
 *    категориям" по умолчанию). Раньше здесь было ещё и переименование
 *    блоков — по прямой просьбе пользователя заменено на перетаскивание.
 *    Настройка хранится на бэкенде per-Employee (см. DashboardPrefs).
 * 2. Панель "Заметки/новости" — доска коротких записей с настраиваемым
 *    владельцем бизнеса режимом доступа (только он пишет / пишут все) —
 *    см. NotesPanel ниже. Тоже участвует в общей системе скрытия/раскладки.
 * 3. Клик по клиенту/оборудованию открывает карточку ПРЯМО на дашборде
 *    (через onOpenClient/onOpenEquipment, реализовано на уровне Dashboard.tsx)
 *    вместо перехода на другую вкладку.
 * 4. Период у денежных плашек (выручка/компенсации) стал настраиваемым
 *    (7/30/90 дней вместо фиксированных 30).
 *
 * Компонент рендерит только тело раздела — заголовок страницы и кнопку
 * "+ Новая аренда" рисует родительская оболочка (Dashboard.tsx).
 */
import { useEffect, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import { useData } from "../../context/DataContext";
import { api, ApiError } from "../../api/client";
import type { Client, DashboardNote, DashboardPrefs, NotesMode, Rental } from "../../api/types";
import { money, fmtDate, dayDiff, isoAddDays, todayISO } from "../../lib/format";
import { RENTAL_META, RATING_META, Badge, rentalDisplayStatus, equipmentDisplayStatus } from "../../lib/statusMeta";
import { topEquipmentByRevenue, topCategoriesByRevenue } from "../../lib/financeCalc";
import { IconAlert, IconEye, IconEyeOff, IconGrip, IconSliders, IconTrash, IconTrendUp, IconTrendDown, IconReset } from "../../lib/icons";
import { useConfirm } from "../../components/ConfirmDialog";
import type { View } from "../Dashboard";

export type NavigateFn = (
  target: View,
  opts?: { equipmentFilter?: string; rentalFilter?: string; search?: string; finance30?: boolean }
) => void;

interface DashboardTabProps {
  navigate: NavigateFn;
  businessId: string;
  isOwner: boolean;
  notesMode: NotesMode;
  onNotesModeChange: (mode: NotesMode) => void;
  onOpenClient: (id: string) => void;
  onOpenEquipment: (id: string) => void;
}

type DeltaTone = "good" | "critical" | "flat";
type StatPeriodKey = "1" | "7" | "30" | "90";

const STAT_IDS = ["stat-active", "stat-free", "stat-overdue", "stat-revenue30", "stat-deposits", "stat-damage30", "stat-forecast"];
const PANEL_IDS = ["panel-notes", "panel-due", "panel-categories", "panel-risky", "panel-topequip", "panel-pickup", "panel-duetoday", "panel-maintenance"];
// По умолчанию "Заметки" — первым, самым заметным блоком; "Ближайшие
// возвраты" и "Загрузка по категориям" — рядом на одном уровне, ровно как
// было устроено до появления перетаскивания; остальные панели — по одной
// в строке, друг под другом. "Обслуживание" — новая, добавлена последней
// строкой, чтобы не переставлять уже привычную раскладку остальных панелей.
const DEFAULT_PANEL_ROWS: string[][] = [
  ["panel-notes"],
  ["panel-due", "panel-categories"],
  ["panel-risky"],
  ["panel-topequip"],
  ["panel-pickup"],
  ["panel-duetoday"],
  ["panel-maintenance"],
];
const PANEL_TITLES: Record<string, string> = {
  "panel-notes": "Заметки и новости",
  "panel-due": "Ближайшие и просроченные возвраты",
  "panel-categories": "Загрузка по категориям",
  "panel-risky": "Клиенты, требующие внимания",
  "panel-topequip": "Топ оборудования по доходу",
  "panel-pickup": "Выдача ожидается сегодня",
  "panel-duetoday": "Возврат ожидается сегодня",
  "panel-maintenance": "Скоро освободится после обслуживания",
};
const STAT_TITLES: Record<string, string> = {
  "stat-active": "В аренде сейчас",
  "stat-free": "Свободно",
  "stat-overdue": "Просрочено возвратов",
  "stat-revenue30": "Выручка",
  "stat-deposits": "Депозиты на удержании",
  "stat-damage30": "Компенсации за повреждения",
  "stat-forecast": "Ожидаемая выручка",
};

/** Известные id, отсутствующие в сохранённом порядке (например появились
 * позже, чем сотрудник в последний раз настраивал дашборд), дописываются в
 * конец; неизвестные (блок убрали) — молча отбрасываются. Пустой сохранённый
 * список (сотрудник ещё ни разу не настраивал раскладку) — это НЕ то же
 * самое, что "всё в одну колонку": в этом случае используем осмысленный
 * дефолт (см. DEFAULT_PANEL_ROWS), а не результат нормализации пустого ввода. */
function normalizeStatOrder(saved: string[]): string[] {
  if (saved.length === 0) return STAT_IDS;
  const kept = saved.filter((id) => STAT_IDS.includes(id));
  const missing = STAT_IDS.filter((id) => !kept.includes(id));
  return [...kept, ...missing];
}

function normalizePanelRows(saved: string[][]): string[][] {
  if (saved.length === 0) return DEFAULT_PANEL_ROWS;
  const seen = new Set<string>();
  const rows: string[][] = [];
  for (const row of saved) {
    const filtered = row.filter((id) => PANEL_IDS.includes(id) && !seen.has(id));
    filtered.forEach((id) => seen.add(id));
    if (filtered.length > 0) rows.push(filtered);
  }
  PANEL_IDS.filter((id) => !seen.has(id)).forEach((id) => rows.push([id]));
  return rows;
}

/** Перетаскиваемый в режиме настройки блок (и стат-плашка, и панель) — общая
 * "рамка" с ручкой-грипом и переключателем видимости; сама drag-механика —
 * та же схема HTML5 DnD (draggable + onDragStart/Over/Leave/Drop), что уже
 * используется для перетаскивания категорий в "Календаре" (CalendarTab.tsx),
 * только id носителя передаётся через dataTransfer, а не замыкание. */
function DraggableBlock({
  id,
  hidden,
  editMode,
  onToggleHidden,
  onDropOnId,
  children,
}: {
  id: string;
  hidden: boolean;
  editMode: boolean;
  onToggleHidden: (id: string) => void;
  onDropOnId: (draggedId: string, targetId: string) => void;
  children: ReactNode;
}) {
  return (
    <div
      className={"dash-block-cell" + (hidden ? " dash-block-hidden" : "")}
      draggable={editMode}
      onDragStart={(e: DragEvent<HTMLDivElement>) => {
        e.dataTransfer.setData("text/plain", id);
        e.dataTransfer.effectAllowed = "move";
        e.currentTarget.classList.add("dragging");
      }}
      onDragEnd={(e: DragEvent<HTMLDivElement>) => e.currentTarget.classList.remove("dragging")}
      onDragOver={
        editMode
          ? (e: DragEvent<HTMLDivElement>) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              e.currentTarget.classList.add("drag-over");
            }
          : undefined
      }
      onDragLeave={(e: DragEvent<HTMLDivElement>) => e.currentTarget.classList.remove("drag-over")}
      onDrop={
        editMode
          ? (e: DragEvent<HTMLDivElement>) => {
              e.preventDefault();
              e.currentTarget.classList.remove("drag-over");
              const draggedId = e.dataTransfer.getData("text/plain");
              if (draggedId) onDropOnId(draggedId, id);
            }
          : undefined
      }
    >
      {editMode && (
        <div className="dash-handle" title="Перетащите, чтобы изменить порядок">
          <span className="dash-grip">
            <IconGrip />
          </span>
          <button type="button" className="icon-btn" onClick={() => onToggleHidden(id)} title={hidden ? "Показать блок" : "Скрыть блок"}>
            {hidden ? <IconEyeOff /> : <IconEye />}
          </button>
        </div>
      )}
      {children}
    </div>
  );
}

/** Узкая "щель" между строками панелей — цель для вертикального
 * перетаскивания (в отличие от броска ПРЯМО НА панель, который ставит два
 * блока рядом, бросок В ЩЕЛЬ перемещает блок между строками, не образуя
 * пару). anchorId — id панели, которая сейчас идёт следующей строкой сразу
 * после этой щели (null — самая нижняя щель, "в конец"). */
function RowGap({
  editMode,
  anchorId,
  onDropGap,
}: {
  editMode: boolean;
  anchorId: string | null;
  onDropGap: (draggedId: string, anchorId: string | null) => void;
}) {
  if (!editMode) return null;
  return (
    <div
      className="dash-row-gap"
      onDragOver={(e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        e.currentTarget.classList.add("drag-over");
      }}
      onDragLeave={(e: DragEvent<HTMLDivElement>) => e.currentTarget.classList.remove("drag-over")}
      onDrop={(e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.currentTarget.classList.remove("drag-over");
        const draggedId = e.dataTransfer.getData("text/plain");
        if (draggedId) onDropGap(draggedId, anchorId);
      }}
    />
  );
}

function StatTile({
  label,
  value,
  mono,
  critical,
  delta,
  onClick,
  disabled,
}: {
  label: string;
  value: string | number;
  mono?: boolean;
  critical?: boolean;
  delta?: { pct: number; tone: DeltaTone } | null;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button className="stat-tile" onClick={disabled ? undefined : onClick} disabled={disabled}>
      <div className="stat-label">{label}</div>
      <div className={"stat-value" + (mono ? " mono" : "") + (critical ? " critical" : "")}>{value}</div>
      {delta && (
        <div className={"stat-delta " + delta.tone}>
          {delta.tone === "good" ? <IconTrendUp /> : delta.tone === "critical" ? <IconTrendDown /> : null}
          {(delta.pct > 0 ? "+" : "") + delta.pct}% к пред. периоду
        </div>
      )}
    </button>
  );
}

interface CategoryStat {
  total: number;
  rented: number;
  maint: number;
}

interface RiskyEntry {
  client: Client;
  rental: Rental;
  status: string;
  priority: number;
}

/** Доска "Заметки/новости" — см. NotesMode на Business (backend). Не одно
 * перезаписываемое поле, а лента отдельных записей: несколько человек могут
 * писать одновременно без риска затереть чужую (last-write-wins). Владелец
 * бизнеса переключает режим прямо здесь же (сегмент-контрол в шапке),
 * остальные сотрудники видят режим только как факт (могут/не могут писать). */
function NotesPanel({ businessId, isOwner, notesMode, onNotesModeChange }: { businessId: string; isOwner: boolean; notesMode: NotesMode; onNotesModeChange: (m: NotesMode) => void }) {
  const [notes, setNotes] = useState<DashboardNote[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    api
      .get<DashboardNote[]>(`/businesses/${businessId}/notes`)
      .then((list) => {
        if (!cancelled) setNotes(list);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  const canPost = isOwner || notesMode === "everyone";

  async function postNote() {
    const text = draft.trim();
    if (!text) return;
    setPosting(true);
    try {
      const created = await api.post<DashboardNote>(`/businesses/${businessId}/notes`, { text });
      setNotes((prev) => [created, ...prev]);
      setDraft("");
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Не удалось опубликовать запись");
    } finally {
      setPosting(false);
    }
  }

  async function deleteNote(id: string) {
    if (!(await confirm("Удалить эту запись?", { danger: true }))) return;
    try {
      await api.delete(`/businesses/${businessId}/notes/${id}`);
      setNotes((prev) => prev.filter((n) => n.id !== id));
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Не удалось удалить");
    }
  }

  // Отметка "выполнено" — простой чекбокс, НЕ полноценный чек-лист/трекер
  // задач (сознательно не реализовывали — см. обсуждение UX-обзора):
  // доступна тому же, кому доступно удаление записи (n.can_delete).
  async function toggleDone(note: DashboardNote) {
    const nextDone = !note.done;
    setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, done: nextDone } : n)));
    try {
      await api.patch(`/businesses/${businessId}/notes/${note.id}`, { done: nextDone });
    } catch (err) {
      setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, done: note.done } : n)));
      alert(err instanceof ApiError ? err.message : "Не удалось изменить отметку");
    }
  }

  async function changeMode(mode: NotesMode) {
    if (mode === notesMode) return;
    try {
      await api.put(`/businesses/${businessId}/notes/mode`, { mode });
      onNotesModeChange(mode);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Не удалось изменить режим");
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{PANEL_TITLES["panel-notes"]}</h2>
        {isOwner && (
          <div className="segmented segmented-sm" title="Кто может публиковать записи">
            <button type="button" className={notesMode === "owner_only" ? "active" : ""} onClick={() => void changeMode("owner_only")}>
              Только я
            </button>
            <button type="button" className={notesMode === "everyone" ? "active" : ""} onClick={() => void changeMode("everyone")}>
              Пишут все
            </button>
          </div>
        )}
      </div>
      <div className="panel-body">
        {canPost && (
          <div className="notes-composer">
            <textarea
              value={draft}
              maxLength={2000}
              placeholder={isOwner ? "Заметки и новости для команды…" : "Быстрая заметка…"}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button type="button" className="btn btn-primary btn-sm" disabled={!draft.trim() || posting} onClick={() => void postNote()}>
              Опубликовать
            </button>
          </div>
        )}
        {!canPost && (
          <div className="field-hint" style={{ marginBottom: 10 }}>
            Писать сюда может только владелец бизнеса — он же может это изменить в настройках доски.
          </div>
        )}
        {!loaded ? (
          <div className="empty-note">Загрузка…</div>
        ) : notes.length === 0 ? (
          <div className="empty-note">Пока нет ни одной записи.</div>
        ) : (
          <div className="notes-feed">
            {notes.map((n) => (
              <div className={"note-item" + (n.done ? " note-done" : "")} key={n.id}>
                <div className="note-item-head">
                  {n.can_delete && (
                    <input
                      type="checkbox"
                      className="note-done-check"
                      checked={n.done}
                      title={n.done ? "Отметить невыполненным" : "Отметить выполненным"}
                      onChange={() => void toggleDone(n)}
                    />
                  )}
                  <span className="note-author">{n.author_name}</span>
                  <span className="note-date">
                    {fmtDate(n.created_at.slice(0, 10))} · {new Date(n.created_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  {n.can_delete && (
                    <button type="button" className="icon-btn note-delete" title="Удалить запись" onClick={() => void deleteNote(n.id)}>
                      <IconTrash />
                    </button>
                  )}
                </div>
                <div className="note-text">{n.text}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      {confirmDialog}
    </div>
  );
}

export function DashboardTab({ navigate, businessId, isOwner, notesMode, onNotesModeChange, onOpenClient, onOpenEquipment }: DashboardTabProps) {
  const { equipment, clients, rentals, reloadRentals, reloadEquipment } = useData();
  const today = todayISO();

  // ---------- Личная раскладка дашборда (скрыть/переставить) ----------
  const [hidden, setHidden] = useState<string[]>([]);
  const [statOrder, setStatOrder] = useState<string[]>(STAT_IDS);
  const [panelRows, setPanelRows] = useState<string[][]>(DEFAULT_PANEL_ROWS);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [editMode, setEditMode] = useState(false);

  // Настраиваемый период денежных плашек (выручка/компенсации) — раньше был
  // жёстко зашит на 30 дней; сессионный выбор, не персистится (в отличие от
  // раскладки блоков) — это лёгкий просмотровый переключатель, а не личная
  // настройка уровня "как выглядит мой дашборд".
  const [statPeriod, setStatPeriod] = useState<StatPeriodKey>("30");

  // "Топ оборудования по доходу" — переключатели периода/группировки
  // (запрошено пользователем отдельно от statPeriod выше: там речь про
  // выручку/компенсации на плашках, здесь — своя область, поэтому свои
  // локальные, тоже сессионные, не персистятся). usePeriod=false — как
  // раньше, "за всё время"; true — использует тот же диапазон, что и
  // statPeriod (общий переключатель периода наверху), чтобы не дублировать
  // ещё один набор кнопок 1/7/30/90 на той же странице.
  const [topEquipUsePeriod, setTopEquipUsePeriod] = useState(false);
  const [topEquipGroupBy, setTopEquipGroupBy] = useState<"items" | "categories">("items");

  const { confirm: confirmAction, dialog: confirmActionDialog } = useConfirm();

  useEffect(() => {
    let cancelled = false;
    setPrefsLoaded(false);
    api
      .get<DashboardPrefs>(`/businesses/${businessId}/dashboard-prefs`)
      .then((p) => {
        if (cancelled) return;
        setHidden(p.hidden ?? []);
        setStatOrder(normalizeStatOrder(p.stat_order ?? []));
        setPanelRows(normalizePanelRows(p.panel_rows ?? []));
      })
      .catch(() => {
        // Настройка чисто косметическая — если не загрузилась, просто
        // показываем дефолтную раскладку, без ошибки пользователю.
      })
      .finally(() => {
        if (!cancelled) setPrefsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  function persist(next: { hidden?: string[]; statOrder?: string[]; panelRows?: string[][] }) {
    const nextHidden = next.hidden ?? hidden;
    const nextStatOrder = next.statOrder ?? statOrder;
    const nextPanelRows = next.panelRows ?? panelRows;
    setHidden(nextHidden);
    setStatOrder(nextStatOrder);
    setPanelRows(nextPanelRows);
    void api
      .put(`/businesses/${businessId}/dashboard-prefs`, { hidden: nextHidden, stat_order: nextStatOrder, panel_rows: nextPanelRows })
      .catch(() => {});
  }

  function toggleHidden(id: string) {
    persist({ hidden: hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id] });
  }

  /** "Сбросить настройки" в режиме редактирования — возвращает раскладку к
   * дефолтной (ничего не скрыто, порядок/строки как из коробки). Кнопка
   * доступна только в editMode — сама персональная раскладка per-Employee,
   * поэтому сброс касается только текущего сотрудника, не всей команды. */
  function resetLayout() {
    persist({ hidden: [], statOrder: STAT_IDS, panelRows: DEFAULT_PANEL_ROWS });
  }
  function isHidden(id: string): boolean {
    return hidden.includes(id);
  }
  /** Блок рендерится, если он не скрыт ИЛИ мы в режиме настройки (тогда
   * скрытые тоже видны, но приглушены — иначе их было бы невозможно снова
   * показать или вытащить обратно перетаскиванием). */
  function shows(id: string): boolean {
    return editMode || !isHidden(id);
  }

  function reorderStat(draggedId: string, targetId: string) {
    if (draggedId === targetId) return;
    const order = statOrder.filter((id) => id !== draggedId);
    const idx = order.indexOf(targetId);
    if (idx === -1) return;
    order.splice(idx, 0, draggedId);
    persist({ statOrder: order });
  }

  /** Бросок ОДНОЙ панели ПРЯМО НА другую — ставит их рядом на одном уровне
   * (образует/пополняет строку из 1-2 блоков). Если у цели уже есть пара —
   * тот, кто был рядом, "выселяется" в отдельную строку сразу под ней, а
   * перетащенный занимает его место — раскладка остаётся из строк по 1-2
   * блока без исключений, никогда не бывает "осиротевших" пустых строк. */
  function mergePanels(draggedId: string, targetId: string) {
    if (draggedId === targetId) return;
    let next = panelRows.map((row) => row.filter((x) => x !== draggedId));
    const targetRowIdx = next.findIndex((row) => row.includes(targetId));
    if (targetRowIdx === -1) return;
    const targetRow = next[targetRowIdx];
    if (targetRow.length === 1) {
      next[targetRowIdx] = [targetId, draggedId];
    } else {
      const partner = targetRow.find((x) => x !== targetId)!;
      next[targetRowIdx] = [targetId, draggedId];
      next.splice(targetRowIdx + 1, 0, [partner]);
    }
    next = next.filter((row) => row.length > 0);
    persist({ panelRows: next });
  }

  /** Бросок панели В ЩЕЛЬ между строками — чисто вертикальное перемещение,
   * панель становится отдельной строкой на всю ширину в этом месте (если она
   * была в паре — бывший сосед остаётся на месте один, тоже во всю ширину). */
  function movePanelToGap(draggedId: string, anchorId: string | null) {
    let next = panelRows.map((row) => row.filter((x) => x !== draggedId)).filter((row) => row.length > 0);
    const insertIdx = anchorId === null ? next.length : (() => {
      const i = next.findIndex((row) => row.includes(anchorId));
      return i === -1 ? next.length : i;
    })();
    next = [...next.slice(0, insertIdx), [draggedId], ...next.slice(insertIdx)];
    persist({ panelRows: next });
  }

  const activeAndOverdue = rentals.filter((r) => {
    const s = rentalDisplayStatus(r);
    return s === "active" || s === "overdue";
  });
  const overdue = activeAndOverdue.filter((r) => rentalDisplayStatus(r) === "overdue");

  const rentedEquipIds = new Set<string>();
  activeAndOverdue.forEach((r) => r.items.forEach((it) => rentedEquipIds.add(it.equipment_id)));

  const usableEquip = equipment.filter((e) => e.status !== "retired");
  const freeCount = usableEquip.filter((e) => equipmentDisplayStatus(e, rentals, today) === "available").length;

  // Период денежных плашек — настраиваемый (7/30/90), см. statPeriod выше.
  const periodDays = Number(statPeriod);
  const periodTo = today;
  const periodFrom = isoAddDays(periodTo, -(periodDays - 1));
  const prevPeriodTo = isoAddDays(periodFrom, -1);
  const prevPeriodFrom = isoAddDays(prevPeriodTo, -(periodDays - 1));

  const inPeriod = (r: Rental) => {
    const d = r.actual_return || r.end_date;
    return r.status === "returned" && d >= periodFrom && d <= periodTo;
  };
  const inPrevPeriod = (r: Rental) => {
    const d = r.actual_return || r.end_date;
    return r.status === "returned" && d >= prevPeriodFrom && d <= prevPeriodTo;
  };
  const revenuePeriod = rentals.filter(inPeriod).reduce((s, r) => s + r.total, 0);
  const revenuePrevPeriod = rentals.filter(inPrevPeriod).reduce((s, r) => s + r.total, 0);
  const depositsHeld = activeAndOverdue.reduce((s, r) => s + r.deposit_total, 0);
  const damagePeriod = rentals.filter(inPeriod).reduce((s, r) => s + r.damage_fee, 0);

  let revenueDelta: { pct: number; tone: DeltaTone } | null = null;
  if (revenuePrevPeriod > 0) {
    const pct = Math.round(((revenuePeriod - revenuePrevPeriod) / revenuePrevPeriod) * 100);
    revenueDelta = { pct, tone: pct > 0 ? "good" : pct < 0 ? "critical" : "flat" };
  }

  const DUE_SHOWN = 7;
  const dueListAll = activeAndOverdue.slice().sort((a, b) => (a.end_date < b.end_date ? -1 : 1));
  const dueList = dueListAll.slice(0, DUE_SHOWN);

  const byCategory: Record<string, CategoryStat> = {};
  usableEquip.forEach((e) => {
    if (!byCategory[e.category]) byCategory[e.category] = { total: 0, rented: 0, maint: 0 };
    byCategory[e.category].total++;
    if (rentedEquipIds.has(e.id)) byCategory[e.category].rented++;
    if (equipmentDisplayStatus(e, rentals, today) === "maintenance") byCategory[e.category].maint++;
  });
  const catKeys = Object.keys(byCategory).sort(
    (a, b) => byCategory[b].rented / byCategory[b].total - byCategory[a].rented / byCategory[a].total
  );
  const seqRamp = ["var(--seq-3)", "var(--seq-4)", "var(--seq-5)", "var(--seq-6)", "var(--seq-2)"];
  const overallPct = usableEquip.length ? Math.round((rentedEquipIds.size / usableEquip.length) * 100) : 0;

  const riskyMap: Record<string, RiskyEntry> = {};
  rentals.forEach((r) => {
    const s = rentalDisplayStatus(r);
    if (s !== "active" && s !== "overdue" && s !== "booked") return;
    const c = clients.find((x) => x.id === r.client_id);
    if (!c || c.rating === "normal") return;
    const priority = s === "overdue" ? 3 : s === "active" ? 2 : 1;
    if (!riskyMap[c.id] || riskyMap[c.id].priority < priority) {
      riskyMap[c.id] = { client: c, rental: r, status: s, priority };
    }
  });
  const riskyList = Object.values(riskyMap).sort((a, b) => b.priority - a.priority);

  const topEquipRange = topEquipUsePeriod ? { from: periodFrom, to: periodTo } : undefined;
  const topEquipItems = topEquipmentByRevenue(rentals, equipment, 5, topEquipRange);
  const topEquipCats = topCategoriesByRevenue(rentals, equipment, 5, topEquipRange);

  // "Ожидаемая выручка" — сумма по уже забронированным (ещё не выданным)
  // арендам, чья дата НАЧАЛА попадает в текущее окно statPeriod. r.total уже
  // содержит посчитанную backend'ом стоимость аренды целиком (см.
  // app/services/pricing.py) — здесь просто суммируем по отфильтрованным
  // броням, отдельного пересчёта по датам не требуется.
  const forecastRentals = rentals.filter(
    (r) => r.status === "booked" && r.start_date >= periodFrom && r.start_date <= periodTo
  );
  const forecastRevenue = forecastRentals.reduce((s, r) => s + r.total, 0);

  // "Скоро освободится после обслуживания" — оборудование в статусе
  // maintenance, отсортировано по дате окончания (раньше всех — первым; без
  // указанной даты — в конец списка, как "неизвестно когда").
  const maintenanceList = usableEquip
    .filter((e) => e.status === "maintenance")
    .slice()
    .sort((a, b) => {
      if (!a.maintenance_until && !b.maintenance_until) return 0;
      if (!a.maintenance_until) return 1;
      if (!b.maintenance_until) return -1;
      return a.maintenance_until < b.maintenance_until ? -1 : 1;
    });

  // "Возврат ожидается сегодня" — активные аренды, у которых плановая дата
  // возврата сегодня.
  const dueToday = rentals.filter((r) => r.status === "active" && dayDiff(r.end_date) === 0);
  // "Выдача ожидается сегодня" — забронированные аренды, стартующие сегодня.
  const pickupToday = rentals.filter((r) => r.status === "booked" && dayDiff(r.start_date) === 0);

  function itemNames(r: Rental): string {
    return r.items.map((it) => equipment.find((e) => e.id === it.equipment_id)?.name).join(", ");
  }

  async function handleIssue(rentalId: string) {
    // Подтверждение — сознательно добавлено: "Выдать" отсюда, в отличие от
    // "Принять возврат" в соседней панели, раньше срабатывало мгновенно по
    // одному клику без какого-либо шага назад, хотя одинаково необратимо
    // меняет статус аренды (см. UX-обзор дашборда).
    if (!(await confirmAction("Выдать оборудование по этой аренде?", { confirmLabel: "Выдать" }))) return;
    try {
      await api.post(`/businesses/${businessId}/rentals/${rentalId}/issue`);
      await reloadRentals();
      await reloadEquipment();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Не удалось выполнить действие");
    }
  }

  const statLabel = (id: string): string => {
    if (id === "stat-free") return "Свободно из " + usableEquip.length;
    if (id === "stat-revenue30") return periodDays === 1 ? "Выручка сегодня" : "Выручка за " + periodDays + " дней";
    if (id === "stat-damage30") return periodDays === 1 ? "Компенсации сегодня" : "Компенсации за " + periodDays + " дней";
    if (id === "stat-forecast") return periodDays === 1 ? "Ожидаемая выручка сегодня" : "Ожидаемая выручка за " + periodDays + " дней";
    return STAT_TITLES[id] ?? id;
  };

  function renderStat(id: string): ReactNode {
    switch (id) {
      case "stat-active":
        return (
          <StatTile
            label={statLabel(id)}
            value={rentedEquipIds.size}
            disabled={editMode}
            onClick={() => navigate("rentals", { rentalFilter: "active" })}
          />
        );
      case "stat-free":
        return (
          <StatTile
            label={statLabel(id)}
            value={freeCount}
            disabled={editMode}
            onClick={() => navigate("equipment", { equipmentFilter: "available" })}
          />
        );
      case "stat-overdue":
        return (
          <StatTile
            label={statLabel(id)}
            value={overdue.length}
            critical={overdue.length > 0}
            disabled={editMode}
            onClick={() => navigate("rentals", { rentalFilter: "overdue" })}
          />
        );
      case "stat-revenue30":
        return (
          <StatTile
            label={statLabel(id)}
            value={money(revenuePeriod)}
            mono
            delta={revenueDelta}
            disabled={editMode}
            onClick={() => navigate("finance", { finance30: true })}
          />
        );
      case "stat-deposits":
        return (
          <StatTile label={statLabel(id)} value={money(depositsHeld)} mono disabled={editMode} onClick={() => navigate("finance", { finance30: true })} />
        );
      case "stat-damage30":
        return (
          <StatTile label={statLabel(id)} value={money(damagePeriod)} mono disabled={editMode} onClick={() => navigate("finance", { finance30: true })} />
        );
      case "stat-forecast":
        return (
          <StatTile
            label={statLabel(id)}
            value={money(forecastRevenue)}
            mono
            disabled={editMode}
            onClick={() => navigate("rentals", { rentalFilter: "booked" })}
          />
        );
      default:
        return null;
    }
  }

  function renderPanel(id: string): ReactNode {
    switch (id) {
      case "panel-notes":
        return <NotesPanel businessId={businessId} isOwner={isOwner} notesMode={notesMode} onNotesModeChange={onNotesModeChange} />;

      case "panel-due":
        return (
          <div className="panel">
            <div className="panel-head">
              <h2>{PANEL_TITLES[id]}</h2>
              <span className="hint">{activeAndOverdue.length} в работе</span>
            </div>
            <div className="panel-body">
              {activeAndOverdue.length === 0 ? (
                <div className="empty-note">Активных аренд нет.</div>
              ) : (
                <>
                  {dueList.map((r) => {
                    const c = clients.find((x) => x.id === r.client_id);
                    const names = itemNames(r);
                    const st = rentalDisplayStatus(r);
                    const metaText = st === "overdue" ? "просрочено на " + Math.abs(dayDiff(r.end_date)) + " дн." : "до " + fmtDate(r.end_date);
                    const inner = (
                      <>
                        <div className="due-main">
                          <div className="due-title">{c?.name ?? "—"}</div>
                          <div className="due-meta">
                            {names} · {metaText}
                          </div>
                        </div>
                        <Badge meta={RENTAL_META[st]} />
                      </>
                    );
                    return c ? (
                      <button key={r.id} className="due-item" onClick={() => onOpenClient(c.id)}>
                        {inner}
                      </button>
                    ) : (
                      <div key={r.id} className="due-item">
                        {inner}
                      </div>
                    );
                  })}
                  {activeAndOverdue.length > DUE_SHOWN && (
                    <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => navigate("rentals", { rentalFilter: "active" })}>
                      Показать все {activeAndOverdue.length} →
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        );

      case "panel-categories":
        return (
          <div className="panel">
            <div className="panel-head">
              <h2>{PANEL_TITLES[id]}</h2>
              <span className="hint">{overallPct}% в среднем</span>
            </div>
            <div className="panel-body">
              {catKeys.length === 0 && <div className="empty-note">Нет данных</div>}
              {catKeys.map((cat, i) => {
                const d = byCategory[cat];
                const pct = Math.round((d.rented / d.total) * 100);
                return (
                  <button key={cat} className="util-row" onClick={() => navigate("equipment", { equipmentFilter: "all", search: cat })}>
                    <div className="util-name">
                      <span className="util-name-text" title={cat}>
                        {cat}
                      </span>
                      {d.maint > 0 && (
                        <span className="util-maint" title={`${d.maint} на обслуживании`}>
                          +{d.maint}
                        </span>
                      )}
                    </div>
                    <div className="util-track">
                      <div className="util-fill" style={{ width: Math.max(4, pct) + "%", background: seqRamp[i % seqRamp.length] }} />
                    </div>
                    <div className="util-pct">{pct}%</div>
                  </button>
                );
              })}
            </div>
          </div>
        );

      case "panel-risky":
        return (
          <div className="panel">
            <div className="panel-head">
              <h2 style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ display: "flex", color: "var(--critical)" }}>
                  <IconAlert />
                </span>
                {PANEL_TITLES[id]}
              </h2>
            </div>
            <div className="panel-body">
              {riskyList.length === 0 ? (
                <div className="empty-note">Ничего не найдено.</div>
              ) : (
                riskyList.map((x) => {
                  const c = x.client;
                  const r = x.rental;
                  const metaText =
                    x.status === "booked"
                      ? "бронь с " + fmtDate(r.start_date)
                      : x.status === "overdue"
                        ? "просрочено на " + Math.abs(dayDiff(r.end_date)) + " дн."
                        : "до " + fmtDate(r.end_date);
                  const names = itemNames(r);
                  return (
                    <button key={c.id} className="due-item" onClick={() => onOpenClient(c.id)}>
                      <div className="due-main">
                        <div className="due-title">{c.name}</div>
                        <div className="due-meta">
                          {names} · {metaText}
                        </div>
                      </div>
                      <Badge meta={RATING_META[c.rating]} />
                    </button>
                  );
                })
              )}
            </div>
          </div>
        );

      case "panel-topequip":
        return (
          <div className="panel">
            <div className="panel-head">
              <h2>{PANEL_TITLES[id]}</h2>
              <div className="dash-panel-controls">
                <div className="segmented segmented-sm" title="Группировка">
                  <button type="button" className={topEquipGroupBy === "items" ? "active" : ""} onClick={() => setTopEquipGroupBy("items")}>
                    По позициям
                  </button>
                  <button type="button" className={topEquipGroupBy === "categories" ? "active" : ""} onClick={() => setTopEquipGroupBy("categories")}>
                    По категориям
                  </button>
                </div>
                <div className="segmented segmented-sm" title="Период">
                  <button type="button" className={!topEquipUsePeriod ? "active" : ""} onClick={() => setTopEquipUsePeriod(false)}>
                    За всё время
                  </button>
                  <button
                    type="button"
                    className={topEquipUsePeriod ? "active" : ""}
                    onClick={() => setTopEquipUsePeriod(true)}
                    title="Использует период, выбранный переключателем 1/7/30/90 выше"
                  >
                    За {statPeriod === "1" ? "сегодня" : statPeriod + " дн."}
                  </button>
                </div>
              </div>
            </div>
            <div className="panel-body">
              {topEquipGroupBy === "items" ? (
                topEquipItems.length === 0 ? (
                  <div className="empty-note">Ничего не найдено.</div>
                ) : (
                  topEquipItems.map((x) => {
                    const e = equipment.find((eq) => eq.id === x.id);
                    if (!e) return null;
                    return (
                      <button key={x.id} className="due-item" onClick={() => onOpenEquipment(e.id)}>
                        <div className="due-main">
                          <div className="due-title">{e.name}</div>
                          <div className="due-meta">{e.category}</div>
                        </div>
                        <span className="due-value">{money(x.revenue)}</span>
                      </button>
                    );
                  })
                )
              ) : topEquipCats.length === 0 ? (
                <div className="empty-note">Ничего не найдено.</div>
              ) : (
                topEquipCats.map((x) => (
                  <button
                    key={x.category}
                    className="due-item"
                    onClick={() => navigate("equipment", { equipmentFilter: "all", search: x.category })}
                  >
                    <div className="due-main">
                      <div className="due-title">{x.category}</div>
                    </div>
                    <span className="due-value">{money(x.revenue)}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        );

      case "panel-maintenance":
        return (
          <div className="panel">
            <div className="panel-head">
              <h2>{PANEL_TITLES[id]}</h2>
              <span className="hint">{maintenanceList.length} на обслуживании</span>
            </div>
            <div className="panel-body">
              {maintenanceList.length === 0 ? (
                <div className="empty-note">Сейчас ничего не на обслуживании.</div>
              ) : (
                maintenanceList.map((e) => {
                  const daysLeft = e.maintenance_until ? dayDiff(e.maintenance_until) : null;
                  const metaText =
                    daysLeft === null
                      ? "дата окончания не указана"
                      : daysLeft < 0
                        ? "обслуживание просрочено на " + Math.abs(daysLeft) + " дн."
                        : daysLeft === 0
                          ? "освобождается сегодня"
                          : "освобождается через " + daysLeft + " дн. · " + fmtDate(e.maintenance_until!);
                  return (
                    <button key={e.id} className="due-item" onClick={() => onOpenEquipment(e.id)}>
                      <div className="due-main">
                        <div className="due-title">{e.name}</div>
                        <div className="due-meta">
                          {e.category} · {metaText}
                        </div>
                      </div>
                      {daysLeft !== null && daysLeft <= 0 && <Badge meta={{ label: "Просрочено", tone: "critical" }} />}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        );

      case "panel-pickup":
        return (
          <div className="panel panel-today">
            <div className="panel-head">
              <h2>{PANEL_TITLES[id]}</h2>
            </div>
            <div className="panel-body">
              {pickupToday.length === 0 ? (
                <div className="empty-note">Ничего не найдено.</div>
              ) : (
                pickupToday.map((r) => {
                  const c = clients.find((x) => x.id === r.client_id);
                  const names = itemNames(r);
                  return (
                    <div className={"mini-item" + (c ? " clickable" : "")} key={r.id} onClick={c ? () => onOpenClient(c.id) : undefined}>
                      <span>
                        <b>{c?.name ?? "—"}</b> — {names}
                      </span>
                      <span className="mini-item-actions">
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleIssue(r.id);
                          }}
                        >
                          Выдать
                        </button>
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        );

      case "panel-duetoday":
        return (
          <div className="panel panel-today">
            <div className="panel-head">
              <h2>{PANEL_TITLES[id]}</h2>
            </div>
            <div className="panel-body">
              {dueToday.length === 0 ? (
                <div className="empty-note">Ничего не найдено.</div>
              ) : (
                dueToday.map((r) => {
                  const c = clients.find((x) => x.id === r.client_id);
                  const names = itemNames(r);
                  return (
                    <div className={"mini-item" + (c ? " clickable" : "")} key={r.id} onClick={c ? () => onOpenClient(c.id) : undefined}>
                      <span>
                        <b>{c?.name ?? "—"}</b> — {names}
                      </span>
                      <span className="mini-item-actions">
                        {/* Полная форма возврата (с полями компенсации за
                            повреждения и скидки) живёт во вкладке "Аренды" —
                            здесь, для быстрого действия с дашборда, просто
                            переходим туда с этим клиентом в поиске. */}
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate("rentals", { rentalFilter: "active", search: c?.name ?? "" });
                          }}
                        >
                          Принять возврат
                        </button>
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        );

      default:
        return null;
    }
  }

  return (
    <>
      <div className="dash-toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div className="segmented segmented-sm" title="Период выручки, компенсаций и ожидаемой выручки на плашках">
            {(["1", "7", "30", "90"] as StatPeriodKey[]).map((k) => (
              <button key={k} type="button" className={statPeriod === k ? "active" : ""} onClick={() => setStatPeriod(k)}>
                {k === "1" ? "Сегодня" : `${k} дн.`}
              </button>
            ))}
          </div>
          {/* Диапазон дат текущего периода — раньше был виден только по
              смыслу выбранной кнопки (например "30 дн."), без фактических
              дат; теперь показан явно рядом с переключателем (см. UX-обзор,
              п.1). Заголовок страницы (Dashboard.tsx) сознательно не
              трогаем — там "Сегодня, {дата}", общий для всего дашборда, а не
              про период именно этих плашек. */}
          <span className="dash-period-range">{fmtDate(periodFrom)} — {fmtDate(periodTo)}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {editMode && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={resetLayout} title="Вернуть раскладку дашборда к значениям по умолчанию">
              <IconReset /> Сбросить настройки
            </button>
          )}
          <button
            type="button"
            className={"btn btn-sm" + (editMode ? " btn-primary" : "")}
            disabled={!prefsLoaded}
            onClick={() => setEditMode((v) => !v)}
            title="Скрыть ненужные плашки и панели дашборда или перетащить их в другое место"
          >
            <IconSliders /> {editMode ? "Готово" : "Настроить дашборд"}
          </button>
        </div>
      </div>

      <div className={editMode ? "dash-editing" : undefined}>
        <div className="stat-grid">
          {statOrder.map(
            (id) =>
              shows(id) && (
                <DraggableBlock key={id} id={id} hidden={isHidden(id)} editMode={editMode} onToggleHidden={toggleHidden} onDropOnId={reorderStat}>
                  {renderStat(id)}
                </DraggableBlock>
              )
          )}
        </div>

        {panelRows.map((row, rowIdx) => {
          const visibleRow = row.filter((id) => shows(id));
          if (visibleRow.length === 0) return null;
          return (
            <div key={row.join("+") || rowIdx}>
              <RowGap editMode={editMode} anchorId={row[0]} onDropGap={movePanelToGap} />
              <div className={"dash-row" + (visibleRow.length === 2 ? " dash-grid" : "")}>
                {visibleRow.map((id) => (
                  <DraggableBlock key={id} id={id} hidden={isHidden(id)} editMode={editMode} onToggleHidden={toggleHidden} onDropOnId={mergePanels}>
                    {renderPanel(id)}
                  </DraggableBlock>
                ))}
              </div>
            </div>
          );
        })}
        <RowGap editMode={editMode} anchorId={null} onDropGap={movePanelToGap} />
      </div>
      {confirmActionDialog}
    </>
  );
}
