/**
 * Журнал изменений аренды (42-й проход, RentalDetailPanel) — read-only
 * список событий по этой аренде: кто и когда создал/выдал/продлил/вернул/
 * отменил её. Backend НЕ заводит отдельную таблицу под это — переиспользует
 * существующий AuditLog (пишется всеми действиями по аренде уже давно,
 * просто раньше нигде не читался обратно в интерфейс, см. GET
 * .../rentals/{id}/history в app/api/routes/rentals.py). Тот же структурный
 * idiom загрузки списка по rentalId, что и RentalPhotosSection.tsx.
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../../api/client";
import type { RentalHistoryEntry } from "../../../api/types";
import { useData } from "../../../context/DataContext";
import { fmtDate, money } from "../../../lib/format";
import { IconClose, IconHistory } from "../../../lib/icons";

// Человекочитаемые подписи для action — 1:1 набор строк, которые reзапросы
// action=... пишут через log_action(...) по всему rentals.py (create/issue/
// edit/return/return_items/cancel/deposit_return/deposit_return_undo).
const ACTION_LABELS: Record<string, string> = {
  create: "Аренда создана",
  issue: "Оборудование выдано",
  edit: "Аренда изменена",
  return: "Аренда закрыта (возврат)",
  return_items: "Частичный возврат позиций",
  cancel: "Аренда отменена",
  deposit_return: "Депозит отмечен возвращённым",
  deposit_return_undo: "Отметка о возврате депозита снята",
  payment: "Записан платёж",
  // 49-й проход — отдельная подпись, а не переиспользование "Записан
  // платёж": это НЕ ещё один платёж, а исправление ранее внесённой суммы
  // (см. CorrectionModal ниже), человек должен сразу отличать одно от
  // другого в списке, не вчитываясь в детали.
  payment_correction: "Платёж исправлен",
};

// Описание конкретной правки внутри action="edit" — meta несёт только те
// пары "_before"/"_after", которые реально изменились (см. history_meta в
// edit_rental), поэтому строк может быть от одной до нескольких.
function editDetails(meta: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if ("start_date_before" in meta) {
    lines.push(`начало: ${fmtDate(String(meta.start_date_before))} → ${fmtDate(String(meta.start_date_after))}`);
  }
  if ("end_date_before" in meta) {
    lines.push(`окончание: ${fmtDate(String(meta.end_date_before))} → ${fmtDate(String(meta.end_date_after))}`);
  }
  if ("equipment_count_before" in meta) {
    lines.push(`позиций: ${meta.equipment_count_before} → ${meta.equipment_count_after}`);
  }
  if ("discount_before" in meta) {
    lines.push(`скидка: ${money(Number(meta.discount_before))} → ${money(Number(meta.discount_after))}`);
  }
  if ("extra_fee_before" in meta) {
    lines.push(`доп. услуги: ${money(Number(meta.extra_fee_before))} → ${money(Number(meta.extra_fee_after))}`);
  }
  if ("extra_fee_note_before" in meta) {
    const before = meta.extra_fee_note_before ? String(meta.extra_fee_note_before) : "—";
    const after = meta.extra_fee_note_after ? String(meta.extra_fee_note_after) : "—";
    lines.push(`за что (доп. услуги): ${before} → ${after}`);
  }
  return lines;
}

function entryDetails(entry: RentalHistoryEntry): string[] {
  const meta = entry.meta;
  if (!meta) return [];
  switch (entry.action) {
    case "edit":
      return editDetails(meta);
    case "return":
      return [
        typeof meta.damage_fee === "number" && meta.damage_fee > 0 ? `повреждения: ${money(meta.damage_fee)}` : "",
        typeof meta.discount === "number" && meta.discount > 0 ? `скидка клиенту: ${money(meta.discount)}` : "",
      ].filter(Boolean);
    case "return_items":
      return [
        Array.isArray(meta.equipment_ids) ? `позиций возвращено: ${meta.equipment_ids.length}` : "",
        meta.closed ? "аренда закрыта этим возвратом" : "",
      ].filter(Boolean);
    // Причина отмены (43-й проход, п.5 обзора) — meta присутствует только
    // когда сотрудник её ввёл (см. RentalCancel/cancel_rental на backend'е:
    // пустая причина не создаёт meta вовсе), поэтому здесь достаточно
    // проверить наличие поля.
    case "cancel":
      return typeof meta.reason === "string" && meta.reason ? [`причина: ${meta.reason}`] : [];
    case "payment":
      return [
        typeof meta.amount === "number"
          ? `${meta.amount >= 0 ? "внесено" : "корректировка"}: ${money(meta.amount)}`
          : "",
        typeof meta.paid_amount_after === "number" ? `оплачено всего: ${money(meta.paid_amount_after)}` : "",
      ].filter(Boolean);
    // Исправление платежа (49-й проход) — показываем "было → стало" вместо
    // голой дельты (та же meta.amount, что и у payment, но по отдельности
    // она ничего не объясняет: "-4500" само по себе не говорит, опечатка
    // это, возврат клиенту или что-то ещё).
    case "payment_correction":
      return [
        typeof meta.corrected_from === "number" && typeof meta.corrected_to === "number"
          ? `исправлено: ${money(meta.corrected_from)} → ${money(meta.corrected_to)}`
          : "",
        typeof meta.paid_amount_after === "number" ? `оплачено всего: ${money(meta.paid_amount_after)}` : "",
      ].filter(Boolean);
    default:
      return [];
  }
}

/* ---------- Исправление опечатки в платеже (49-й проход) ---------- */
function CorrectionModal({
  businessId,
  rentalId,
  entry,
  onClose,
  onCorrected,
}: {
  businessId: string;
  rentalId: string;
  entry: RentalHistoryEntry;
  onClose: () => void;
  onCorrected: () => Promise<void>;
}) {
  const currentAmount = typeof entry.meta?.amount === "number" ? entry.meta.amount : 0;
  const [value, setValue] = useState(String(currentAmount));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (value.trim() === "" || Number.isNaN(Number(value))) {
      setError("Введите сумму");
      return;
    }
    setSaving(true);
    try {
      // Отправляем "сколько должно было быть" — не разницу: сервер сам
      // находит текущее действующее значение этой записи (с учётом более
      // ранних исправлений, если они уже были) и считает delta сам, см.
      // докстринг RentalPaymentCorrection/correct_rental_payment на бэкенде.
      await api.post(`/businesses/${businessId}/rentals/${rentalId}/history/${entry.id}/correct`, {
        corrected_to: Number(value),
      });
      onClose();
      await onCorrected();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось исправить платёж");
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      id="modal"
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form onSubmit={handleSubmit}>
        <div className="modal-head">
          <h3>Исправить платёж</h3>
          <button className="icon-btn" onClick={onClose} type="button">
            <IconClose />
          </button>
        </div>
        <div className="modal-body">
          <div className="field-hint" style={{ marginBottom: "10px" }}>
            Сейчас в этой записи внесено {money(currentAmount)}. Укажите, сколько должно было быть, — разницу
            система посчитает сама.
          </div>
          <div className="field">
            <label>Сумма этого платежа, ₽</label>
            <input type="number" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose} type="button">
            Отмена
          </button>
          <button className="btn btn-primary" type="submit">
            {saving ? "Сохранение…" : "Исправить"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function RentalHistorySection({ businessId, rentalId }: { businessId: string; rentalId: string }) {
  const { reloadRentals } = useData();
  const [entries, setEntries] = useState<RentalHistoryEntry[] | null>(null);
  // Запись, которую сейчас исправляют (49-й проход) — не булев флаг, а сама
  // запись: CorrectionModal нужны её id и текущая сумма (entry.meta.amount)
  // для подсказки "сейчас внесено ...".
  const [correcting, setCorrecting] = useState<RentalHistoryEntry | null>(null);

  function reload() {
    return api
      .get<RentalHistoryEntry[]>(`/businesses/${businessId}/rentals/${rentalId}/history`)
      .then((res) => setEntries(res))
      .catch(() => setEntries([]));
  }

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    api
      .get<RentalHistoryEntry[]>(`/businesses/${businessId}/rentals/${rentalId}/history`)
      .then((res) => {
        if (!cancelled) setEntries(res);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, rentalId]);

  // id исходных платежей, которые уже хоть раз исправляли (49-й проход) —
  // чтобы у самой первой записи "Записан платёж" показать пометку и не
  // заставлять читать весь список в поисках, куда делась эта сумма.
  const correctedEntryIds = new Set(
    (entries ?? [])
      .filter((e) => e.action === "payment_correction" && typeof e.meta?.correction_of === "string")
      .map((e) => e.meta!.correction_of as string)
  );

  return (
    <div className="slideover-section">
      <h4 style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <IconHistory /> Журнал изменений
      </h4>
      {entries === null ? (
        <div className="empty-note">Загрузка…</div>
      ) : entries.length === 0 ? (
        <div className="empty-note">Записей пока нет</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {entries.map((entry) => {
            const details = entryDetails(entry);
            // Исправить можно только исходный платёж, не саму коррекцию
            // (см. докстринг correct_rental_payment на бэкенде) — иначе
            // пришлось бы решать, что значит "исправить исправление".
            const correctable = entry.action === "payment";
            return (
              <div key={entry.id} style={{ fontSize: "12.5px", paddingLeft: "10px", borderLeft: "2px solid var(--border)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                  <span style={{ fontWeight: 600 }}>
                    {ACTION_LABELS[entry.action] ?? entry.action}
                    {correctedEntryIds.has(entry.id) && (
                      <span style={{ fontWeight: 400, color: "var(--muted)" }}> · исправлен ниже</span>
                    )}
                  </span>
                  {/* Время рядом с датой (48-й проход, обратная связь по
                      карточке аренды) — без него несколько записей за один
                      день (чаще всего "Записан платёж") были неотличимы друг
                      от друга, порядок читался только по позиции в списке.
                      Тот же idiom "дата · время", что и у уведомлений на
                      дашборде (см. DashboardTab.tsx). */}
                  <span style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>
                    {fmtDate(entry.created_at.slice(0, 10))} ·{" "}
                    {new Date(entry.created_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
                <div style={{ color: "var(--muted)", marginTop: "1px" }}>
                  {entry.employee_name ?? "Сотрудник не определён"}
                </div>
                {details.length > 0 && (
                  <div style={{ marginTop: "3px" }}>
                    {details.map((line, j) => (
                      <div key={j}>{line}</div>
                    ))}
                  </div>
                )}
                {/* "Исправить" (49-й проход, обратная связь: "нужен
                    механизм корректировки сумм, вдруг опечатался") — тихая
                    текстовая ссылка, а не кнопка: это редкое действие для
                    read-only по сути журнала, не должно выглядеть весомее
                    самих записей. */}
                {correctable && (
                  <button
                    type="button"
                    className="link-btn"
                    style={{ marginTop: "4px" }}
                    onClick={() => setCorrecting(entry)}
                  >
                    Исправить
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {correcting && (
        <CorrectionModal
          businessId={businessId}
          rentalId={rentalId}
          entry={correcting}
          onClose={() => setCorrecting(null)}
          onCorrected={async () => {
            await Promise.all([reload(), reloadRentals()]);
          }}
        />
      )}
    </div>
  );
}
