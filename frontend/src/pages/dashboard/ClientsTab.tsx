import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../../api/client";
import { useData } from "../../context/DataContext";
import type { Client, ClientImportResult, ClientNote, Rental } from "../../api/types";
import { RATING_META, RENTAL_META, Badge, rentalDisplayStatus } from "../../lib/statusMeta";
import { money, fmtDate, colorFromId, initials } from "../../lib/format";
import { IconClose, IconEdit, IconTrash, IconPhone, IconSend } from "../../lib/icons";
import { useConfirm } from "../../components/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { usePersistedState } from "../../lib/persist";
import { parseCsv, csvRowsToObjects, toCsv } from "../../lib/csv";
import { DocModal, buildContractDoc } from "./documents";
import { Dropdown } from "../../components/Dropdown";

/* ============================================================
   Форма добавления/изменения клиента — двадцать четвёртый проход (обзор
   вкладки «Клиенты», п.1 обзора: раньше редактирования не было вообще,
   только создание + смена рейтинга из слайдовера). Backend уже был готов
   (PATCH .../clients/{id} принимает любое подмножество полей — см.
   ClientUpdate), не хватало только формы на фронте.
   ============================================================ */
interface ClientFormState {
  name: string;
  phone: string;
  email: string;
  doc: string;
  notes: string;
  // ---- 25-й проход (обзор «глазами обычного пользователя») ----
  clientType: "individual" | "company";
  contactPerson: string;
  inn: string;
  defaultDiscountPercent: string; // строкой, как остальные числовые поля форм в проекте (см. daily_rate у оборудования)
  tags: string;
}

const EMPTY_CLIENT_FORM: ClientFormState = {
  name: "",
  phone: "",
  email: "",
  doc: "",
  notes: "",
  clientType: "individual",
  contactPerson: "",
  inn: "",
  defaultDiscountPercent: "",
  tags: "",
};

function formFromClient(c: Client): ClientFormState {
  return {
    name: c.name,
    phone: c.phone ?? "",
    email: c.email ?? "",
    doc: c.doc ?? "",
    notes: c.notes ?? "",
    clientType: c.client_type,
    contactPerson: c.contact_person ?? "",
    inn: c.inn ?? "",
    defaultDiscountPercent: c.default_discount_percent != null ? String(c.default_discount_percent) : "",
    tags: c.tags ?? "",
  };
}

function clientFormToPayload(f: ClientFormState) {
  return {
    name: f.name.trim(),
    phone: f.phone.trim() || null,
    email: f.email.trim() || null,
    doc: f.doc.trim() || null,
    notes: f.notes.trim() || null,
    client_type: f.clientType,
    // Реквизиты организации сохраняются, только когда действительно указан
    // тип "Организация" — если сотрудник заполнил поле, а потом переключил
    // тип обратно на "Физлицо", реквизиты не должны молча остаться в базе.
    contact_person: f.clientType === "company" ? f.contactPerson.trim() || null : null,
    inn: f.clientType === "company" ? f.inn.trim() || null : null,
    default_discount_percent: f.defaultDiscountPercent.trim() === "" ? null : Number(f.defaultDiscountPercent),
    tags: f.tags.trim() || null,
  };
}

/** Сравнение текущей формы с исходным состоянием — тот же смысл, что и
 * isFormDirty у формы оборудования (EquipmentTab.tsx): спрашивать
 * подтверждение закрытия только если пользователь реально что-то изменил. */
function isClientFormDirty(current: ClientFormState, initial: ClientFormState): boolean {
  return (Object.keys(current) as (keyof ClientFormState)[]).some((k) => current[k] !== initial[k]);
}

/** Модалка добавления/изменения клиента — тот же идиом `<dialog>`, что и
 * EquipmentFormModal (ref + showModal()/close() в useEffect по `open`),
 * только без ступенчатого тарифа и прочей специфики оборудования: у
 * клиента всего пять редактируемых полей. */
function ClientFormModal({
  open,
  title,
  initial,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initial: ClientFormState;
  error: string | null;
  onClose: () => void;
  onSubmit: (form: ClientFormState) => Promise<void> | void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<ClientFormState>(initial);
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { confirm: confirmDiscard, dialog: discardDialog } = useConfirm();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (open) {
      setForm(initial);
      setLocalError(null);
      const raf = requestAnimationFrame(() => nameInputRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function validateLocally(): string | null {
    if (!form.name.trim()) return "Имя/название не может состоять из одних пробелов";
    return null;
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problem = validateLocally();
    if (problem) {
      setLocalError(problem);
      return;
    }
    setLocalError(null);
    setSubmitting(true);
    try {
      await onSubmit(form);
    } finally {
      setSubmitting(false);
    }
  }

  async function requestClose() {
    if (submitting) return;
    if (isClientFormDirty(form, initial)) {
      if (!(await confirmDiscard("Несохранённые изменения будут потеряны.", { confirmLabel: "Закрыть без сохранения" })))
        return;
    }
    onClose();
  }

  return (
    <dialog
      id="modal"
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        void requestClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) void requestClose();
      }}
    >
      <form onSubmit={(e) => void handleSubmit(e)}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button type="button" className="icon-btn" onClick={() => void requestClose()} disabled={submitting}>
            <IconClose />
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>Тип клиента</label>
            <div className="segmented">
              <button
                type="button"
                className={form.clientType === "individual" ? "active" : ""}
                onClick={() => setForm({ ...form, clientType: "individual" })}
              >
                Физлицо
              </button>
              <button
                type="button"
                className={form.clientType === "company" ? "active" : ""}
                onClick={() => setForm({ ...form, clientType: "company" })}
              >
                Организация
              </button>
            </div>
          </div>
          <div className="field">
            <label>Имя / название</label>
            <input
              required
              ref={nameInputRef}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Например, Иванов Иван или ООО «Стройка»"
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label>Телефон</label>
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+7 900 000-00-00" />
            </div>
            <div className="field">
              <label>Email</label>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label>{form.clientType === "company" ? "Документ / реквизиты" : "Документ (паспорт)"}</label>
            <input value={form.doc} onChange={(e) => setForm({ ...form, doc: e.target.value })} />
          </div>
          {form.clientType === "company" && (
            <div className="field-row">
              <div className="field">
                <label>Контактное лицо</label>
                <input
                  value={form.contactPerson}
                  onChange={(e) => setForm({ ...form, contactPerson: e.target.value })}
                  placeholder="Кто по факту забирает/сдаёт технику"
                />
              </div>
              <div className="field">
                <label>ИНН</label>
                <input value={form.inn} onChange={(e) => setForm({ ...form, inn: e.target.value })} />
              </div>
            </div>
          )}
          <div className="field-row">
            <div className="field">
              <label>Скидка по умолчанию, % (необязательно)</label>
              <input
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={form.defaultDiscountPercent}
                onChange={(e) => setForm({ ...form, defaultDiscountPercent: e.target.value })}
                placeholder="0"
              />
              <div className="field-hint">Подсказка при создании новой аренды этому клиенту — можно поменять на месте.</div>
            </div>
            <div className="field">
              <label>Метки, через запятую (необязательно)</label>
              <input
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
                placeholder="постоянный, оптовик"
              />
            </div>
          </div>
          <div className="field">
            <label>Заметка</label>
            <textarea
              rows={3}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Что стоит помнить про этого клиента"
            />
          </div>
          {(localError || error) && <div className="form-error">{localError || error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={() => void requestClose()} disabled={submitting}>
            Отмена
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </form>
      {discardDialog}
    </dialog>
  );
}

/* ============================================================
   Фильтр по надёжности + сортировка таблицы — по образцу FILTERS/
   EQUIPMENT_SORT_COLUMNS из EquipmentTab.tsx. Рейтингов всего три и они
   закрытые (enum на backend), так что сегментированный переключатель
   подходит лучше, чем мультивыбор-дропдаун, каким сделан фильтр категорий
   у оборудования (тот нужен именно из-за открытого списка категорий).
   ============================================================ */
const RATING_FILTERS: { id: string; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "normal", label: "Надёжные" },
  { id: "watch", label: "На контроле" },
  { id: "blacklist", label: "Чёрный список" },
];

const CLIENT_SORT_COLUMNS: { key: string; label: string }[] = [
  { key: "name", label: "Имя" },
  { key: "doc", label: "Документ" },
  { key: "rating", label: "Рейтинг" },
  { key: "rentals", label: "Аренды" },
  { key: "lastRental", label: "Последняя аренда" },
];

// Приоритет при сортировке по рейтингу — проблемные клиенты первые, тем же
// принципом, что и EQUIPMENT_STATUS_PRIORITY (overdue впереди available).
const CLIENT_RATING_PRIORITY: Record<string, number> = { blacklist: 0, watch: 1, normal: 2 };

interface ClientSort {
  key: string | null;
  dir: "asc" | "desc";
}

/** Дата начала самой свежей аренды клиента (по всей истории, не только
 * активной) — "" для клиента, который ни разу не арендовал, что при
 * сортировке по возрастанию корректно ставит его первым, рядом с самыми
 * "спящими" (25-й проход, п.6 обзора: сортировка/фильтр для возврата
 * клиентов, которые давно не арендовали). */
function lastRentalDate(clientId: string, rentals: Rental[]): string {
  let latest = "";
  for (const r of rentals) {
    if (r.client_id === clientId && r.start_date > latest) latest = r.start_date;
  }
  return latest;
}

const DORMANT_DAYS_THRESHOLD = 90;

/** "Спящий" клиент — арендовал хотя бы раз, но не в последние
 * DORMANT_DAYS_THRESHOLD дней (25-й проход, п.6): клиентов, которые ни разу
 * не арендовали, в этот фильтр намеренно не включаем — это отдельная
 * категория "новый, ещё не сдавали", возврат интересен именно для тех, кто
 * уже был активен и затих. */
function isDormantClient(clientId: string, rentals: Rental[]): boolean {
  const last = lastRentalDate(clientId, rentals);
  if (!last) return false;
  const daysSince = (Date.now() - new Date(last).getTime()) / (1000 * 60 * 60 * 24);
  return daysSince >= DORMANT_DAYS_THRESHOLD;
}

function clientSortValue(c: Client, key: string, rentals: Rental[]): string | number {
  if (key === "name") return c.name.toLowerCase();
  if (key === "doc") return (c.doc ?? "").toLowerCase();
  if (key === "rating") return CLIENT_RATING_PRIORITY[c.rating] ?? 99;
  if (key === "rentals") return rentals.filter((r) => r.client_id === c.id).length;
  if (key === "lastRental") return lastRentalDate(c.id, rentals);
  return 0;
}

function sortClientList(list: Client[], sort: ClientSort, rentals: Rental[]): Client[] {
  if (!sort.key) return list;
  const key = sort.key;
  const dir = sort.dir === "desc" ? -1 : 1;
  return [...list].sort((a, b) => {
    const va = clientSortValue(a, key, rentals);
    const vb = clientSortValue(b, key, rentals);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return a.name.localeCompare(b.name, "ru");
  });
}

/** Есть ли у клиента незакрытая аренда (в работе или забронирована) — тот
 * же смысл и та же механика, что у equipmentHasOpenRentals в
 * EquipmentTab.tsx: определяется на фронте из уже загруженного списка
 * аренд, без отдельного запроса. "overdue" backend никогда не хранит как
 * реальный статус (см. rentalDisplayStatus) — просроченная аренда это
 * всегда status==="active" в базе, так что отдельно её проверять не нужно. */
function clientHasOpenRental(clientId: string, rentals: Rental[]): boolean {
  return rentals.some((r) => r.client_id === clientId && (r.status === "active" || r.status === "booked"));
}

/** Есть ли у клиента ЛЮБАЯ история аренд, включая уже завершённые/отменённые
 * — найдено при разборе бага удаления (24-й проход): backend теперь
 * отклоняет удаление клиента с любой историей, не только с открытой (см.
 * app/api/routes/clients.py:delete_client — Rental.client_id стоит на
 * ondelete="RESTRICT", это финансовая история). Тот же принцип "не тратим
 * клик на действие, которое backend всё равно отклонит", что и у
 * clientHasOpenRental — используется только для предупреждения ДО запроса
 * на удаление, не для чего-то ещё. */
function clientHasAnyRental(clientId: string, rentals: Rental[]): boolean {
  return rentals.some((r) => r.client_id === clientId);
}

/** Есть ли у клиента ПРЯМО СЕЙЧАС просроченная аренда — используется и для
 * бейджа в таблице, и для быстрого фильтра "Только с просрочкой" (24-й
 * проход, п.5 обзора: "просроченный клиент — это сигнал, который владелец
 * хочет видеть первым делом, не открывая карточку каждого"). */
function clientHasOverdueNow(clientId: string, rentals: Rental[]): boolean {
  return rentals.some((r) => r.client_id === clientId && rentalDisplayStatus(r) === "overdue");
}

/* ============================================================
   Экспорт CSV — по образцу exportEquipmentCsv (equipment/csv.ts): выгрузка
   ТЕКУЩЕГО видимого списка (с учётом поиска/фильтра рейтинга/просрочки и
   сортировки) плюс пара расчётных колонок (аренды всего/просрочено сейчас/
   выручка за всё время), которых нет в самой таблице, но которые
   пригодятся для выгрузки в бухгалтерию или для архива.
   ============================================================ */
const CLIENT_EXPORT_HEADER = [
  "name",
  "phone",
  "email",
  "doc",
  "rating",
  "notes",
  "tags",
  "rentals_total",
  "overdue_now",
  "lifetime_revenue",
  "created_at",
];

function exportClientsCsv(list: Client[], rentals: Rental[]) {
  const rows = list.map((c) => {
    const clientRentals = rentals.filter((r) => r.client_id === c.id);
    const overdueNow = clientRentals.filter((r) => rentalDisplayStatus(r) === "overdue").length;
    const lifetimeRevenue = clientRentals.filter((r) => r.status === "returned").reduce((s, r) => s + r.total, 0);
    return [
      c.name,
      c.phone ?? "",
      c.email ?? "",
      c.doc ?? "",
      RATING_META[c.rating].label,
      c.notes ?? "",
      c.tags ?? "",
      clientRentals.length,
      overdueNow,
      Math.round(lifetimeRevenue),
      c.created_at.slice(0, 10),
    ];
  });
  const csv = toCsv(CLIENT_EXPORT_HEADER, rows);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }); // BOM — см. downloadImportTemplate в equipment/csv.ts
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Клиенты ${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ============================================================
   Обнаружение возможного дубля при создании — найдено при обзоре вкладки
   «Клиенты» (24-й проход, п.3): ни фронт, ни backend раньше никак не
   предупреждали, что клиент с таким же телефоном или именем уже есть в
   базе, хотя при нескольких сотрудниках один и тот же человек легко
   заводится дважды. Это мягкое предупреждение (см. handleSubmitForm), а не
   запрет — окончательное решение остаётся за сотрудником, который лучше
   знает, один это человек или тёзка/однофамилец с похожим номером.
   ============================================================ */
function normalizePhoneDigits(phone: string | null | undefined): string {
  return (phone ?? "").replace(/\D/g, "");
}

/** Расстояние Левенштейна — стандартный алгоритм редакционного расстояния
 * (число вставок/удалений/замен символов, чтобы превратить одну строку в
 * другую), используется ниже для нечёткого сравнения имён (25-й проход,
 * п.9 обзора: точное совпадение из 24-го прохода не ловит опечатки —
 * "Иванов Иван" и "Иваннов Иван" считались разными клиентами). Классическая
 * динамика с одной "текущей" строкой вместо полной O(n·m) матрицы —
 * достаточно быстро для сравнения с базой в несколько сотен клиентов на
 * каждое нажатие клавиши, не нужна отдельная библиотека ради одной функции. */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[b.length];
}

/** Похожи ли два имени с учётом опечаток — расстояние Левенштейна,
 * нормализованное по длине более длинной строки (порог 0.2, т.е. до ~20%
 * символов может отличаться), плюс отдельный порог для совсем коротких
 * имён (1-2 отличающихся символа на коротком имени — уже, скорее всего,
 * другой человек, не опечатка). */
function namesLookSimilar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen < 4) return false; // слишком короткие имена — риск ложных срабатываний выше пользы
  const distance = levenshteinDistance(a, b);
  return distance <= Math.max(1, Math.floor(maxLen * 0.2));
}

interface DuplicateMatch {
  client: Client;
  reason: "phone" | "name" | "fuzzy_name";
}

function findPossibleDuplicate(form: ClientFormState, clients: Client[]): DuplicateMatch | null {
  const phone = normalizePhoneDigits(form.phone);
  const name = form.name.trim().toLowerCase();
  for (const c of clients) {
    if (phone && normalizePhoneDigits(c.phone) === phone) return { client: c, reason: "phone" };
  }
  for (const c of clients) {
    if (name && c.name.trim().toLowerCase() === name) return { client: c, reason: "name" };
  }
  // Нечёткое сравнение — вторым проходом, ПОСЛЕ точных совпадений (точное
  // совпадение всегда более уверенный сигнал, чем похожесть по опечатке).
  for (const c of clients) {
    if (name && namesLookSimilar(name, c.name.trim().toLowerCase())) return { client: c, reason: "fuzzy_name" };
  }
  return null;
}

/* ============================================================
   Импорт CSV — по образцу EquipmentImportModal (equipment/EquipmentImportModal.tsx):
   шаблон → выбор файла → клиентский предпросмотр/лёгкая валидация → отправка
   файла на backend (там настоящая построчная валидация, см.
   app/api/routes/clients.py:import_clients) → отчёт по каждой строке.
   Найдено при обзоре вкладки «Клиенты» (24-й проход, п.2): экспорт уже был
   реализован, импорта не было, хотя у Оборудования есть оба.
   ============================================================ */
const CLIENT_IMPORT_TEMPLATE_HEADER = ["name", "phone", "email", "doc", "rating", "notes", "tags"];
const CLIENT_IMPORT_TEMPLATE_EXAMPLE = ["Иванов Иван", "+7 900 000-00-00", "ivan@example.com", "", "normal", "", ""];

function downloadClientImportTemplate() {
  const csv = toCsv(CLIENT_IMPORT_TEMPLATE_HEADER, [CLIENT_IMPORT_TEMPLATE_EXAMPLE]);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "clients-import-template.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

interface ClientImportPreviewRow {
  row: number;
  values: Record<string, string>;
  problems: string[];
}

function validateClientImportRow(obj: Record<string, string>): string[] {
  const problems: string[] = [];
  if (!obj.name) problems.push("нет имени/названия");
  const rating = obj.rating.trim().toLowerCase();
  if (rating && !["normal", "watch", "blacklist", "надёжный", "надежный", "на контроле", "чёрный список", "черный список"].includes(rating)) {
    problems.push("неизвестный рейтинг");
  }
  return problems;
}

function ClientImportModal({
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
  const [preview, setPreview] = useState<ClientImportPreviewRow[]>([]);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<ClientImportResult | null>(null);

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
    if (!header.includes("name")) {
      setHeaderError("В заголовке файла должна быть как минимум колонка: name");
      return;
    }
    const objects = csvRowsToObjects(parsed);
    setPreview(
      objects.map((obj, idx) => ({
        row: idx + 2,
        values: Object.fromEntries(CLIENT_IMPORT_TEMPLATE_HEADER.map((h) => [h, obj[h] || ""])),
        problems: validateClientImportRow(Object.fromEntries(CLIENT_IMPORT_TEMPLATE_HEADER.map((h) => [h, obj[h] || ""]))),
      }))
    );
  }

  function updateCell(rowIdx: number, field: string, value: string) {
    setPreview((prev) =>
      prev.map((r, i) => {
        if (i !== rowIdx) return r;
        const values = { ...r.values, [field]: value };
        return { ...r, values, problems: validateClientImportRow(values) };
      })
    );
  }

  async function handleImport() {
    if (!file || preview.length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const rows = preview.map((r) => CLIENT_IMPORT_TEMPLATE_HEADER.map((h) => r.values[h] ?? ""));
      const csv = toCsv(CLIENT_IMPORT_TEMPLATE_HEADER, rows);
      const editedFile = new File(["﻿" + csv], file.name, { type: "text/csv;charset=utf-8" });
      const form = new FormData();
      form.append("file", editedFile);
      const res = await api.postForm<ClientImportResult>(`/businesses/${businessId}/clients/import`, form);
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
    <dialog
      id="modal"
      className="wide"
      ref={ref}
      onClose={handleClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="modal-head">
        <h3>Массовый импорт клиентов из CSV</h3>
        <button type="button" className="icon-btn" onClick={handleClose}>
          <IconClose />
        </button>
      </div>
      <div className="modal-body">
        {!result && (
          <>
            <div className="field-hint" style={{ marginBottom: "10px" }}>
              Файл CSV с заголовком в первой строке. Обязательная колонка: <code>name</code>. Необязательные:{" "}
              <code>phone</code>, <code>email</code>, <code>doc</code>, <code>rating</code> (
              <code>normal</code>/<code>watch</code>/<code>blacklist</code>, по умолчанию — «Надёжный»), <code>notes</code>,{" "}
              <code>tags</code> (через запятую). Реквизиты организации и скидка по умолчанию через импорт не заводятся —
              для клиентов-организаций удобнее заполнить карточку вручную. Файл, выгруженный отсюда же кнопкой «Экспорт
              CSV», подходит для импорта без правок.
            </div>
            <button type="button" className="btn btn-sm" onClick={downloadClientImportTemplate}>
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
                  {problemCount > 0 ? `, из них с явными проблемами: ${problemCount} (не пройдут импорт)` : ""}. Значения
                  ниже можно поправить прямо здесь — при импорте уйдут именно они, а не исходный файл.
                </div>
                <div className="table-wrap" style={{ maxHeight: "260px", overflowY: "auto", marginTop: "8px" }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Строка</th>
                        <th>Имя</th>
                        <th>Телефон</th>
                        <th>Рейтинг</th>
                        <th>Проблемы</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((r, idx) => (
                        <tr key={r.row}>
                          <td className="mono">{r.row}</td>
                          <td>
                            <input
                              className="table-input"
                              value={r.values.name}
                              onChange={(e) => updateCell(idx, "name", e.target.value)}
                            />
                          </td>
                          <td>
                            <input
                              className="table-input"
                              value={r.values.phone}
                              onChange={(e) => updateCell(idx, "phone", e.target.value)}
                            />
                          </td>
                          <td>
                            <input
                              className="table-input"
                              value={r.values.rating}
                              onChange={(e) => updateCell(idx, "rating", e.target.value)}
                            />
                          </td>
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
                    <th>Имя</th>
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
                          <span style={{ color: "var(--good-ink)", fontWeight: 600 }}>
                            Создано{r.duplicate_warning ? " · возможный дубль по телефону" : ""}
                          </span>
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
  const [modalMode, setModalMode] = useState<"add" | "edit" | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [openClientId, setOpenClientId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkRating, setBulkRating] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [showImport, setShowImport] = useState(false);
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
    ratingCounts[f.id] = bySearch.filter((c) => c.rating === f.id).length;
  }
  const byRating = bySearch.filter((c) => ratingFilter === "all" || c.rating === ratingFilter);
  const overdueNowCount = byRating.filter((c) => clientHasOverdueNow(c.id, rentals)).length;
  const dormantCount = byRating.filter((c) => isDormantClient(c.id, rentals)).length;
  const withFilters = byRating
    .filter((c) => !overdueOnly || clientHasOverdueNow(c.id, rentals))
    .filter((c) => !dormantOnly || isDormantClient(c.id, rentals));
  const list = sortClientList(withFilters, sort, rentals);

  // Сброс выделения при смене фильтров/поиска — тот же принцип, что и в
  // EquipmentTab.tsx: иначе массовое действие могло бы применяться к
  // строкам, которые сейчас не видны на экране.
  useEffect(() => {
    setSelectedIds(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratingFilter, overdueOnly, dormantOnly, search]);

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
        await api.post(`/businesses/${businessId}/clients`, clientFormToPayload(form));
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
   * всё равно отклонит. */
  async function handleDelete(id: string) {
    const client = clients.find((c) => c.id === id);
    if (clientHasOpenRental(id, rentals)) {
      notify("Нельзя удалить: у клиента есть аренда в работе или бронь. Сначала завершите её.");
      return;
    }
    // Найдено при разборе бага удаления (24-й проход): backend теперь
    // отклоняет удаление и с ЗАКРЫТОЙ историей аренд (см. clientHasAnyRental)
    // — сообщаем об этом сразу и предлагаем объединение, не тратя клик
    // пользователя на подтверждение, которое всё равно будет отклонено.
    if (clientHasAnyRental(id, rentals)) {
      notify(
        "Нельзя удалить: у клиента есть история аренд (даже завершённых) — это финансовая история. Если карточка дублирует другую, объедините их из карточки клиента."
      );
      return;
    }
    if (!(await confirm(`Клиент «${client?.name ?? ""}» будет удалён безвозвратно.`, { danger: true }))) return;
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

  /** Массовое удаление — клиенты с ЛЮБОЙ историей аренд (открытой или
   * закрытой) пропускаются без попытки удаления, тот же принцип, что и
   * handleBulkDelete в EquipmentTab.tsx. Раньше здесь проверялась только
   * открытая аренда — расширено вместе с исправлением бага удаления (24-й
   * проход): клиенты с закрытой историей раньше падали бы на бэкенде и
   * учитывались в "Ошибок", а не в "Пропущено", как остальные заблокированные. */
  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    const blocked = ids.filter((id) => clientHasAnyRental(id, rentals));
    const deletable = ids.filter((id) => !clientHasAnyRental(id, rentals));
    if (deletable.length === 0) {
      notify("Ни одного из выбранных клиентов нельзя удалить: у каждого есть история аренд.");
      return;
    }
    const message =
      blocked.length > 0
        ? `Будет безвозвратно удалено клиентов: ${deletable.length} из ${ids.length}. Остальные ${blocked.length} пропущены — у них есть история аренд.`
        : `Будет безвозвратно удалено клиентов: ${deletable.length}.`;
    if (!(await confirmBulk(message, { danger: true }))) return;
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
            (blocked.length > 0 ? ` Пропущено (есть история аренд): ${blocked.length}.` : ""),
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
      <div className="tab-toolbar">
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
          <button
            type="button"
            className={"btn" + (overdueOnly ? " btn-primary" : "")}
            onClick={() => setOverdueOnly((v) => !v)}
            title="Показать только клиентов с просрочкой прямо сейчас"
          >
            Просрочка сейчас ({overdueNowCount})
          </button>
          <button
            type="button"
            className={"btn" + (dormantOnly ? " btn-primary" : "")}
            onClick={() => setDormantOnly((v) => !v)}
            title={`Клиенты, у которых была хотя бы одна аренда, но не за последние ${DORMANT_DAYS_THRESHOLD} дней — повод напомнить о себе`}
          >
            Не арендовали {DORMANT_DAYS_THRESHOLD}+ дней ({dormantCount})
          </button>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button className="btn" onClick={() => setShowImport(true)}>
            Импорт CSV
          </button>
          <button className="btn" onClick={() => exportClientsCsv(list, rentals)} disabled={list.length === 0}>
            Экспорт CSV
          </button>
          <button className="btn btn-primary" onClick={openAddModal}>
            + Добавить
          </button>
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div className="panel" style={{ marginBottom: "10px" }}>
          <div className="panel-body" style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <strong>Выбрано: {selectedIds.size}</strong>
            <Dropdown
              value={bulkRating}
              onChange={setBulkRating}
              placeholder="Изменить рейтинг…"
              disabled={bulkBusy}
              style={{ maxWidth: "200px" }}
              options={[
                { value: "normal", label: "Надёжный" },
                { value: "watch", label: "На контроле" },
                { value: "blacklist", label: "Чёрный список" },
              ]}
            />
            <button className="btn btn-sm" disabled={!bulkRating || bulkBusy} onClick={() => void handleBulkRating()}>
              Применить
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
                {CLIENT_SORT_COLUMNS.map((col) => {
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
                <th></th>
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
                const waDigits = normalizePhoneDigits(c.phone);
                return (
                  <tr key={c.id} data-clickable="true" onClick={() => setOpenClientId(c.id)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selectedIds.has(c.id)} onChange={() => toggleSelected(c.id)} />
                    </td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        {/* Цветной аватар из инициалов — тот же приём, что и у
                            сотрудников в сайдбаре (colorFromId/initials из
                            lib/format.ts), 25-й проход, п.3 обзора. */}
                        <span className="avatar" style={{ background: colorFromId(c.id) }}>{initials(c.name)}</span>
                        <div>
                          <div className="cell-name">
                            {c.name}
                            {c.client_type === "company" && (
                              <span className="badge-tag" title="Организация" style={{ marginLeft: "6px" }}>
                                Орг.
                              </span>
                            )}
                          </div>
                          <div className="cell-sub" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                            <span>{c.phone ?? "—"}</span>
                            {c.phone && (
                              <span onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex", gap: "4px" }}>
                                {/* Быстрый звонок/WhatsApp прямо из строки таблицы
                                    (25-й проход, п.10 обзора) — без открытия
                                    карточки клиента. */}
                                <a className="icon-btn" href={`tel:${c.phone}`} title="Позвонить">
                                  <IconPhone />
                                </a>
                                <a
                                  className="icon-btn"
                                  href={`https://wa.me/${waDigits}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  title="Написать в WhatsApp"
                                >
                                  <IconSend />
                                </a>
                              </span>
                            )}
                          </div>
                          {tagList.length > 0 && (
                            <div style={{ marginTop: "4px", display: "flex", gap: "4px", flexWrap: "wrap" }}>
                              {tagList.map((t) => (
                                <span key={t} className="badge-tag">
                                  {t}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>{c.doc ?? "—"}</td>
                    <td>
                      <Badge meta={RATING_META[c.rating]} />
                    </td>
                    <td>
                      {clientRentals.length} всего{activeCount > 0 ? `, ${activeCount} сейчас` : ""}
                      {overdueNow > 0 && (
                        <div style={{ marginTop: "4px" }}>
                          <Badge meta={{ label: `Просрочено × ${overdueNow}`, tone: "critical" }} />
                        </div>
                      )}
                    </td>
                    <td>{lastRental ? fmtDate(lastRental) : "—"}</td>
                    <td onClick={(e) => e.stopPropagation()} style={{ textAlign: "right", whiteSpace: "nowrap" }}>
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

export function ClientDetailPanel({
  businessId,
  clientId,
  onClose,
  onEdit,
  onDelete,
  onCreateRental,
}: {
  businessId: string;
  clientId: string;
  onClose: () => void;
  // Необязательный — с дашборда слайдовер открывается в сокращённом
  // варианте без кнопки "Изменить" (тот же принцип, что и у onCopy в
  // EquipmentDetailPanel: полноценные действия нужны только во вкладке
  // «Клиенты», где и живёт сама форма/модалка).
  onEdit?: (id: string) => void;
  onDelete: (id: string) => void;
  // "+ Новая аренда" прямо из карточки (25-й проход, п.1 обзора) —
  // необязательный по тому же принципу, что и onEdit: открывает ГЛОБАЛЬНУЮ
  // модалку "Новая аренда", которая живёт на уровне DashboardShell (см.
  // Dashboard.tsx), а не здесь — панель клиента сама модалку не рендерит,
  // только сообщает наверх, для кого её открыть.
  onCreateRental?: (clientId: string) => void;
}) {
  const { clients, rentals, equipment, reloadClients, reloadRentals } = useData();
  const client = clients.find((c) => c.id === clientId);
  const { notify } = useToast();
  // Смена рейтинга на "чёрный список" — по весу последствий сопоставима с
  // удалением (это сигнал всей команде "не работать с этим клиентом"), но
  // раньше применялась одним кликом без подтверждения (24-й проход, п.6
  // обзора). Начиная с 25-го прохода (п.5) подтверждение заменено на
  // BlacklistReasonModal — не просто "да/нет", а обязательный ввод причины,
  // чтобы через полгода кто-то другой из команды видел, ПОЧЕМУ клиент
  // проблемный. Понижение из чёрного списка обратно и переход в "На
  // контроле" подтверждения не требуют — необратимого в них ничего нет.
  const [showBlacklistReason, setShowBlacklistReason] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [docModal, setDocModal] = useState<{ title: string; node: ReactNode } | null>(null);
  const [showMerge, setShowMerge] = useState(false);

  if (!client) return null;

  const history = rentals
    .filter((r) => r.client_id === clientId)
    .slice()
    .sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
  // Список ограничен по умолчанию (24-й проход, п.5 обзора) — у постоянного
  // клиента с десятками аренд слайдовер иначе растягивался бы бесконечно.
  const HISTORY_PAGE = 6;
  const visibleHistory = showAllHistory ? history : history.slice(0, HISTORY_PAGE);

  const lifetimeRevenue = history.filter((r) => r.status === "returned").reduce((s, r) => s + r.total, 0);
  const lateReturns = history.filter((r) => r.status === "returned" && r.actual_return && r.actual_return > r.end_date).length;
  const currentlyOverdue = history.filter((r) => rentalDisplayStatus(r) === "overdue").length;
  const totalLate = lateReturns + currentlyOverdue;
  const depositHeld = history
    .filter((r) => {
      const s = rentalDisplayStatus(r);
      return s === "active" || s === "overdue";
    })
    .reduce((s, r) => s + r.deposit_total, 0);

  async function applyRating(rating: Client["rating"], blacklistReason: string | null) {
    try {
      await api.patch(`/businesses/${businessId}/clients/${clientId}`, {
        rating,
        // Причина чёрного списка очищается фронтом при снятии статуса (см.
        // комментарий у Client.blacklist_reason в app/models/inventory.py) —
        // не тащим за собой старую причину, если клиент потом реабилитирован
        // и снова туда же попал по новой причине.
        blacklist_reason: blacklistReason,
      });
      await reloadClients();
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Не удалось изменить рейтинг");
    }
  }

  async function setRating(rating: Client["rating"]) {
    // Ненулевое утверждение: TS не протягивает сужение "client всегда
    // определён" (см. `if (!client) return null;` выше по компоненту) через
    // вложенное ОБЪЯВЛЕНИЕ функции (в отличие от стрелочной функции) — а
    // setRating вызывается уже после того, как ранний return null отработал.
    if (rating === "blacklist" && client!.rating !== "blacklist") {
      // Причина вводится в отдельной модалке (см. BlacklistReasonModal ниже)
      // — сама смена рейтинга откладывается до её отправки.
      setShowBlacklistReason(true);
      return;
    }
    await applyRating(rating, rating === "blacklist" ? client!.blacklist_reason : null);
  }

  const tagList = (client.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);

  return (
    <div className="slideover">
      <div className="slideover-head">
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span className="avatar" style={{ background: colorFromId(client.id), width: 36, height: 36, fontSize: "14px" }}>
            {initials(client.name)}
          </span>
          <div>
            <h3>
              {client.name}
              {client.client_type === "company" && (
                <span className="badge-tag" title="Организация">
                  Орг.
                </span>
              )}
            </h3>
            <div style={{ color: "var(--muted)", fontSize: "12.5px", marginTop: "2px" }}>{client.phone ?? "—"}</div>
          </div>
        </div>
        <button className="icon-btn" onClick={onClose}>
          <IconClose />
        </button>
      </div>

      {client.phone && (
        <div className="slideover-section" style={{ display: "flex", gap: "8px" }}>
          <a className="btn btn-sm" href={`tel:${client.phone}`}>
            <IconPhone /> Позвонить
          </a>
          <a className="btn btn-sm" href={`https://wa.me/${normalizePhoneDigits(client.phone)}`} target="_blank" rel="noreferrer">
            <IconSend /> WhatsApp
          </a>
        </div>
      )}

      <div className="slideover-section">
        <h4>Надёжность</h4>
        <div style={{ marginBottom: "10px" }}>
          <Badge meta={RATING_META[client.rating]} />
        </div>
        {client.rating === "blacklist" && client.blacklist_reason && (
          <div className="field-hint" style={{ marginBottom: "10px" }}>
            Причина: {client.blacklist_reason}
          </div>
        )}
        <div className="rating-picker">
          <button
            className={"btn btn-sm" + (client.rating === "normal" ? " btn-primary" : "")}
            onClick={() => void setRating("normal")}
          >
            Надёжный
          </button>
          <button
            className={"btn btn-sm" + (client.rating === "watch" ? " btn-primary" : "")}
            onClick={() => void setRating("watch")}
          >
            На контроле
          </button>
          <button
            className={"btn btn-sm" + (client.rating === "blacklist" ? " btn-primary" : "")}
            onClick={() => void setRating("blacklist")}
          >
            Чёрный список
          </button>
        </div>
      </div>

      <div className="slideover-section">
        <h4>Показатели</h4>
        <div className="kv-grid">
          <span className="k">Выручка за всё время</span>
          <span className="mono">{money(lifetimeRevenue)}</span>
          <span className="k">Просрочек за всё время</span>
          <span className={"mono" + (totalLate > 0 ? " text-critical" : "")}>{totalLate}</span>
          <span className="k">Депозит на удержании сейчас</span>
          <span className="mono">{money(depositHeld)}</span>
          <span className="k">Последняя аренда</span>
          <span>{lastRentalDate(client.id, rentals) ? fmtDate(lastRentalDate(client.id, rentals)) : "—"}</span>
        </div>
      </div>

      <div className="slideover-section">
        <h4>Контакты</h4>
        <div className="kv-grid">
          <span className="k">Email</span>
          <span>{client.email ?? "—"}</span>
          <span className="k">Документ</span>
          <span>{client.doc ?? "—"}</span>
          {client.client_type === "company" && (
            <>
              <span className="k">Контактное лицо</span>
              <span>{client.contact_person ?? "—"}</span>
              <span className="k">ИНН</span>
              <span>{client.inn ?? "—"}</span>
            </>
          )}
          <span className="k">Скидка по умолчанию</span>
          <span>{client.default_discount_percent != null ? `${client.default_discount_percent}%` : "—"}</span>
          <span className="k">В базе с</span>
          <span>{fmtDate(client.created_at.slice(0, 10))}</span>
        </div>
        {tagList.length > 0 && (
          <div style={{ marginTop: "10px", display: "flex", gap: "4px", flexWrap: "wrap" }}>
            {tagList.map((t) => (
              <span key={t} className="badge-tag">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>

      {client.notes && (
        <div className="slideover-section">
          <h4>Заметки</h4>
          <div style={{ fontSize: "13.5px" }}>{client.notes}</div>
        </div>
      )}

      <ClientNotesJournal businessId={businessId} clientId={clientId} />

      <div className="slideover-section">
        <h4>История аренд · {history.length}</h4>
        {history.length === 0 ? (
          <div className="empty-note">Ещё не сдавалось в аренду</div>
        ) : (
          <>
            {visibleHistory.map((r) => (
              // Клик открывает договор аренды (24-й проход, п.5 обзора: раньше
              // история была статичным текстом, ни одна строка никуда не вела).
              <div
                className="mini-item clickable"
                key={r.id}
                title="Открыть договор аренды"
                onClick={() => setDocModal({ title: "Договор аренды", node: buildContractDoc(r, client, equipment) })}
              >
                <span>
                  {r.items.map((it) => equipment.find((eq) => eq.id === it.equipment_id)?.name ?? "—").join(", ")} ·{" "}
                  {fmtDate(r.start_date)}—{fmtDate(r.end_date)}
                </span>
                <Badge meta={RENTAL_META[rentalDisplayStatus(r)]} />
              </div>
            ))}
            {history.length > HISTORY_PAGE && (
              <button
                type="button"
                className="btn btn-sm"
                style={{ marginTop: "8px" }}
                onClick={() => setShowAllHistory((v) => !v)}
              >
                {showAllHistory ? "Свернуть" : `Показать ещё ${history.length - HISTORY_PAGE}`}
              </button>
            )}
          </>
        )}
      </div>

      <div className="slideover-section" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        {/* "+ Новая аренда" прямо из карточки (25-й проход, п.1 обзора) —
            открывает глобальную модалку выше по дереву (см. комментарий у
            onCreateRental в сигнатуре компонента), доступна везде, где
            открыта карточка (и во вкладке "Клиенты", и с дашборда). */}
        {onCreateRental && (
          <button className="btn btn-primary" onClick={() => onCreateRental(clientId)}>
            + Новая аренда
          </button>
        )}
        {onEdit && (
          <button className="btn" onClick={() => onEdit(clientId)}>
            Изменить
          </button>
        )}
        {/* Слияние дублей (24-й проход, п.7 обзора) — доступно только там же,
            где и полноценное редактирование (см. комментарий у onEdit выше),
            и только если в бизнесе есть с кем объединять. */}
        {onEdit && clients.length > 1 && (
          <button className="btn" onClick={() => setShowMerge(true)}>
            Объединить с другим клиентом
          </button>
        )}
        <button
          className="btn btn-danger-ghost"
          onClick={() => {
            onDelete(clientId);
          }}
        >
          Удалить
        </button>
      </div>

      <DocModal title={docModal?.title ?? ""} open={!!docModal} onClose={() => setDocModal(null)}>
        {docModal?.node}
      </DocModal>

      {showMerge && (
        <MergeClientModal
          businessId={businessId}
          source={client}
          clients={clients}
          onClose={() => setShowMerge(false)}
          onMerged={async () => {
            setShowMerge(false);
            await Promise.all([reloadClients(), reloadRentals()]);
            onClose();
          }}
        />
      )}

      {showBlacklistReason && (
        <BlacklistReasonModal
          clientName={client.name}
          onClose={() => setShowBlacklistReason(false)}
          onConfirm={async (reason) => {
            setShowBlacklistReason(false);
            await applyRating("blacklist", reason);
          }}
        />
      )}
    </div>
  );
}

/** Слияние дублей клиента — по образцу общего idiom `<dialog>` в проекте.
 * source — карточка, которая исчезнет; выбранная в селекте цель остаётся и
 * получает всю историю аренд source (см. app/api/routes/clients.py:merge_client).
 * Найдено при обзоре вкладки «Клиенты» (24-й проход, п.7): раньше объединить
 * случайно заведённых дублей можно было только вручную через API. */
function MergeClientModal({
  businessId,
  source,
  clients,
  onClose,
  onMerged,
}: {
  businessId: string;
  source: Client;
  clients: Client[];
  onClose: () => void;
  onMerged: () => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [targetId, setTargetId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
  }, []);

  const candidates = clients.filter((c) => c.id !== source.id);
  const target = candidates.find((c) => c.id === targetId);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) {
      setError("Выберите клиента, в которого нужно перенести историю");
      return;
    }
    if (
      !(await confirm(
        `Карточка «${source.name}» будет удалена, вся её история аренд перейдёт клиенту «${target.name}». Отменить это действие будет нельзя.`,
        { danger: true, confirmLabel: "Объединить" }
      ))
    )
      return;
    setError(null);
    setSaving(true);
    try {
      await api.post(`/businesses/${businessId}/clients/${source.id}/merge`, { into_client_id: target.id });
      await onMerged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось объединить клиентов");
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      id="modal"
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form onSubmit={(e) => void handleSubmit(e)}>
        <div className="modal-head">
          <h3>Объединить с другим клиентом</h3>
          <button type="button" className="icon-btn" onClick={onClose} disabled={saving}>
            <IconClose />
          </button>
        </div>
        <div className="modal-body">
          <div className="field-hint" style={{ marginBottom: "10px" }}>
            Вся история аренд клиента «{source.name}» будет перенесена в выбранную карточку, а карточка «{source.name}» —
            удалена. Используйте, если это дубль. Данные самой карточки (телефон/email/заметка) не переносятся —
            заранее скопируйте нужное в целевую карточку вручную, если требуется.
          </div>
          <div className="field">
            <label>Перенести историю в</label>
            <Dropdown
              value={targetId}
              onChange={setTargetId}
              placeholder="Выберите клиента"
              options={candidates.map((c) => ({ value: c.id, label: c.name + (c.phone ? ` · ${c.phone}` : "") }))}
            />
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            Отмена
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !targetId}>
            {saving ? "Объединяем…" : "Объединить"}
          </button>
        </div>
      </form>
      {confirmDialog}
    </dialog>
  );
}

/** Причина занесения в чёрный список (25-й проход, п.5 обзора) — простой
 * `<dialog>` со свободным текстовым полем, тем же идиомом, что и остальные
 * модалки в файле. Отдельная модалка, а не общий useConfirm() (тот умеет
 * только да/нет, свободный текст не собирает) — см. Client.blacklist_reason
 * в app/models/inventory.py. */
function BlacklistReasonModal({
  clientName,
  onClose,
  onConfirm,
}: {
  clientName: string;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void> | void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onConfirm(reason.trim());
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <dialog
      id="modal"
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form onSubmit={(e) => void handleSubmit(e)}>
        <div className="modal-head">
          <h3>В чёрный список — «{clientName}»</h3>
          <button type="button" className="icon-btn" onClick={onClose} disabled={submitting}>
            <IconClose />
          </button>
        </div>
        <div className="modal-body">
          <div className="field-hint" style={{ marginBottom: "10px" }}>
            Об этом стоит знать всей команде — укажите, что случилось, чтобы через полгода коллеге не пришлось
            разбираться заново.
          </div>
          <div className="field">
            <label>Причина</label>
            <textarea
              autoFocus
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Например: не вернул технику вовремя дважды подряд"
            />
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            Отмена
          </button>
          <button type="submit" className="btn btn-danger" disabled={submitting}>
            {submitting ? "Сохраняем…" : "В чёрный список"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** Журнал датированных записей по клиенту (25-й проход, п.4 обзора) — в
 * отличие от Client.notes (одна затираемая памятка выше), append-only
 * лента с автором и временем каждой записи (см. ClientNote в
 * app/models/inventory.py). Загружается отдельным запросом при открытии
 * карточки — та же причина, что и у остального содержимого слайдовера
 * (история аренд, показатели): не тащить это в общий список клиентов,
 * который и так может быть большим. */
function ClientNotesJournal({ businessId, clientId }: { businessId: string; clientId: string }) {
  const [notes, setNotes] = useState<ClientNote[] | null>(null);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setNotes(null);
    api
      .get<ClientNote[]>(`/businesses/${businessId}/clients/${clientId}/notes`)
      .then((res) => {
        if (!cancelled) setNotes(res);
      })
      .catch(() => {
        if (!cancelled) setNotes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, clientId]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      const created = await api.post<ClientNote>(`/businesses/${businessId}/clients/${clientId}/notes`, {
        text: text.trim(),
      });
      setNotes((prev) => [created, ...(prev ?? [])]);
      setText("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить запись");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="slideover-section">
      <h4>Журнал{notes ? ` · ${notes.length}` : ""}</h4>
      <form onSubmit={(e) => void handleAdd(e)} style={{ display: "flex", gap: "6px", marginBottom: "10px" }}>
        <input
          style={{ flex: 1 }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Например: звонил, спрашивал про виброплиту"
          disabled={submitting}
        />
        <button type="submit" className="btn btn-sm" disabled={submitting || !text.trim()}>
          Добавить
        </button>
      </form>
      {error && <div className="form-error">{error}</div>}
      {notes === null ? (
        <div className="empty-note">Загрузка…</div>
      ) : notes.length === 0 ? (
        <div className="empty-note">Записей пока нет</div>
      ) : (
        notes.map((n) => (
          <div className="mini-item" key={n.id} style={{ alignItems: "flex-start" }}>
            <span>{n.text}</span>
            <span style={{ color: "var(--muted)", fontSize: "11.5px", whiteSpace: "nowrap", marginLeft: "8px" }}>
              {n.employee_name ?? "—"} · {fmtDate(n.created_at.slice(0, 10))}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
