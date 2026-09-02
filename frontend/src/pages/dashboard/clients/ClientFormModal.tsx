/**
 * Модалка добавления/изменения клиента — вынесена из ClientsTab.tsx в
 * отдельный модуль (38-й проход, "прибраться в коде"), по образцу
 * equipment/EquipmentFormModal.tsx. Тот же идиом `<dialog>` (ref +
 * showModal()/close() через useModalDialog), только без ступенчатого тарифа
 * и прочей специфики оборудования — у клиента набор полей другой.
 */
import { useEffect, useRef, useState } from "react";
import { IconClose, IconFile } from "../../../lib/icons";
import { useConfirm } from "../../../components/ConfirmDialog";
import { useModalDialog } from "../../../lib/useModalDialog";
import { formatPhoneInput } from "../../../lib/format";
import { MAX_CLIENT_DOCUMENT_BYTES, isClientFormDirty, type ClientFormState } from "./formHelpers";

/** Модалка добавления/изменения клиента. */
export function ClientFormModal({
  open,
  title,
  mode,
  initial,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  /** 37-й проход — только чтобы решить, показывать ли блок загрузки
   * документов (см. комментарий у pendingDocuments в ClientFormState):
   * при редактировании документами занимается ClientDocumentsSection в
   * самой карточке, здесь для этого режима поле не нужно. */
  mode: "add" | "edit";
  initial: ClientFormState;
  error: string | null;
  onClose: () => void;
  onSubmit: (form: ClientFormState) => Promise<void> | void;
}) {
  const { ref, handleNativeClose } = useModalDialog(open);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const pendingFilesInputRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<ClientFormState>(initial);
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { confirm: confirmDiscard, dialog: discardDialog } = useConfirm();

  /** Выбор файлов документа при создании клиента (37-й проход) — только
   * складывает File-объекты в форму, ничего никуда не отправляет (см.
   * комментарий у pendingDocuments в ClientFormState). Валидация размера —
   * тот же лимит и то же сообщение, что и у реальной загрузки в
   * ClientDocumentsSection (MAX_CLIENT_DOCUMENT_BYTES — общая константа в
   * clients/formHelpers.ts). */
  function handlePickFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    const tooBig = list.filter((f) => f.size > MAX_CLIENT_DOCUMENT_BYTES);
    const ok = list.filter((f) => f.size <= MAX_CLIENT_DOCUMENT_BYTES);
    setLocalError(tooBig.length > 0 ? `Слишком большой файл (максимум 5 МБ): ${tooBig.map((f) => f.name).join(", ")}` : null);
    if (ok.length > 0) setForm((prev) => ({ ...prev, pendingDocuments: [...prev.pendingDocuments, ...ok] }));
  }

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
      // что и у крестика/Escape, а не безусловно). requestClose() всегда
      // либо спрашивает подтверждение (форма правда заполнена), либо
      // закрывает сразу (пусто/не менялось) — данные больше никогда не
      // теряются молча.
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

          {/* Подзаголовки секций (37-й проход, обзор формы "Новый клиент",
              п.1: раньше 9+ полей шли одним сплошным списком одного
              визуального веса — не сразу читалось, где заканчивается один
              смысловой блок и начинается другой). Тот же приём и тот же
              класс `h4`, что и в карточке клиента (слайдовер, "Надёжность"/
              "Активность" и т.п.) — здесь просто через .modal-body h4,
              а не .slideover-section h4 (см. styles.css), чтобы не тащить в
              разметку формы лишний оборачивающий div на каждую секцию. */}
          <h4>Контакты</h4>
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

          <h4>Документы</h4>
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
          {/* Прикрепление сканов/фото документа прямо при создании клиента
              (37-й проход). Только для режима "add": у редактирования уже
              есть полноценная секция "Документы" в самой карточке
              (ClientDocumentsSection) с загрузкой сразу на сервер,
              дублировать её здесь незачем. Файлы копятся в
              form.pendingDocuments и реально загружаются только после того,
              как клиент создан и известен его id — см. комментарий у этого
              поля в ClientFormState и handleSubmitForm в ClientsTab.tsx. */}
          {mode === "add" && (
            <div className="field">
              <label>Прикрепить документ (необязательно)</label>
              <input
                ref={pendingFilesInputRef}
                type="file"
                accept="image/*,application/pdf"
                multiple
                onChange={(e) => {
                  handlePickFiles(e.target.files);
                  if (pendingFilesInputRef.current) pendingFilesInputRef.current.value = "";
                }}
              />
              <div className="field-hint">Скан или фото паспорта/доверенности — до 5 МБ на файл, можно выбрать сразу несколько.</div>
              {form.pendingDocuments.length > 0 && (
                <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "flex", flexDirection: "column", gap: "4px" }}>
                  {form.pendingDocuments.map((f, idx) => (
                    <li key={idx} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12.5px" }}>
                      <IconFile />
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Убрать файл"
                        onClick={() => setForm({ ...form, pendingDocuments: form.pendingDocuments.filter((_, i) => i !== idx) })}
                      >
                        <IconClose />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <h4>Коммерческие условия</h4>
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
                // Плейсхолдер "0" (37-й проход, п.5 обзора) убран — легко
                // принять за уже выставленное значение "скидка 0%", хотя это
                // просто пустое необязательное поле.
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

          <h4>Заметка</h4>
          <div className="field">
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
