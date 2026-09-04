/**
 * CreateRentalModal — форма «Новая аренда» (создание). Единственный внешний
 * потребитель — Dashboard.tsx (кнопка «+ Новая аренда» в шапке), поэтому
 * RentalsTab.tsx ре-экспортирует его без изменений после разноски по файлам
 * (52-й проход, по образцу round 23/29 — EquipmentTab.tsx/ClientsTab.tsx).
 */
import { useRef, useState } from "react";
import { api, ApiError } from "../../../api/client";
import { useData } from "../../../context/DataContext";
import type { Client, Equipment, Rental } from "../../../api/types";
import { money, todayISO, isoAddDays, spanDays, formatPhoneInput, formatPassportInput } from "../../../lib/format";
import { useConfirm } from "../../../components/ConfirmDialog";
import { Dropdown } from "../../../components/Dropdown";
import { DatePicker } from "../../../components/DatePicker";
import { isEquipmentFreeForRange, equipmentCostForDays } from "./helpers";
import { FormModal } from "./FormModal";
import { EquipmentPicklist } from "./EquipmentPicklist";

/* ---------- Новая аренда ---------- */
export function CreateRentalModal({
  businessId,
  clients,
  equipment,
  rentals,
  initialClientId,
  initialEquipmentIds,
  initialStartDate,
  initialEndDate,
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
  // диапазон дат (initialStartDate/initialEndDate, если заданы, иначе
  // todayISO()..+2 — см. ниже), а не все переданные вслепую: иначе чекбокс
  // был бы виден отмеченным, но disabled (занято), что и выглядит как баг,
  // и не даёт пользователю понять, что вообще произошло.
  initialEquipmentIds?: string[];
  // Предзаполненный диапазон дат (53-й проход — действие "Забронировать" по
  // выделенному в Календаре диапазону столбцов, CalendarTab.tsx): при
  // обычном открытии не заданы, поведение как раньше (todayISO()..+2).
  // Поля дат остаются редактируемыми — предзаполнение не блокирует их.
  initialStartDate?: string;
  initialEndDate?: string;
  onClose: () => void;
  // Получает только что созданную аренду (56-й проход) — см. комментарий
  // у await onCreated(created) внутри handleSubmit ниже.
  onCreated: (rental: Rental) => Promise<void>;
}) {
  const [clientId, setClientId] = useState(initialClientId ?? "");
  const [startDate, setStartDate] = useState(initialStartDate ?? todayISO());
  const [endDate, setEndDate] = useState(initialEndDate ?? isoAddDays(todayISO(), 2));
  const [checkedIds, setCheckedIds] = useState<string[]>(() =>
    (initialEquipmentIds ?? []).filter((id) =>
      isEquipmentFreeForRange(id, initialStartDate ?? todayISO(), initialEndDate ?? isoAddDays(todayISO(), 2), rentals)
    )
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
      const created = await api.post<Rental>(`/businesses/${businessId}/rentals`, {
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
      // Созданная аренда передаётся в onCreated (56-й проход, п.2 обзора —
      // "после успешного создания аренды сразу предлагать распечатать
      // договор") — раньше onCreated ничего не получал, только сигнализировал
      // "готово, перезагрузи списки". Существующие потребители (RentalsTab.tsx,
      // Dashboard.tsx), у которых onCreated объявлен без параметров, менять не
      // пришлось — лишний аргумент для них просто ничего не значит.
      await onCreated(created);
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
        {/* "+ Добавить нового клиента" — под полем, прижата вправо (59-й
            проход: в общей строке с Dropdown'ом на flex:1 ссылка вытягивалась
            по высоте всей (крупной, с рамкой) закрытой кнопки дропдауна и
            смотрелась непропорционально крупной для второстепенного
            действия — тот же класс проблемы, что и раньше с "слева/справа",
            просто в этот раз про размер, а не про сторону. Возврат к
            изначальному компактному виду — тихая маленькая ссылка отдельной
            строкой (display:block, тот же приём, что и раньше — иначе
            .cat-filter у Dropdown не даёт переносу случиться сам по себе).
            width:"100%" ОБЯЗАТЕЛЕН отдельно от display:"block" (проверено
            локальным Playwright-замером) — <button>, в отличие от <div>,
            не растягивается на всю ширину контейнера от одного только
            display:block (особенность форм-контролов: их used width всегда
            считается по контенту, block только переносит на новую строку),
            без явного width текст-то "прижимался" textAlign:"right" внутри
            собственной узкой рамки по размеру самой надписи и в итоге
            торчал слева, как обычный текст. */}
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
          // width:"100%" — без style-пропа Dropdown сам по себе .cat-filter
          // (display: inline-block) сжимается по контенту закрытой кнопки
          // (см. Dropdown.tsx: style ? {width:"100%"} : undefined на
          // внутренней кнопке) — раньше здесь стоял style={{flex:1}} для
          // старой flex-строки с ссылкой рядом, он же попутно включал этот
          // растягивающий режим; при возврате ссылки под поле (см. комментарий
          // выше) flex тоже пропал, и поле стало у́же всех остальных в форме.
          style={{ width: "100%" }}
        />
        {!quickAddOpen && (
          <button
            type="button"
            className="link-btn"
            style={{ display: "block", width: "100%", textAlign: "right", marginTop: "8px" }}
            onClick={() => setQuickAddOpen(true)}
          >
            + Добавить нового клиента
          </button>
        )}
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
        {quickAddOpen && (
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
          <DatePicker value={startDate} onChange={setStartDate} />
        </div>
        <div className="field">
          <label>Окончание</label>
          <DatePicker value={endDate} onChange={setEndDate} align="right" />
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
