import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../../api/client";
import { useData } from "../../context/DataContext";
import type {
  Client,
  ClientContact,
  ClientDocument,
  ClientImportResult,
  ClientNote,
  Equipment,
  Rental,
  TrashedClient,
} from "../../api/types";
import { RATING_META, RENTAL_META, Badge, rentalDisplayStatus } from "../../lib/statusMeta";
import { money, fmtDate, colorFromId, initials, formatPhoneInput } from "../../lib/format";
import {
  IconClose,
  IconEdit,
  IconCheck,
  IconTrash,
  IconRestore,
  IconPhone,
  IconSend,
  IconMail,
  IconFile,
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
import { useModalDialog } from "../../lib/useModalDialog";
import { MoreActionsMenu } from "../../components/MoreActionsMenu";
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
  // ---- 26-й проход (проф. взгляд + «глазами обычного пользователя»,
  // согласовано целиком) ----
  birthday: string; // "YYYY-MM-DD" или ""
  additionalContacts: ClientContact[];
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
  birthday: "",
  additionalContacts: [],
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
    birthday: c.birthday ?? "",
    additionalContacts: c.additional_contacts ?? [],
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
    birthday: f.birthday.trim() === "" ? null : f.birthday,
    // Доп. контакты сохраняются только для организации, тем же принципом,
    // что и contact_person/inn выше — и пустые строки внутри каждой записи
    // приводятся к null, чтобы не плодить в базе "почти пустые" объекты.
    additional_contacts:
      f.clientType === "company" && f.additionalContacts.length > 0
        ? f.additionalContacts
            .map((c) => ({ name: c.name.trim(), role: (c.role ?? "").trim() || null, phone: (c.phone ?? "").trim() || null }))
            .filter((c) => c.name !== "")
        : null,
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
  const { ref, handleNativeClose } = useModalDialog(open);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<ClientFormState>(initial);
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { confirm: confirmDiscard, dialog: discardDialog } = useConfirm();

  useEffect(() => {
    if (open) {
      setForm(initial);
      setLocalError(null);
      const raf = requestAnimationFrame(() => nameInputRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** 29-й проход, повторный обзор, п.19-полировка: то же самое правило, что
   * и на backend (_require_company_fields/_validate_inn_format/
   * _validate_phone_format в app/schemas и app/api/routes/clients.py) — но
   * проверяем ДО отправки запроса, чтобы пользователь не тратил время на
   * заполнение остальной формы и не упирался в ошибку сервера только на
   * последнем шаге. Backend остаётся источником истины и перепроверяет то же
   * самое ещё раз — этот блок только UX, не замена серверной валидации. */
  function validateLocally(): string | null {
    if (!form.name.trim()) return "Имя/название не может состоять из одних пробелов";
    if (form.clientType === "company") {
      const missing: string[] = [];
      if (!form.contactPerson.trim()) missing.push("контактное лицо");
      if (!form.inn.trim()) missing.push("ИНН");
      if (missing.length > 0) return `Для организации обязательно укажите: ${missing.join(", ")}`;
    }
    if (form.inn.trim()) {
      const innDigits = form.inn.trim();
      if (!/^\d+$/.test(innDigits) || ![10, 12].includes(innDigits.length)) {
        return "ИНН должен состоять из 10 цифр (организация) или 12 цифр (ИП/физлицо)";
      }
    }
    if (form.phone.trim()) {
      const digits = form.phone.replace(/\D/g, "").length;
      if (digits < 10 || digits > 15) return "Похоже на некорректный номер телефона — должно быть от 10 до 15 цифр";
    }
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
      onClose={() => handleNativeClose(onClose)}
      onCancel={(e) => {
        e.preventDefault();
        void requestClose();
      }}
      // Клик по затемнённому фону (29-й проход, ещё один повторный обзор —
      // пользователь явно попросил вернуть закрытие по клику мимо, но с
      // тем же предупреждением "Несохранённые изменения будут потеряны?",
      // что и у крестика/Escape, а не безусловно). Раньше (см. историю чуть
      // выше) это было временно ПОЛНОСТЬЮ отключено на этих двух формах —
      // тогда предупреждение о несохранённых данных ещё не было надёжным
      // (его саму могла закрыть та же случайность). Сейчас requestClose()
      // всегда либо спрашивает подтверждение (форма правда заполнена), либо
      // закрывает сразу (пусто/не менялось) — данные больше никогда не
      // теряются молча, так что можно безопасно вернуть привычное поведение
      // "клик мимо — как крестик".
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
            {/* Звёздочка у обязательных полей (29-й проход, повторный обзор,
                п.19-полировка) — раньше ничто в форме не показывало, какие
                поля обязательны, а какие нет. */}
            <label>Имя / название *</label>
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
              <input
                value={form.phone}
                // Маска ввода (26-й проход) — форматирует по мере набора, см.
                // formatPhoneInput в lib/format.ts. Не мешает вставке готового
                // номера целиком — маска применяется к результату в любом случае.
                onChange={(e) => setForm({ ...form, phone: formatPhoneInput(e.target.value) })}
                placeholder="+7 900 000-00-00"
              />
              {/* 29-й проход, п.5 обзора — маска больше не навязывает "+7"
                  иностранным номерам, стоит явно сказать об этом рядом с
                  полем, иначе не очевидно из самого интерфейса. */}
              <div className="field-hint">Иностранный номер — начните ввод с кода страны, маска не тронет его.</div>
            </div>
            <div className="field">
              {/* 29-й проход, повторный обзор, п.17 — у остальных необязательных
                  полей (день рождения ниже) в подписи есть "(необязательно)",
                  у email его не было, хотя поле точно так же необязательное. */}
              <label>Email (необязательно)</label>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              {/* 29-й проход, повторный обзор, п.18 — "Документ / реквизиты"
                  для компании читался как дублирующий отдельное поле ИНН чуть
                  ниже. Переформулировано однозначно: это поле для прочих
                  реквизитов (ОГРН, юр. адрес и т.п.), а не замена ИНН. */}
              <label>{form.clientType === "company" ? "Прочие реквизиты (ОГРН, юр. адрес и т.п.)" : "Документ (паспорт)"}</label>
              <input value={form.doc} onChange={(e) => setForm({ ...form, doc: e.target.value })} />
            </div>
            <div className="field">
              {/* День рождения (26-й проход, «глазами обычного пользователя»)
                  — используется фильтром "Дни рождения на этой неделе" в
                  таблице клиентов, повод напомнить о себе скидкой. */}
              <label>День рождения (необязательно)</label>
              <input type="date" value={form.birthday} onChange={(e) => setForm({ ...form, birthday: e.target.value })} />
            </div>
          </div>
          {form.clientType === "company" && (
            <>
              <div className="field-row">
                <div className="field">
                  {/* Обязательно для организации — см. звёздочку выше у
                      "Имя / название" и validateLocally/_require_company_fields. */}
                  <label>Контактное лицо *</label>
                  <input
                    value={form.contactPerson}
                    onChange={(e) => setForm({ ...form, contactPerson: e.target.value })}
                    placeholder="Кто по факту забирает/сдаёт технику"
                  />
                </div>
                <div className="field">
                  <label>ИНН *</label>
                  <input value={form.inn} onChange={(e) => setForm({ ...form, inn: e.target.value })} />
                </div>
              </div>
              {/* Доп. контакты организации (26-й проход, проф. обзор, п.5) —
                  у реальных компаний-арендаторов часто несколько живых
                  контактов (снабженец, бухгалтерия, водитель), одного поля
                  "Контактное лицо" не хватает. Простой репитер строк, тем же
                  идиомом "добавить/убрать строку", что уже есть в проекте у
                  ступенчатого тарифа оборудования. */}
              <div className="field">
                <label>Другие контакты (необязательно)</label>
                {form.additionalContacts.map((contact, idx) => (
                  // .field-row по умолчанию — CSS-грид ровно на 2 колонки (см.
                  // styles.css), для 4 полей в ряд (имя/роль/телефон/удалить)
                  // нужен модификатор .field-row-4 — тем же паттерном, что и
                  // ступенчатый тариф оборудования (EquipmentFormModal.tsx).
                  // Без него третье и четвёртое поле молча переносились на
                  // новую строку — поймано на скриншот-проверке перед сдачей.
                  <div key={idx} className="field-row field-row-4" style={{ marginBottom: "6px", alignItems: "flex-start" }}>
                    <input
                      style={{ flex: 2 }}
                      value={contact.name}
                      placeholder="Имя"
                      onChange={(e) => {
                        const next = form.additionalContacts.slice();
                        next[idx] = { ...next[idx], name: e.target.value };
                        setForm({ ...form, additionalContacts: next });
                      }}
                    />
                    <input
                      style={{ flex: 2 }}
                      value={contact.role ?? ""}
                      placeholder="Роль (снабжение, бухгалтерия…)"
                      onChange={(e) => {
                        const next = form.additionalContacts.slice();
                        next[idx] = { ...next[idx], role: e.target.value };
                        setForm({ ...form, additionalContacts: next });
                      }}
                    />
                    <input
                      style={{ flex: 2 }}
                      value={contact.phone ?? ""}
                      placeholder="Телефон"
                      onChange={(e) => {
                        const next = form.additionalContacts.slice();
                        next[idx] = { ...next[idx], phone: formatPhoneInput(e.target.value) };
                        setForm({ ...form, additionalContacts: next });
                      }}
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      title="Убрать контакт"
                      onClick={() => setForm({ ...form, additionalContacts: form.additionalContacts.filter((_, i) => i !== idx) })}
                    >
                      <IconClose />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    setForm({ ...form, additionalContacts: [...form.additionalContacts, { name: "", role: null, phone: null }] })
                  }
                >
                  + Добавить контакт
                </button>
              </div>
            </>
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
  // 26-й проход, проф. обзор, п.1: раньше "кто мои самые ценные клиенты"
  // можно было узнать только через CSV-экспорт (там выручка уже считалась,
  // exportClientsCsv ниже) — в самой таблице отсортировать было нельзя.
  { key: "revenue", label: "Выручка" },
];

/* ============================================================
   Настройка столбцов таблицы (29-й проход, п.11 обзора: "то же самое, что у
   Оборудования, добавить и Клиентам") — 1:1 перенесённая механика из
   EquipmentTab.tsx (EQUIPMENT_TOGGLEABLE_COLUMN_IDS/visibleEquipmentColumns/
   moveColumn/toggleColumnHidden). Столбец "Имя" (name) — как и "Оборудование"
   там — всегда первый и всегда виден, настраиваются только пять оставшихся.
   Заодно чинит найденный при этом обзоре скрытый баг: раньше заголовок
   "Выручка" в CLIENT_SORT_COLUMNS был, а самой ячейки с данными под ним в
   <tbody> — не было (колонка сортировалась, но всегда пустая). Теперь и
   заголовки, и ячейки строятся из одного и того же списка. */
const CLIENT_TOGGLEABLE_COLUMN_IDS = CLIENT_SORT_COLUMNS.filter((c) => c.key !== "name").map((c) => c.key);

interface ClientColumnsPrefs {
  order: string[];
  hidden: string[];
}

const DEFAULT_CLIENT_COLUMNS_PREFS: ClientColumnsPrefs = {
  order: CLIENT_TOGGLEABLE_COLUMN_IDS,
  hidden: [],
};

function visibleClientColumns(prefs: ClientColumnsPrefs): { key: string; label: string }[] {
  const known = prefs.order.filter((id) => CLIENT_TOGGLEABLE_COLUMN_IDS.includes(id));
  const extra = CLIENT_TOGGLEABLE_COLUMN_IDS.filter((id) => !known.includes(id));
  return known
    .concat(extra)
    .filter((id) => !prefs.hidden.includes(id))
    .map((id) => CLIENT_SORT_COLUMNS.find((c) => c.key === id)!);
}

interface ClientCellContext {
  clientRentals: Rental[];
  activeCount: number;
  overdueNow: number;
  lastRental: string;
  displayRating: Client["rating"];
  revenue: number;
}

/** Содержимое ячейки одного из настраиваемых столбцов — тот же приём, что и
 * renderEquipmentCell в EquipmentTab.tsx: порядок/видимость столбцов
 * управляются данными, а не жёстким списком <td> в JSX. */
function renderClientCell(key: string, c: Client, ctx: ClientCellContext) {
  switch (key) {
    case "doc":
      return c.doc ?? "—";
    case "rating":
      return <Badge meta={RATING_META[ctx.displayRating]} />;
    case "rentals":
      return (
        <>
          {ctx.clientRentals.length} всего{ctx.activeCount > 0 ? `, ${ctx.activeCount} сейчас` : ""}
          {ctx.overdueNow > 0 && (
            <div style={{ marginTop: "4px" }}>
              <Badge meta={{ label: `Просрочено × ${ctx.overdueNow}`, tone: "critical" }} />
            </div>
          )}
        </>
      );
    case "lastRental":
      return ctx.lastRental ? fmtDate(ctx.lastRental) : "—";
    case "revenue":
      return money(ctx.revenue);
    default:
      return null;
  }
}

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

/** День рождения клиента приходится на ближайшие 7 дней (включая сегодня) —
 * 26-й проход, «глазами обычного пользователя»: повод напомнить о себе
 * скидкой/поздравлением. Сравнение по месяцу/дню, год рождения не важен
 * (Client.birthday хранит полную дату только потому, что так проще всего
 * ввести — см. app/models/inventory.py). Оборачивает год (например, у
 * клиента ДР 2 января, а сегодня 29 декабря) — проверяется явно, а не через
 * вычитание миллисекунд, которое эту границу года не учло бы. */
function isBirthdayThisWeek(birthday: string | null): boolean {
  if (!birthday) return false;
  const [, mStr, dStr] = birthday.split("-");
  const bMonth = Number(mStr) - 1;
  const bDay = Number(dStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    if (d.getMonth() === bMonth && d.getDate() === bDay) return true;
  }
  return false;
}

/** "Неполный профиль" — нет ни телефона, ни документа (26-й проход, проф.
 * обзор, п.6): для арендного бизнеса это риск — отдать технику клиенту, с
 * которым потом не связаться и предъявить нечего. Пока указано хотя бы
 * что-то одно, профиль неполным не считается — это мягкая подсказка "стоит
 * дозаполнить", а не жёсткий запрет создавать таких клиентов. */
function isIncompleteProfile(c: Client): boolean {
  return !c.phone && !c.doc;
}

/** Выручка клиента за всё время — только по ЗАВЕРШЁННЫМ (returned) арендам,
 * тот же расчёт, что и lifetimeRevenue в ClientDetailPanel и exportClientsCsv
 * ниже (26-й проход: вынесено в отдельную функцию, чтобы использовать ещё и
 * для сортировки колонки "Выручка", и для вычисления уровня клиента — см.
 * computeClientValueTiers). */
function clientLifetimeRevenue(clientId: string, rentals: Rental[]): number {
  return rentals
    .filter((r) => r.client_id === clientId && r.status === "returned")
    .reduce((s, r) => s + r.total, 0);
}

function clientSortValue(c: Client, key: string, rentals: Rental[]): string | number {
  if (key === "name") return c.name.toLowerCase();
  if (key === "doc") return (c.doc ?? "").toLowerCase();
  if (key === "rating") return CLIENT_RATING_PRIORITY[clientDisplayRating(c, rentals)] ?? 99;
  if (key === "rentals") return rentals.filter((r) => r.client_id === c.id).length;
  if (key === "lastRental") return lastRentalDate(c.id, rentals);
  if (key === "revenue") return clientLifetimeRevenue(c.id, rentals);
  return 0;
}

/** Уровень "ценности" клиента по выручке за всё время — отдельная ось от
 * рейтинга надёжности (тот про проблемность, этот про то, сколько клиент
 * реально принёс денег). 26-й проход, «глазами обычного пользователя»:
 * вместо произвольных фиксированных порогов в рублях (которые не подошли бы
 * ни маленькому, ни крупному бизнесу без ручной настройки) — перцентиль
 * СРЕДИ клиентов ЭТОГО бизнеса: топ-10% по выручке — "top", следующие до
 * ~35% — "active". Считается по ВСЕМ клиентам бизнеса, не по отфильтрованному
 * списку — иначе бейдж прыгал бы при смене фильтра. При малом числе платящих
 * клиентов (< MIN_CLIENTS_FOR_TIERS) бейджи не показываются вовсе — на
 * выборке в 2-3 клиента "топ-10%" не несёт смысла, только шумит. */
const MIN_CLIENTS_FOR_TIERS = 5;

function computeClientValueTiers(clients: Client[], rentals: Rental[]): Map<string, "top" | "active"> {
  const withRevenue = clients
    .map((c) => ({ id: c.id, revenue: clientLifetimeRevenue(c.id, rentals) }))
    .filter((r) => r.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue);
  const tiers = new Map<string, "top" | "active">();
  if (withRevenue.length < MIN_CLIENTS_FOR_TIERS) return tiers;
  const topCount = Math.max(1, Math.round(withRevenue.length * 0.1));
  const activeCount = Math.max(topCount, Math.round(withRevenue.length * 0.35));
  withRevenue.forEach((r, idx) => {
    if (idx < topCount) tiers.set(r.id, "top");
    else if (idx < activeCount) tiers.set(r.id, "active");
  });
  return tiers;
}

const VALUE_TIER_META: Record<"top" | "active", { label: string; tone: "accent" | "info" }> = {
  top: { label: "Топ клиент", tone: "accent" },
  active: { label: "Активный клиент", tone: "info" },
};

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

/** Есть ли у клиента ПРЯМО СЕЙЧАС просроченная аренда — используется и для
 * бейджа в таблице, и для быстрого фильтра "Только с просрочкой" (24-й
 * проход, п.5 обзора: "просроченный клиент — это сигнал, который владелец
 * хочет видеть первым делом, не открывая карточку каждого"). */
function clientHasOverdueNow(clientId: string, rentals: Rental[]): boolean {
  return rentals.some((r) => r.client_id === clientId && rentalDisplayStatus(r) === "overdue");
}

/** ОТОБРАЖАЕМЫЙ рейтинг клиента — вычисляется на фронте, тем же принципом,
 * что и rentalDisplayStatus (см. lib/statusMeta.tsx: "overdue" тоже никогда
 * не хранится backend'ом как есть). 29-й проход, п.6 обзора: раньше "На
 * контроле" был третьим ручным значением рейтинга рядом с "Надёжный"/"Чёрный
 * список" — сотрудник сам решал, когда его выставить, и по факту почти никто
 * не снимал пометку, когда просрочка закрывалась (в поле осталось только
 * "выставить", а "снять" не превратилось в привычку). Теперь "На контроле" —
 * не ручное состояние, а всегда актуальный расчёт: клиент "на контроле" ровно
 * пока у него есть просрочка ПРЯМО СЕЙЧАС (см. clientHasOverdueNow выше), без
 * отдельного действия что-то включить или выключить. Чёрный список
 * по-прежнему ручной — это осознанное решение команды, а не побочный эффект
 * дат аренды. Хранимое в базе значение "watch" (могло остаться от старых
 * записей, до этого прохода) этой функцией намеренно игнорируется — только
 * "blacklist" читается из данных как есть, "watch"/"normal" всегда считаются
 * заново. */
function clientDisplayRating(c: Client, rentals: Rental[]): Client["rating"] {
  if (c.rating === "blacklist") return "blacklist";
  if (clientHasOverdueNow(c.id, rentals)) return "watch";
  return "normal";
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
    const lifetimeRevenue = clientLifetimeRevenue(c.id, rentals);
    return [
      c.name,
      c.phone ?? "",
      c.email ?? "",
      c.doc ?? "",
      RATING_META[clientDisplayRating(c, rentals)].label,
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

/* ============================================================
   Корзина клиентов (29-й проход, п.14 обзора: "теряется история навсегда,
   без возможности восстановить — надо сделать корзину") — список клиентов,
   удалённых за последние 30 дней (см. TRASH_RETENTION_DAYS в
   app/services/trash.py), с восстановлением в один клик. Тот же idiom
   `<dialog className="wide">`, что и ClientImportModal выше: загружается
   при каждом открытии, а не держится в общем DataContext — корзину смотрят
   не каждый день, тащить её в общий стейт приложения смысла нет.
   ============================================================ */
function ClientTrashModal({
  open,
  businessId,
  onClose,
  onRestored,
}: {
  open: boolean;
  businessId: string;
  onClose: () => void;
  onRestored: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<TrashedClient[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setItems(null);
    setError(null);
    api
      .get<TrashedClient[]>(`/businesses/${businessId}/clients/trash`)
      .then((res) => {
        if (!cancelled) setItems(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Не удалось загрузить корзину");
      });
    return () => {
      cancelled = true;
    };
  }, [open, businessId]);

  async function handleRestore(id: string) {
    setRestoringId(id);
    try {
      await api.post(`/businesses/${businessId}/clients/${id}/restore`, {});
      setItems((prev) => (prev ?? []).filter((c) => c.id !== id));
      onRestored();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось восстановить клиента");
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <dialog
      id="modal"
      className="wide"
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-head">
        <h3>Корзина клиентов</h3>
        <button type="button" className="icon-btn" onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="modal-body">
        <div className="field-hint" style={{ marginBottom: "10px" }}>
          Удалённые клиенты хранятся здесь 30 дней и восстанавливаются в один клик. Клиенты с историей аренд (даже
          закрытой) остаются в корзине бессрочно — это финансовая история, физически она не удаляется.
        </div>
        {error && <div className="form-error">{error}</div>}
        {items === null ? (
          <div className="empty-note">Загрузка…</div>
        ) : items.length === 0 ? (
          <div className="empty-note">Корзина пуста</div>
        ) : (
          items.map((c) => (
            <div className="mini-item" key={c.id}>
              <span>
                <span className="avatar" style={{ background: colorFromId(c.id), width: 18, height: 18, fontSize: "9px", marginRight: "6px" }}>
                  {initials(c.name)}
                </span>
                {c.name}
                {c.phone ? ` · ${c.phone}` : ""}
                <span style={{ color: "var(--muted)", fontSize: "11.5px", marginLeft: "8px" }}>
                  удалён {fmtDate(c.deleted_at.slice(0, 10))}
                  {c.deleted_by_name ? ` · ${c.deleted_by_name}` : ""}
                </span>
              </span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={restoringId === c.id}
                onClick={() => void handleRestore(c.id)}
              >
                <IconRestore /> {restoringId === c.id ? "Восстанавливаем…" : "Восстановить"}
              </button>
            </div>
          ))
        )}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Готово
        </button>
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
  // докстринг ClientColumnsPrefs выше, personal browser preference, а не
  // данные бизнеса).
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
   * всё равно отклонит. 29-й проход, п.14 обзора: "удаление" теперь всегда
   * МЯГКОЕ (см. app/services/trash.py) — клиент уходит в корзину и
   * восстановим 30 дней, поэтому старая жёсткая блокировка "нельзя удалить
   * клиента с ЛЮБОЙ историей" (была введена в 24-м проходе именно потому,
   * что удаление раньше было безвозвратным) снята вместе с самим backend'ом
   * — clientHasAnyRental больше здесь не используется, блокирует только
   * ОТКРЫТАЯ аренда/бронь, которую в корзину унести действительно нельзя. */
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
            углу"): предыдущая правка (margin-left: auto на flex) прижимала
            эту группу к правому краю её ЖЕ строки, но при переносе
            фильтров кнопки всё равно съезжали вниз вместе с ними, а
            "Недавние" гуляли то на второй, то на третьей строке. Grid-
            родитель (styles.css, .tab-toolbar-grid) резервирует под эту
            колонку место с самого начала и держит её у верхнего края —
            кнопки теперь буквально в углу, независимо от того, на сколько
            строк перенеслись фильтры слева. */}
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
              // выход из активного режима редактирования неочевиден (это
              // заметил сам пользователь на живом скриншоте после первой
              // версии меню "Ещё"), а не рядовое редкое действие вроде
              // экспорта, поэтому исключение из общего правила "прятать всё
              // редкое" оправдано.
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
          как настоящие кнопки, плюс цветные аватарки дублировали цвет из
          самой таблицы прямо над ней; см. .chip-quiet в styles.css). */}
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
                больше не ручное значение, см. clientDisplayRating выше:
                рейтинг "на контроле" вычисляется сам по текущей просрочке. */}
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
                    столбцов (см. CLIENT_TOGGLEABLE_COLUMN_IDS). */}
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
                    нулевой ширины в состоянии покоя (opacity: 0), хотя в
                    Chromium песочницы и в проде (проверено через содержимое
                    бандла) та же самая CSS-разметка работала корректно —
                    по всей видимости, cross-browser нестыковка между
                    position: sticky на <td> и авто-раскладкой ширины колонки
                    таблицы, когда единственная "живая" ширина в колонке
                    определяется content-based расчётом body-ячеек. Явный
                    width на ОБЕИХ ячейках колонки (здесь и в styles.css) не
                    оставляет браузеру пространства для интерпретации —
                    колонка всегда 104px, независимо от того, что внутри и
                    видимо ли оно сейчас. */}
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
                        {/* Цветной аватар из инициалов — тот же приём, что и у
                            сотрудников в сайдбаре (colorFromId/initials из
                            lib/format.ts), 25-й проход, п.3 обзора. */}
                        <span className="avatar" style={{ background: colorFromId(c.id) }}>{initials(c.name)}</span>
                        <div>
                          {/* cell-name-wrap (32-й проход — обзор оформления,
                              п. "Удалить съезжает за край экрана"): у клиента с
                              несколькими бейджами разом (Орг. + уровень +
                              день рождения + "Неполный профиль") имя раньше
                              росло одной нерастяжимой строкой — при
                              table-layout:auto это раздувало всю таблицу шире
                              контейнера, и последняя колонка с кнопками
                              "Изменить"/"Удалить" уезжала за правый край
                              экрана (видна только после горизонтального
                              скролла). flex-wrap переносит бейджи на вторую
                              строку внутри своей же колонки вместо того, чтобы
                              раздувать её вширь — остальные колонки таблицы
                              (и кнопки действий) сохраняют свою ширину
                              независимо от количества бейджей у конкретного
                              клиента. */}
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
                          </div>
                          {/* 29-й проход, п. из обзора "иконки звонок/WhatsApp/
                              email в строке" — раньше здесь рядом с телефоном
                              стояли три отдельные кнопки-иконки быстрого
                              действия (звонок/WhatsApp/почта). При растущем
                              числе бейджей в этой же ячейке (VIP-уровень,
                              день рождения, "Неполный профиль", теги) они
                              превращались в визуальный шум, а быстрый доступ
                              к контактам уже есть в карточке клиента
                              (раздел "Контакты" — кликабельные tel:/mailto:
                              ссылки). Убраны; телефон в строке остаётся
                              обычным текстом. */}
                          <div className="cell-sub">
                            <span>{c.phone ?? "—"}</span>
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
  // См. комментарий у computeClientValueTiers в ClientsTab выше — считается
  // по всем клиентам бизнеса, не зависит от того, как открыта эта карточка.
  const valueTier = computeClientValueTiers(clients, rentals).get(clientId);
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
  // 26-й проход: карточка разрослась (журнал, документы, доп. контакты,
  // график активности…) настолько, что один длинный скролл стал неудобен
  // для клиентов с большой историей/журналом — разбито на вкладки, тем же
  // простым idiom "кнопка + активное состояние", что и сегментированные
  // переключатели в остальном проекте (RATING_FILTERS и т.п.), без
  // отдельной библиотеки вкладок.
  const [panelTab, setPanelTab] = useState<"overview" | "history" | "journal">("overview");

  if (!client) return null;

  // См. clientDisplayRating выше — "На контроле" больше не хранится как
  // ручной выбор, а вычисляется по текущей просрочке (29-й проход, п.6 обзора).
  const displayRating = clientDisplayRating(client, rentals);

  const history = rentals
    .filter((r) => r.client_id === clientId)
    .slice()
    .sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
  // Список ограничен по умолчанию (24-й проход, п.5 обзора) — у постоянного
  // клиента с десятками аренд слайдовер иначе растягивался бы бесконечно.
  const HISTORY_PAGE = 6;
  // Фильтр истории по месяцу из мини-графика активности (29-й проход, п.4
  // обзора, "клик по графику должен фильтровать историю по месяцу") — "YYYY-MM"
  // или null ("не фильтровать"). Сбрасывается при закрытии/переоткрытии
  // карточки естественным образом (компонент размонтируется целиком).
  const [historyMonthFilter, setHistoryMonthFilter] = useState<string | null>(null);
  const monthFilteredHistory = historyMonthFilter
    ? history.filter((r) => r.start_date.startsWith(historyMonthFilter))
    : history;
  const visibleHistory = showAllHistory ? monthFilteredHistory : monthFilteredHistory.slice(0, HISTORY_PAGE);

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
  const additionalContacts = client.additional_contacts ?? [];
  const incompleteProfile = isIncompleteProfile(client);
  // Для кнопок "Отправить сводку" ниже (26-й проход) — берём открытую
  // аренду, если есть, иначе последнюю завершённую (см. pickSummaryRental).
  const summaryRental = pickSummaryRental(history);

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
                <span className="badge-tag" title="Организация" style={{ marginLeft: "6px" }}>
                  Орг.
                </span>
              )}
            </h3>
            <div style={{ color: "var(--muted)", fontSize: "12.5px", marginTop: "2px" }}>{client.phone ?? "—"}</div>
            {valueTier && (
              <div style={{ marginTop: "4px" }}>
                <Badge meta={VALUE_TIER_META[valueTier]} />
              </div>
            )}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose}>
          <IconClose />
        </button>
      </div>

      {/* Кнопки действий (29-й проход, п.13 обзора: "перенести действия
          наверх, не заставлять листать всю карточку до конца ради простого
          удаления") — раньше были самым последним блоком слайдовера, теперь
          сразу под шапкой, тем же принципом, что и заголовок/аватар выше:
          самое частое взаимодействие с карточкой не должно требовать скролла. */}
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

      {incompleteProfile && (
        <div className="slideover-section">
          <div className="form-error">
            Неполный профиль: не указан ни телефон, ни документ — стоит дозаполнить перед выдачей техники.
          </div>
        </div>
      )}

      {(client.phone || client.email) && (
        <div className="slideover-section" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {client.phone && (
            <a className="btn btn-sm" href={`tel:${client.phone}`}>
              <IconPhone /> Позвонить
            </a>
          )}
          {client.phone && (
            <a className="btn btn-sm" href={`https://wa.me/${normalizePhoneDigits(client.phone)}`} target="_blank" rel="noreferrer">
              <IconSend /> WhatsApp
            </a>
          )}
          {client.email && (
            <a className="btn btn-sm" href={`mailto:${client.email}`}>
              <IconMail /> Почта
            </a>
          )}
        </div>
      )}

      {/* Отправить клиенту сводку по аренде (26-й проход, «глазами обычного
          пользователя», п.5) — ТОЛЬКО текстом: ни wa.me, ни mailto: не умеют
          вкладывать файл, это ограничение самих протоколов, не проекта.
          Договор целиком по-прежнему открывается по клику на строку истории
          (см. ниже) — это просто быстрый способ переслать клиенту суть.  */}
      {summaryRental && (client.phone || client.email) && (
        <div className="slideover-section">
          <div className="field-hint" style={{ marginBottom: "8px" }}>
            Отправить клиенту сводку по аренде (текстом):
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {client.phone && (
              <a
                className="btn btn-sm"
                href={`https://wa.me/${normalizePhoneDigits(client.phone)}?text=${encodeURIComponent(
                  buildRentalSummaryText(summaryRental, client, equipment)
                )}`}
                target="_blank"
                rel="noreferrer"
              >
                Сводка в WhatsApp
              </a>
            )}
            {client.email && (
              <a
                className="btn btn-sm"
                href={`mailto:${client.email}?subject=${encodeURIComponent("Информация по аренде")}&body=${encodeURIComponent(
                  buildRentalSummaryText(summaryRental, client, equipment)
                )}`}
              >
                Сводка на почту
              </a>
            )}
          </div>
        </div>
      )}

      <div className="segmented" style={{ margin: "0 16px 4px" }}>
        <button type="button" className={panelTab === "overview" ? "active" : ""} onClick={() => setPanelTab("overview")}>
          Обзор
        </button>
        <button type="button" className={panelTab === "history" ? "active" : ""} onClick={() => setPanelTab("history")}>
          История · {history.length}
        </button>
        <button type="button" className={panelTab === "journal" ? "active" : ""} onClick={() => setPanelTab("journal")}>
          Журнал
        </button>
      </div>

      {panelTab === "overview" && (
        <>
          <div className="slideover-section">
            <h4>Надёжность</h4>
            <div style={{ marginBottom: "10px", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <Badge meta={RATING_META[displayRating]} />
              {/* Постоянная пометка "когда-то был в чёрном списке" (29-й
                  проход, п.8 обзора) — не сбрасывается автоматически, видна
                  и после того, как клиента реабилитировали. */}
              {client.was_blacklisted && client.rating !== "blacklist" && (
                <span title="Раньше уже был в чёрном списке" style={{ display: "inline-block" }}>
                  <Badge meta={{ label: "Был в чёрном списке", tone: "muted" }} />
                </span>
              )}
            </div>
            {client.rating === "blacklist" && client.blacklist_reason && (
              <div className="field-hint" style={{ marginBottom: "10px" }}>
                Причина: {client.blacklist_reason}
              </div>
            )}
            {/* "На контроле" убран из кнопок выбора (29-й проход, п.6 обзора)
                — это больше не ручное состояние, а вычисляется само по
                текущей просрочке (см. clientDisplayRating/displayRating
                выше), поэтому выбирать осталось только между "Надёжный" и
                "Чёрный список". */}
            <div className="rating-picker">
              <button
                className={"btn btn-sm" + (client.rating === "normal" ? " btn-primary" : "")}
                onClick={() => void setRating("normal")}
              >
                Надёжный
              </button>
              <button
                className={"btn btn-sm" + (client.rating === "blacklist" ? " btn-primary" : "")}
                onClick={() => void setRating("blacklist")}
              >
                Чёрный список
              </button>
            </div>
            {displayRating === "watch" && client.rating !== "blacklist" && (
              <div className="field-hint" style={{ marginTop: "8px" }}>
                Статус «На контроле» выставляется автоматически, пока у клиента есть просрочка прямо сейчас — вручную
                его включать/выключать не нужно.
              </div>
            )}
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

          <MiniActivityChart
            rentals={history}
            onSelectMonth={(key) => {
              setHistoryMonthFilter(key);
              setShowAllHistory(false);
              setPanelTab("history");
            }}
          />

          <div className="slideover-section">
            <h4>Контакты</h4>
            <div className="kv-grid">
              {/* Телефон отдельной строкой в блоке "Контакты" (29-й проход,
                  п.1 обзора: раньше номер был виден только под именем в
                  шапке, а сам блок "Контакты" его не показывал вовсе) —
                  кликабельная tel:-ссылка, тем же принципом, что и кнопка
                  "Позвонить" выше. */}
              <span className="k">Телефон</span>
              <span>{client.phone ? <a href={`tel:${client.phone}`}>{client.phone}</a> : "—"}</span>
              <span className="k">Email</span>
              <span>{client.email ? <a href={`mailto:${client.email}`}>{client.email}</a> : "—"}</span>
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
              <span className="k">День рождения</span>
              <span>{client.birthday ? fmtDate(client.birthday) : "—"}</span>
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
            {/* Доп. контакты организации (26-й проход) — только чтение здесь,
                редактируются в форме (ClientFormModal). */}
            {additionalContacts.length > 0 && (
              <div style={{ marginTop: "10px" }}>
                <div className="k" style={{ marginBottom: "4px" }}>
                  Другие контакты
                </div>
                {additionalContacts.map((c, idx) => (
                  <div key={idx} className="mini-item">
                    <span>
                      {c.name}
                      {c.role ? ` · ${c.role}` : ""}
                    </span>
                    {c.phone && (
                      <a className="icon-btn" href={`tel:${c.phone}`} title="Позвонить">
                        <IconPhone />
                      </a>
                    )}
                  </div>
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

          <ClientDocumentsSection businessId={businessId} clientId={clientId} />
        </>
      )}

      {panelTab === "history" && (
        <div className="slideover-section">
          {historyMonthFilter && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
              <span className="field-hint">Показаны аренды, начатые в {monthKeyToLabel(historyMonthFilter)}</span>
              <button type="button" className="btn btn-sm" onClick={() => setHistoryMonthFilter(null)}>
                Сбросить
              </button>
            </div>
          )}
          {history.length === 0 ? (
            <div className="empty-note">Ещё не сдавалось в аренду</div>
          ) : monthFilteredHistory.length === 0 ? (
            <div className="empty-note">В этом месяце аренд не было</div>
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
              {monthFilteredHistory.length > HISTORY_PAGE && (
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ marginTop: "8px" }}
                  onClick={() => setShowAllHistory((v) => !v)}
                >
                  {showAllHistory ? "Свернуть" : `Показать ещё ${monthFilteredHistory.length - HISTORY_PAGE}`}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {panelTab === "journal" && <ClientNotesJournal businessId={businessId} clientId={clientId} />}

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
      className="wide"
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
            {/* Поле поиска в пикере (29-й проход, п.15 обзора) — в базе с
                сотнями клиентов листать простой список неудобно; заодно
                модалка расширена (className="wide" на <dialog> выше), чтобы
                длинные имена/телефоны в списке не переносились через строку. */}
            <Dropdown
              value={targetId}
              onChange={setTargetId}
              placeholder="Выберите клиента"
              searchable
              searchPlaceholder="Поиск по имени…"
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

/* ============================================================
   26-й проход (обзор вкладки «Клиенты» и карточки клиента — проф. взгляд +
   «глазами обычного пользователя», согласовано целиком: "Согласен со всем,
   делаем всё") — оставшиеся куски: сводка по аренде для WhatsApp/почты,
   мини-график активности, вложения-документы клиента.
   ============================================================ */

/** Аренда для кнопок "Отправить сводку" — открытая (в работе/забронирована),
 * если есть, иначе последняя завершённая. Открытая аренда важнее показать
 * клиенту (что и когда вернуть), чем произвольную из прошлого. */
function pickSummaryRental(history: Rental[]): Rental | null {
  const open = history.filter((r) => r.status === "active" || r.status === "booked");
  if (open.length > 0) return open[0]; // history уже отсортирована новые→старые
  const closed = history.filter((r) => r.status === "returned");
  return closed[0] ?? null;
}

/** Текстовая сводка по аренде — для wa.me/mailto (см. комментарий у кнопок
 * "Отправить сводку" в ClientDetailPanel: ни один из двух протоколов не
 * умеет вкладывать файл, это не ограничение проекта, а самих ссылок
 * wa.me/mailto:, поэтому сводка — только текст, не PDF/документ). */
function buildRentalSummaryText(rental: Rental, client: Client, equipment: Equipment[]): string {
  const items = rental.items.map((it) => equipment.find((eq) => eq.id === it.equipment_id)?.name ?? "—").join(", ");
  const statusLabel = RENTAL_META[rentalDisplayStatus(rental)].label;
  return [
    `Здравствуйте, ${client.name}!`,
    `Оборудование: ${items}`,
    `Период: ${fmtDate(rental.start_date)}—${fmtDate(rental.end_date)}`,
    `Статус: ${statusLabel}`,
    `Сумма: ${money(rental.total)}`,
  ].join("\n");
}

/** Последние 6 календарных месяцев (включая текущий), от старого к новому —
 * подпись месяца по-русски в родительном не нужна, короткого именительного
 * достаточно для оси графика. */
function lastMonths(n: number): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleDateString("ru", { month: "short" }).replace(".", ""),
    });
  }
  return out;
}

/** Подпись месяца по ключу "YYYY-MM" в родительном падеже, для фразы
 * "Показаны аренды, начатые в …" над отфильтрованной историей ниже. */
function monthKeyToLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("ru", { month: "long", year: "numeric" });
}

/** Мини-график активности клиента — сколько аренд НАЧАТО в каждом из
 * последних 6 месяцев (26-й проход, «глазами обычного пользователя»,
 * п.4): раньше про динамику клиента (затихает/разгоняется) можно было
 * судить только по одной цифре "выручка за всё время" и построчной истории.
 * Простой SVG-бар-чарт без сторонних библиотек — тот же принцип "минимум
 * зависимостей", что и весь остальной проект (см. Dropdown.tsx и т.п.).
 * 29-й проход, п.4 обзора — три правки по фидбеку с живого прода:
 *  1. preserveAspectRatio="none" убран — это и был баг "график растянут
 *     криво": "none" заставляет SVG растягивать содержимое под фактическую
 *     ширину контейнера НЕ сохраняя пропорции viewBox, так что на широких
 *     карточках столбики визуально "расплющивались" по высоте. Без этого
 *     атрибута работает дефолт "xMidYMid meet" — сохраняет пропорции.
 *  2. Каждый столбец кликабелен — открывает вкладку "История", отфильтрованную
 *     по этому месяцу (см. onSelectMonth/historyMonthFilter в ClientDetailPanel).
 *  3. Подпись под заголовком уточняет, что считается КОЛИЧЕСТВО сделок, а не
 *     выручка — раньше это было неочевидно, цифры на графике легко спутать
 *     с деньгами. */
function MiniActivityChart({ rentals, onSelectMonth }: { rentals: Rental[]; onSelectMonth: (monthKey: string) => void }) {
  if (rentals.length === 0) return null;
  const months = lastMonths(6);
  const counts = months.map((m) => rentals.filter((r) => r.start_date.startsWith(m.key)).length);
  const max = Math.max(1, ...counts);
  const barSlot = 180 / months.length;
  const barWidth = barSlot - 6;
  return (
    <div className="slideover-section">
      <h4>Активность по месяцам</h4>
      <div className="field-hint" style={{ marginBottom: "6px" }}>
        Количество арендных сделок, начатых в месяце (не выручка) — нажмите на столбец, чтобы посмотреть их в истории.
      </div>
      <svg width="100%" height="60" viewBox="0 0 180 60" style={{ display: "block" }}>
        {months.map((m, i) => {
          const x = i * barSlot + 3;
          const h = (counts[i] / max) * 38;
          return (
            <g
              key={m.key}
              onClick={() => counts[i] > 0 && onSelectMonth(m.key)}
              style={{ cursor: counts[i] > 0 ? "pointer" : "default" }}
            >
              <title>{`${m.label}: ${counts[i]}`}</title>
              {/* Прозрачная область побольше вокруг столбца — увеличивает
                  кликабельную зону сверх узкого самого столбца. */}
              <rect x={x - 2} y="0" width={Math.max(barWidth + 4, 1)} height="46" fill="transparent" />
              <rect x={x} y={44 - h} width={Math.max(barWidth, 1)} height={Math.max(h, 1)} rx="2" fill="var(--accent)" />
              <text x={x + barWidth / 2} y="56" fontSize="7.5" textAnchor="middle" fill="var(--muted)">
                {m.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Лимит размера файла документа клиента — держим в синхроне с backend'ом
// (MAX_CLIENT_DOCUMENT_BYTES в app/api/routes/clients.py): нет смысла
// заставлять пользователя ждать загрузку и кодирование файла, который
// backend всё равно отклонит.
const MAX_CLIENT_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** Открыть/скачать документ клиента через Blob + ObjectURL вместо прямой
 * data:-ссылки (29-й проход, п.9 обзора) — современный Chrome блокирует
 * навигацию верхнего фрейма на data: URL ("Not allowed to navigate top
 * frame to data URL"), так что клик по ссылке `href="data:…"` в реальном
 * проде у пользователя просто ничего не делал молча, без видимой ошибки.
 * Blob-URL того же ограничения не имеет. URL.revokeObjectURL — с небольшой
 * задержкой, а не сразу: сама навигация в новую вкладку асинхронна, слишком
 * ранний revoke иногда успевал "погасить" ссылку раньше, чем вкладка её
 * прочитает. */
function documentToBlobUrl(doc: ClientDocument): string {
  const byteChars = atob(doc.data_base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const blob = new Blob([bytes], { type: doc.content_type });
  return URL.createObjectURL(blob);
}

function openClientDocument(doc: ClientDocument) {
  const url = documentToBlobUrl(doc);
  window.open(url, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Явная кнопка "Скачать" (29-й проход, повторный обзор, п.11 — открытие в
 * новой вкладке не всегда очевидно как "сохранить файл", особенно для PDF;
 * нужна отдельная кнопка со скачиванием под явным именем файла). Тот же
 * Blob-URL, что и у openClientDocument, но через временный <a download>,
 * а не window.open — так браузер сохраняет файл вместо навигации. */
function downloadClientDocument(doc: ClientDocument) {
  const url = documentToBlobUrl(doc);
  const a = document.createElement("a");
  a.href = url;
  a.download = doc.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Прикреплённые сканы/фото документов клиента (26-й проход, проф. обзор,
 * п.4: "Документ" в карточке — это раньше был только текст, а не сама
 * фотография паспорта/доверенности). Тот же структурный idiom, что и
 * ClientNotesJournal выше (загрузка списка по clientId, локальный state,
 * append/remove на успехе запроса), но с загрузкой файла через
 * api.postForm — тем же способом, что и CSV-импорт (ClientImportModal). */
function ClientDocumentsSection({ businessId, clientId }: { businessId: string; clientId: string }) {
  const [docs, setDocs] = useState<ClientDocument[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();
  // 29-й проход, повторный обзор, п.12: подпись документа ("Разворот
  // паспорта", "Прописка") — редактируется по одному файлу за раз, id
  // редактируемого документа + черновик текста, null = ничего не редактируется.
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [savingLabel, setSavingLabel] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDocs(null);
    api
      .get<ClientDocument[]>(`/businesses/${businessId}/clients/${clientId}/documents`)
      .then((res) => {
        if (!cancelled) setDocs(res);
      })
      .catch(() => {
        if (!cancelled) setDocs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, clientId]);

  /** Загрузка сразу нескольких файлов (29-й проход, п.9 обзора: "нужно
   * прикреплять сразу несколько файлов, а не по одному") — по одному запросу
   * на файл, последовательно (не Promise.all — чтобы не заваливать backend
   * параллельными запросами при выборе сразу десятка сканов, да и порядок
   * появления в списке предсказуемее). Подпись при самой загрузке не
   * запрашиваем — при выборе сразу нескольких файлов одна общая подпись на
   * все была бы бессмысленной (нужны разные: "Разворот паспорта", "Прописка"
   * и т.п.), поэтому подпись добавляется/меняется по каждому файлу отдельно
   * после загрузки (см. handleSaveLabel ниже, повторный обзор, п.12). Один
   * неудачный файл не прерывает загрузку остальных — итоговая ошибка (если
   * была) показывается одной строкой после того, как отработали все. */
  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    const list = Array.from(files);
    const tooBig = list.filter((f) => f.size > MAX_CLIENT_DOCUMENT_BYTES);
    const toUpload = list.filter((f) => f.size <= MAX_CLIENT_DOCUMENT_BYTES);
    setUploading(true);
    let failed = 0;
    try {
      for (const file of toUpload) {
        try {
          const form = new FormData();
          form.append("file", file);
          const created = await api.postForm<ClientDocument>(`/businesses/${businessId}/clients/${clientId}/documents`, form);
          setDocs((prev) => [created, ...(prev ?? [])]);
        } catch {
          failed++;
        }
      }
      if (tooBig.length > 0 || failed > 0) {
        setError(
          [
            tooBig.length > 0 ? `Слишком большой файл (максимум 5 МБ): ${tooBig.map((f) => f.name).join(", ")}` : "",
            failed > 0 ? `Не удалось загрузить файлов: ${failed}` : "",
          ]
            .filter(Boolean)
            .join(". ")
        );
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDelete(doc: ClientDocument) {
    if (!(await confirm(`Удалить файл «${doc.filename}»?`, { danger: true }))) return;
    try {
      await api.delete(`/businesses/${businessId}/clients/${clientId}/documents/${doc.id}`);
      setDocs((prev) => (prev ?? []).filter((d) => d.id !== doc.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось удалить файл");
    }
  }

  function startEditLabel(doc: ClientDocument) {
    setEditingLabelId(doc.id);
    setLabelDraft(doc.label ?? "");
    setError(null);
  }

  async function handleSaveLabel(doc: ClientDocument) {
    setSavingLabel(true);
    try {
      const updated = await api.patch<ClientDocument>(
        `/businesses/${businessId}/clients/${clientId}/documents/${doc.id}`,
        { label: labelDraft.trim() || null }
      );
      setDocs((prev) => (prev ?? []).map((d) => (d.id === doc.id ? updated : d)));
      setEditingLabelId(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить подпись");
    } finally {
      setSavingLabel(false);
    }
  }

  return (
    <div className="slideover-section">
      <h4>Документы{docs ? ` · ${docs.length}` : ""}</h4>
      <div className="field-hint" style={{ marginBottom: "8px" }}>
        Сканы/фото документов клиента (паспорт, доверенность и т.п.) — до 5 МБ на файл, можно выбрать сразу несколько.
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        onChange={(e) => void handleFiles(e.target.files)}
        disabled={uploading}
        style={{ marginBottom: "8px" }}
      />
      {uploading && <div className="empty-note">Загружаем…</div>}
      {error && <div className="form-error">{error}</div>}
      {docs === null ? (
        <div className="empty-note">Загрузка…</div>
      ) : docs.length === 0 ? (
        <div className="empty-note">Файлов пока нет</div>
      ) : (
        docs.map((d) => (
          <div className="mini-item" key={d.id} style={{ flexDirection: "column", alignItems: "stretch", gap: "4px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
              {/* Blob + ObjectURL вместо прямой data:-ссылки — см. докстринг
                  openClientDocument выше (Chrome блокирует top-frame навигацию
                  на data: URL). */}
              <a href="#" onClick={(e) => { e.preventDefault(); openClientDocument(d); }}>
                <IconFile /> {d.filename}
              </a>
              <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ color: "var(--muted)", fontSize: "11.5px", whiteSpace: "nowrap" }}>
                  {fmtDate(d.created_at.slice(0, 10))}
                </span>
                <button
                  type="button"
                  className="link-btn"
                  title="Скачать файл"
                  onClick={() => downloadClientDocument(d)}
                  style={{ whiteSpace: "nowrap" }}
                >
                  Скачать
                </button>
                <button type="button" className="icon-btn" title="Удалить" onClick={() => void handleDelete(d)}>
                  <IconTrash />
                </button>
              </span>
            </div>
            {/* Подпись документа (29-й проход, повторный обзор, п.12) — чтобы
                несколько файлов не приходилось различать только по имени с
                телефона ("Разворот паспорта", "Прописка" и т.п.). */}
            {editingLabelId === d.id ? (
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <input
                  type="text"
                  value={labelDraft}
                  onChange={(e) => setLabelDraft(e.target.value)}
                  placeholder="Подпись, например «Разворот паспорта»"
                  maxLength={255}
                  autoFocus
                  disabled={savingLabel}
                  style={{ flex: 1, fontSize: "12.5px" }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSaveLabel(d);
                    if (e.key === "Escape") setEditingLabelId(null);
                  }}
                />
                <button type="button" className="icon-btn" title="Сохранить" disabled={savingLabel} onClick={() => void handleSaveLabel(d)}>
                  <IconCheck />
                </button>
                <button type="button" className="icon-btn" title="Отмена" disabled={savingLabel} onClick={() => setEditingLabelId(null)}>
                  <IconClose />
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{ fontSize: "12.5px", color: d.label ? "var(--text)" : "var(--muted)", fontStyle: d.label ? "normal" : "italic" }}>
                  {d.label || "Без подписи"}
                </span>
                <button type="button" className="icon-btn" title="Изменить подпись" onClick={() => startEditLabel(d)}>
                  <IconEdit />
                </button>
              </div>
            )}
          </div>
        ))
      )}
      {confirmDialog}
    </div>
  );
}
