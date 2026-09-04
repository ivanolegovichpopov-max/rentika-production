/**
 * EditRentalModal — форма «Изменить аренду» (доступна для статусов
 * «Забронировано» и «В аренде»: даты, состав оборудования, скидка).
 * Вынесена в отдельный файл при разноске RentalsTab.tsx по модулям (52-й
 * проход, по образцу round 23/29).
 */
import { useRef, useState } from "react";
import { api, ApiError } from "../../../api/client";
import type { Client, Equipment, Rental } from "../../../api/types";
import { money, spanDays } from "../../../lib/format";
import { useConfirm } from "../../../components/ConfirmDialog";
import { equipmentCostForDays } from "./helpers";
import { FormModal } from "./FormModal";
import { EquipmentPicklist } from "./EquipmentPicklist";

/* ---------- Изменить аренду (доступно для "Забронировано" и "В аренде") ---------- */
export function EditRentalModal({
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
