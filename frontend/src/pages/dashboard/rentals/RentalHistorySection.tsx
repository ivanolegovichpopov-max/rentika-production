/**
 * Журнал изменений аренды (42-й проход, RentalDetailPanel) — read-only
 * список событий по этой аренде: кто и когда создал/выдал/продлил/вернул/
 * отменил её. Backend НЕ заводит отдельную таблицу под это — переиспользует
 * существующий AuditLog (пишется всеми действиями по аренде уже давно,
 * просто раньше нигде не читался обратно в интерфейс, см. GET
 * .../rentals/{id}/history в app/api/routes/rentals.py). Тот же структурный
 * idiom загрузки списка по rentalId, что и RentalPhotosSection.tsx.
 */
import { useEffect, useState } from "react";
import { api } from "../../../api/client";
import type { RentalHistoryEntry } from "../../../api/types";
import { fmtDate, money } from "../../../lib/format";
import { IconHistory } from "../../../lib/icons";

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
    default:
      return [];
  }
}

export function RentalHistorySection({ businessId, rentalId }: { businessId: string; rentalId: string }) {
  const [entries, setEntries] = useState<RentalHistoryEntry[] | null>(null);

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
          {entries.map((entry, i) => {
            const details = entryDetails(entry);
            return (
              <div key={i} style={{ fontSize: "12.5px", paddingLeft: "10px", borderLeft: "2px solid var(--border)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                  <span style={{ fontWeight: 600 }}>{ACTION_LABELS[entry.action] ?? entry.action}</span>
                  <span style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>
                    {fmtDate(entry.created_at.slice(0, 10))}
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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
