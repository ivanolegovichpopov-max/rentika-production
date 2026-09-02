/**
 * Тип состояния формы добавления/изменения клиента и связанные с ним чистые
 * функции (перевод в/из Client, сборка тела запроса) — вынесено из
 * ClientsTab.tsx в отдельный модуль (38-й проход, "прибраться в коде, как на
 * Оборудовании" — тот файл разросся до 3600+ строк, за пределами того
 * размера в 3300+, при котором в 22-м проходе был разнесён EquipmentTab.tsx).
 * Используется и в ClientFormModal (сама форма), и в родительской вкладке
 * ClientsTab (готовит `initial` при открытии формы и тело запроса при
 * сохранении).
 */
import type { Client, ClientContact } from "../../../api/types";

/** Лимит размера файла документа клиента — держим в синхроне с backend'ом
 * (MAX_CLIENT_DOCUMENT_BYTES в app/api/routes/clients.py). Общий для формы
 * добавления клиента (загрузка ДО создания, см. pendingDocuments ниже) и
 * ClientDocumentsSection (загрузка в уже существующую карточку). */
export const MAX_CLIENT_DOCUMENT_BYTES = 5 * 1024 * 1024;

export interface ClientFormState {
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
  // ---- 37-й проход (обзор формы "Новый клиент") ----
  /** Сканы/фото документов, выбранные ДО того, как клиент вообще создан —
   * клиента ещё не существует на backend (id появится только из ответа
   * POST /clients), а сама загрузка файла (ClientDocumentsSection) жёстко
   * завязана на clientId в URL. Поэтому файлы здесь держатся как есть, в
   * памяти, а не отправляются сразу — реальная загрузка (тем же
   * api.postForm, что и в ClientDocumentsSection) происходит в
   * handleSubmitForm сразу после того, как клиент создан и получен его id.
   * Только для режима "add" — при редактировании существующего клиента
   * документами по-прежнему управляет ClientDocumentsSection в карточке. */
  pendingDocuments: File[];
}

export const EMPTY_CLIENT_FORM: ClientFormState = {
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
  pendingDocuments: [],
};

export function formFromClient(c: Client): ClientFormState {
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
    // Правка существующего клиента документами не занимается (см. коммент
    // у поля выше) — список всегда пуст, поле в форме для этого режима не
    // рендерится вовсе.
    pendingDocuments: [],
  };
}

export function clientFormToPayload(f: ClientFormState) {
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
 * isFormDirty у формы оборудования (equipment/formHelpers.ts): спрашивать
 * подтверждение закрытия только если пользователь реально что-то изменил. */
export function isClientFormDirty(current: ClientFormState, initial: ClientFormState): boolean {
  return (Object.keys(current) as (keyof ClientFormState)[]).some((k) => current[k] !== initial[k]);
}
