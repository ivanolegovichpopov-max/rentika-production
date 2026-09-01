/**
 * EquipmentFormModal — вынесено из EquipmentTab.tsx в отдельный модуль
 * (двадцать второй проход, "разнести по отдельным файлам").
 */
import { useEffect, useRef, useState } from "react";
import type { EquipmentCategory, EquipmentWarehouse } from "../../../api/types";
import { money } from "../../../lib/format";
import { IconClose } from "../../../lib/icons";
import { useConfirm } from "../../../components/ConfirmDialog";
import { itemCostForDays } from "../../../lib/financeCalc";
import { CategoryAutocomplete } from "./CategoryAutocomplete";
import { Dropdown } from "../../../components/Dropdown";
import { type EquipmentFormState, hasTieredValues, isFormDirty, parseDecimalField } from "./formHelpers";
import { useModalDialog } from "../../../lib/useModalDialog";

/** Модалка добавления/изменения оборудования — тот же идиом `<dialog>`
 * (ref + showModal()/close() в useEffect по `open`), что и DocModal в
 * ./documents.tsx, только с формой вместо предпросмотра документа. Поля и
 * подсказка ступенчатого тарифа — 1:1 из демо (tieredRateFieldsHtml), но
 * секция теперь сворачиваемая (14-й проход, пункт 3 обзора формы "Добавить"). */
export function EquipmentFormModal({
  open,
  title,
  initial,
  error,
  isOwner,
  categories,
  warehouses,
  existingCodes,
  allowAddAnother,
  resetSignal,
  onClose,
  onSubmit,
  onManageCategories,
  onManageWarehouses,
}: {
  open: boolean;
  title: string;
  initial: EquipmentFormState;
  error: string | null;
  isOwner: boolean;
  categories: EquipmentCategory[];
  // Справочник складов (восемнадцатый проход) — та же механика, что и у
  // categories выше, но необязательное поле (см. EquipmentFormState.warehouse).
  warehouses: EquipmentWarehouse[];
  // Инвентарные номера уже существующих позиций (кроме редактируемой) — для
  // мягкого предупреждения о дубле, см. duplicateCode ниже.
  existingCodes: string[];
  // Кнопка "Сохранить и добавить ещё" имеет смысл только в режиме
  // добавления/копирования — при редактировании существующей позиции
  // "добавить ещё" нечего.
  allowAddAnother: boolean;
  // Счётчик от родителя: инкремент означает "форма только что успешно
  // отправлена с addAnother=true, сбрось поля, не закрывая модалку" — тот же
  // паттерн, что и createRentalSignal/highlightEmployee.signal в других
  // вкладках.
  resetSignal: number;
  onClose: () => void;
  // Возвращает Promise — модалка ждёт его, чтобы показать "Сохраняем…" и
  // заблокировать повторную отправку (16-й проход, п.2 предыдущего обзора:
  // защита от двойного клика, особенно на бесплатном плане Render с
  // "холодным" стартом backend'а после простоя).
  onSubmit: (form: EquipmentFormState, addAnother: boolean) => Promise<void> | void;
  // Ссылка "Управление категориями" рядом с полем "Категория" (16-й проход,
  // п.7 предыдущего обзора) — открывает EquipmentCategoriesModal ПОВЕРХ этой
  // формы, НЕ закрывая её (родитель не сбрасывает modalMode), чтобы, заметив
  // опечатку в справочнике прямо во время добавления позиции, не пришлось
  // отменять уже введённые данные. Необязательная — форма работает и без
  // неё, если родитель её не передал. Принимает колбэк onPicked — родитель
  // прокидывает его в EquipmentCategoriesModal как onSelect: клик по строке
  // справочника подставит имя сюда, в поле формы (19-й проход, п.2 обзора —
  // "сделать все значения кликабельными"). Открытая тем же кликом из тулбара
  // (без onManageCategories) модалка select-режим не показывает — там onSelect
  // не передаётся вовсе, см. рендер модалки у родителя.
  onManageCategories?: (onPicked: (name: string) => void) => void;
  // Ссылка "Управление складами" — тот же смысл, что и onManageCategories
  // выше (восемнадцатый проход).
  onManageWarehouses?: (onPicked: (name: string) => void) => void;
}) {
  // useModalDialog вместо инлайновой ref+useEffect-пары (29-й проход,
  // повторный обзор, п.16 — подробности в докстринге хука) — защищает от
  // подтверждённого вживую в браузере бага, когда закрытие вложенного
  // confirm-диалога ("Несохранённые изменения") спонтанно эмитило нативное
  // close и на ЭТОМ диалоге тоже, хотя open оставался true.
  const { ref, handleNativeClose } = useModalDialog(open);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<EquipmentFormState>(initial);
  const [showTiered, setShowTiered] = useState(hasTieredValues(initial));
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Отдельный useConfirm — для "Несохранённые изменения будут потеряны?" при
  // закрытии заполненной формы (16-й проход, п.6 предыдущего обзора).
  const { confirm: confirmDiscard, dialog: discardDialog } = useConfirm();

  // Сброс формы при открытии и при каждом "Сохранить и добавить ещё"
  // (resetSignal меняется) — родитель к этому моменту уже пересчитал
  // `initial` под новое пустое состояние (см. EquipmentTab.handleSubmitForm).
  // Native <dialog> остаётся смонтированным всё время (только showModal()/
  // close()), поэтому React не переинициализирует состояние сам по себе —
  // приходится это делать вручную.
  useEffect(() => {
    if (open) {
      setForm(initial);
      setShowTiered(hasTieredValues(initial));
      setLocalError(null);
      // Фокус на "Название" — autoFocus не подходит: он срабатывает только
      // при первом монтировании DOM-узла, а <dialog> здесь монтируется один
      // раз и просто переоткрывается. requestAnimationFrame — чтобы фокус
      // ставился уже после showModal() (иначе браузер может увести фокус на
      // сам <dialog>).
      const raf = requestAnimationFrame(() => nameInputRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resetSignal]);

  const trimmedCode = form.code.trim();
  const duplicateCode = trimmedCode !== "" && existingCodes.includes(trimmedCode);

  const trimmedCategory = form.category.trim();
  // 16-й проход, п.1 предыдущего обзора: подсказка "такой категории ещё нет"
  // для владельца — видна ДО сохранения, чтобы опечатка не превратилась в
  // отдельную категорию-дубль (именно так на проде когда-то расплодились
  // случайные "категории", см. заметки проекта, 15-й проход). Не показана
  // для остальных ролей — у них поле и так закрытый <select> из справочника.
  const isNewCategory =
    isOwner && trimmedCategory !== "" && !categories.some((c) => c.name.toLowerCase() === trimmedCategory.toLowerCase());

  // Тот же смысл, что и isNewCategory выше, но для склада — восемнадцатый
  // проход. Поле необязательное, так что пустое значение никогда не
  // считается "новым складом".
  const trimmedWarehouse = form.warehouse.trim();
  const isNewWarehouse =
    isOwner && trimmedWarehouse !== "" && !warehouses.some((w) => w.name.toLowerCase() === trimmedWarehouse.toLowerCase());

  // 16-й проход, п.3 предыдущего обзора: "битая" настройка ступенчатого
  // тарифа — заполнено 1-3 поля из четырёх, остальные забыты — раньше молча
  // игнорировалась (rateLabel требует и period_days, и period_price сразу).
  // Двадцатый проход добавил четвёртое поле (after_period_days) — та же
  // проверка "всё или ничего", но на четыре поля вместо трёх.
  function tieredProblem(): string | null {
    const filled = [form.period_days, form.period_price, form.period_price_after, form.after_period_days].filter(
      (v) => v.trim() !== ""
    ).length;
    if (filled > 0 && filled < 4) {
      return "Для ступенчатого тарифа нужно заполнить все поля: период, цену за период, длительность шага после и цену за шаг после (или очистить все четыре).";
    }
    return null;
  }

  function validateLocally(): string | null {
    if (!form.name.trim()) return "Название не может состоять из одних пробелов";
    if (!form.category.trim()) return "Категория не может состоять из одних пробелов";
    const rate = parseDecimalField(form.daily_rate);
    if (rate.empty || !rate.valid || (rate.value ?? -1) < 0) return "Ставка должна быть неотрицательным числом.";
    const deposit = parseDecimalField(form.deposit);
    if (deposit.empty || !deposit.valid || (deposit.value ?? -1) < 0) return "Депозит должен быть неотрицательным числом.";
    const periodPrice = parseDecimalField(form.period_price);
    if (!periodPrice.valid) return "Цена за период должна быть числом.";
    const periodPriceAfter = parseDecimalField(form.period_price_after);
    if (!periodPriceAfter.valid) return "Цена за шаг после периода должна быть числом.";
    if (form.after_period_days.trim() !== "" && (!Number.isInteger(Number(form.after_period_days)) || Number(form.after_period_days) < 1)) {
      return "Длительность шага после периода должна быть целым числом дней, не меньше 1.";
    }
    if (allowAddAnother) {
      const qty = Number(form.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > 200) return "Количество должно быть целым числом от 1 до 200.";
    }
    return tieredProblem();
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problem = validateLocally();
    if (problem) {
      setLocalError(problem);
      return;
    }
    setLocalError(null);
    // submitter отличает, какая из двух submit-кнопок нажата — оба варианта
    // ("Сохранить" и "Сохранить и добавить ещё") живут в одной <form>, чтобы
    // не дублировать всю разметку полей.
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const addAnother = submitter?.dataset.addAnother === "true";
    setSubmitting(true);
    try {
      await onSubmit(form, addAnother);
    } finally {
      setSubmitting(false);
    }
  }

  // Единая точка закрытия — X, "Отмена", Esc (см. onCancel ниже) и клик мимо
  // окна (см. onClick на <dialog> ниже) все идут через неё: спрашивает
  // подтверждение, только если форма реально отличается от исходного
  // состояния, иначе закрывает сразу (16-й проход, п.2+6 обзора).
  async function requestClose() {
    if (submitting) return;
    if (isFormDirty(form, initial)) {
      if (!(await confirmDiscard("Несохранённые изменения будут потеряны.", { confirmLabel: "Закрыть без сохранения" })))
        return;
    }
    onClose();
  }

  const previewRate = parseDecimalField(form.daily_rate).value ?? 0;
  const showCostPreview = previewRate > 0;
  // Пример стоимости при вводе ставки/тарифа (16-й проход, п.4 предыдущего
  // обзора) — переиспользует уже существующую itemCostForDays() из
  // financeCalc.ts (та же формула, что считает реальную стоимость аренды),
  // а не отдельную копию логики тарифа.
  function previewCost(days: number): number {
    const periodDays = form.period_days ? Number(form.period_days) : null;
    return itemCostForDays(
      {
        equipment_id: "",
        daily_rate_snapshot: previewRate,
        period_days_snapshot: periodDays,
        period_price_snapshot: parseDecimalField(form.period_price).value,
        period_price_after_snapshot: parseDecimalField(form.period_price_after).value,
        // Длина шага "после" — двадцатый проход, свободна от periodDays (см.
        // Equipment.after_period_days).
        after_period_days_snapshot: form.after_period_days ? Number(form.after_period_days) : null,
      },
      days
    );
  }

  return (
    <dialog
      id="modal"
      className="wide"
      ref={ref}
      onClose={() => handleNativeClose(onClose)}
      onCancel={(e) => {
        // Нативный Escape по умолчанию закрыл бы диалог мгновенно — перехватываем,
        // чтобы провести через ту же проверку "не потерять несохранённое", что и
        // остальные способы закрытия.
        e.preventDefault();
        void requestClose();
      }}
      // Клик по затемнённому фону — та же правка, что и у ClientFormModal.tsx
      // (см. докстринг там): раньше был полностью отключён на этих двух
      // формах, теперь снова закрывает форму по клику мимо, но безопасно —
      // через requestClose(), с тем же предупреждением "Несохранённые
      // изменения будут потеряны?" при заполненной форме.
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
            <label>Название</label>
            <input
              required
              ref={nameInputRef}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Например, перфоратор Bosch GBH 5-40"
            />
          </div>
          <div className="field">
            <label>Категория</label>
            {isOwner ? (
              // Владелец может ввести и совсем новое название — оно
              // автоматически заведётся в справочнике при сохранении (см.
              // backend: app/api/routes/equipment.py:_ensure_category).
              // CategoryAutocomplete даёт автодополнение по уже существующим,
              // но не запрещает свободный ввод — это и есть "владелец создаёт
              // категории". Поле теперь на своей строке во всю ширину (было
              // в паре с "Инв. номер") — иначе подсказка-плейсхолдер не
              // помещалась (16-й проход, п.7 предыдущего обзора). Раньше
              // здесь был нативный `<input list>`+`<datalist>` — заменён на
              // свой компонент (16-й проход, обзор по скриншотам, п.6:
              // выпадающий список datalist был уже самого поля).
              <CategoryAutocomplete
                required
                value={form.category}
                onChange={(v) => setForm({ ...form, category: v })}
                categories={categories.map((c) => c.name)}
                placeholder="Инструмент, электроника… (или новая категория)"
              />
            ) : (
              // Остальные роли — только выбор из уже существующего
              // справочника, свободный текст закрыт: он всё равно будет
              // отклонён backend'ом (400), выпадающий список честнее
              // показывает границы прав, чем текстовое поле, которое
              // потом откажется сохраняться.
              <Dropdown
                value={form.category}
                onChange={(v) => setForm({ ...form, category: v })}
                placeholder="Выберите категорию…"
                options={categories.map((c) => ({ value: c.name, label: c.name }))}
              />
            )}
            {categories.length === 0 && !isOwner && (
              <div className="field-hint">Справочник категорий пуст — попросите владельца бизнеса добавить категории.</div>
            )}
            {isNewCategory && (
              <div className="field-hint">Такой категории пока нет — она будет создана автоматически при сохранении.</div>
            )}
            {isOwner && onManageCategories && (
              <div className="field-hint">
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => onManageCategories((name) => setForm((f) => ({ ...f, category: name })))}
                >
                  Управление категориями
                </button>
              </div>
            )}
          </div>
          <div className="field">
            <label>Склад</label>
            {/* Склад — необязательное поле (в отличие от категории), по той
                же механике: владелец может ввести новое название (заведётся
                в справочнике автоматически при сохранении), остальные роли
                выбирают из уже существующего списка или оставляют поле
                пустым — восемнадцатый проход, обзор по скриншотам, п.2:
                "по принципу категорий... можно пойти механике категорий и
                всё разместить тут". */}
            {isOwner ? (
              <CategoryAutocomplete
                value={form.warehouse}
                onChange={(v) => setForm({ ...form, warehouse: v })}
                categories={warehouses.map((w) => w.name)}
                placeholder="Необязательно — если несколько точек хранения"
              />
            ) : (
              <Dropdown
                value={form.warehouse}
                onChange={(v) => setForm({ ...form, warehouse: v })}
                placeholder="Не указан"
                options={[
                  { value: "", label: "Не указан" },
                  ...warehouses.map((w) => ({ value: w.name, label: w.name })),
                ]}
              />
            )}
            {isNewWarehouse && (
              <div className="field-hint">Такого склада пока нет — он будет создан автоматически при сохранении.</div>
            )}
            {isOwner && onManageWarehouses && (
              <div className="field-hint">
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => onManageWarehouses((name) => setForm((f) => ({ ...f, warehouse: name })))}
                >
                  Управление складами
                </button>
              </div>
            )}
          </div>
          <div className="field-row">
            <div className="field" style={{ maxWidth: "220px" }}>
              <label>Инв. номер</label>
              <input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder="INV-000 (необязательно)"
              />
              {duplicateCode && (
                <div className="field-hint" style={{ color: "var(--warning-ink)" }}>
                  Такой инвентарный номер уже используется другой позицией — сохранить всё равно можно, но лучше
                  проверить, не опечатка ли это.
                </div>
              )}
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Ставка, ₽/сутки</label>
              <input
                required
                type="text"
                inputMode="decimal"
                value={form.daily_rate}
                onChange={(e) => setForm({ ...form, daily_rate: e.target.value })}
                placeholder="напр. 500"
              />
            </div>
            <div className="field">
              <label>Депозит, ₽</label>
              <input
                required
                type="text"
                inputMode="decimal"
                value={form.deposit}
                onChange={(e) => setForm({ ...form, deposit: e.target.value })}
              />
            </div>
          </div>
          {allowAddAnother && (
            <div className="field-row">
              <div className="field">
                <label>Количество одинаковых позиций</label>
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={form.quantity}
                  onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                />
                <div className="field-hint">
                  Если позиций несколько (напр. 30 пар одинаковых костылей), создастся сразу столько отдельных
                  позиций — каждая с собственным статусом и историей аренд.
                </div>
              </div>
            </div>
          )}
          {showTiered ? (
            <>
              <div className="field-row field-row-4">
                <div className="field">
                  <label>Период, дней</label>
                  <input
                    type="number"
                    min="0"
                    value={form.period_days}
                    onChange={(e) => setForm({ ...form, period_days: e.target.value })}
                    placeholder="напр. 14"
                  />
                </div>
                <div className="field">
                  <label>Цена за период, ₽</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={form.period_price}
                    onChange={(e) => setForm({ ...form, period_price: e.target.value })}
                    placeholder="напр. 690"
                  />
                </div>
                <div className="field">
                  <label>Длительность шага после, дней</label>
                  <input
                    type="number"
                    min="1"
                    value={form.after_period_days}
                    onChange={(e) => setForm({ ...form, after_period_days: e.target.value })}
                    placeholder="напр. 7"
                  />
                </div>
                <div className="field">
                  <label>Цена за шаг после периода, ₽</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={form.period_price_after}
                    onChange={(e) => setForm({ ...form, period_price_after: e.target.value })}
                    placeholder="напр. 190"
                  />
                </div>
              </div>
              <div className="field-hint">
                Заполните, если ставка снижается при длительной аренде: первые N дней — по фиксированной цене, а
                каждый полный или начатый шаг сверх этого периода — по отдельной цене за шаг своей длины. Например:
                690 ₽ за первые 14 дней, затем 190 ₽ за любую начатую неделю (шаг 7 дней) после.{" "}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setShowTiered(false);
                    setForm({ ...form, period_days: "", period_price: "", period_price_after: "", after_period_days: "" });
                  }}
                >
                  Убрать ступенчатый тариф
                </button>
              </div>
            </>
          ) : (
            <div className="field-hint">
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setShowTiered(true);
                  setForm({ ...form, after_period_days: form.after_period_days || "1" });
                }}
              >
                + Добавить ступенчатый тариф
              </button>{" "}
              (необязательно — для скидки при длительной аренде)
            </div>
          )}
          {showCostPreview && (
            <div className="field-hint">
              Пример: 7 дней ≈ {money(previewCost(7))} · 30 дней ≈ {money(previewCost(30))}
            </div>
          )}
          <div className="field">
            <label>Заметка</label>
            <textarea
              rows={3}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Состояние, комплектация, особенности — что угодно, что стоит помнить про эту позицию"
            />
          </div>
          {(localError || error) && <div className="form-error">{localError || error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={() => void requestClose()} disabled={submitting}>
            Отмена
          </button>
          {allowAddAnother && (
            <button type="submit" className="btn" data-add-another="true" disabled={submitting}>
              {submitting ? "Сохраняем…" : "Сохранить и добавить ещё"}
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </form>
      {discardDialog}
    </dialog>
  );
}
