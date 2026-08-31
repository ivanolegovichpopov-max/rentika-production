/**
 * EquipmentImportModal — вынесено из EquipmentTab.tsx в отдельный модуль
 * (двадцать второй проход, "разнести по отдельным файлам").
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../../api/client";
import type { EquipmentCategory, EquipmentImportResult } from "../../../api/types";
import { IconClose } from "../../../lib/icons";
import { parseCsv, csvRowsToObjects, toCsv } from "../../../lib/csv";
import { CategoryAutocomplete } from "./CategoryAutocomplete";
import { IMPORT_TEMPLATE_HEADER, downloadImportTemplate } from "./csv";

interface ImportPreviewRow {
  row: number;
  // Все колонки шаблона (не только проблемные) — чтобы при сборке
  // исправленного CSV перед отправкой (см. handleImport) неотредактированные
  // поля не терялись, см. 16-й проход, п.6 обзора.
  values: Record<string, string>;
  problems: string[];
}

/** Лёгкая клиентская проверка — только то, что можно сказать без сети
 * (справочник категорий уже загружен в контексте, но окончательное решение
 * "существует ли категория" всё равно принимает backend, в том числе
 * потому что для владельца неизвестная категория — это не ошибка, а повод
 * завести её). Здесь ловим только совсем явный мусор — пустые обязательные
 * поля и нечисловую ставку — чтобы пользователь увидел проблему до
 * отправки файла, а не только из ответа сервера. */
function validatePreviewRow(obj: Record<string, string>): string[] {
  const problems: string[] = [];
  if (!obj.name) problems.push("нет названия");
  if (!obj.category) problems.push("нет категории");
  const rate = (obj.daily_rate || "").replace(",", ".");
  if (!rate) problems.push("нет ставки");
  else if (Number.isNaN(Number(rate))) problems.push("ставка не число");
  return problems;
}

export function EquipmentImportModal({
  open,
  businessId,
  categories,
  onClose,
  onImported,
}: {
  open: boolean;
  businessId: string;
  // Для автодополнения категории при инлайн-редактировании ячейки
  // предпросмотра (16-й проход, п.6 обзора).
  categories: EquipmentCategory[];
  onClose: () => void;
  onImported: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewRow[]>([]);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<EquipmentImportResult | null>(null);

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
    if (!header.includes("name") || !header.includes("category") || !header.includes("daily_rate")) {
      setHeaderError("В заголовке файла должны быть как минимум колонки: name, category, daily_rate");
      return;
    }
    const objects = csvRowsToObjects(parsed);
    setPreview(
      objects.map((obj, idx) => ({
        row: idx + 2, // строка 1 — заголовок
        values: Object.fromEntries(IMPORT_TEMPLATE_HEADER.map((h) => [h, obj[h] || ""])),
        problems: validatePreviewRow(obj),
      }))
    );
  }

  /** Правка ячейки прямо в таблице предпросмотра (16-й проход, п.6 обзора:
   * "быстрая смена значений" вместо необходимости чинить сам файл и грузить
   * заново) — пересчитывает проблемы строки сразу же, чтобы было видно,
   * решена ли она. */
  function updateCell(rowIdx: number, field: string, value: string) {
    setPreview((prev) =>
      prev.map((r, i) => {
        if (i !== rowIdx) return r;
        const values = { ...r.values, [field]: value };
        return { ...r, values, problems: validatePreviewRow(values) };
      })
    );
  }

  async function handleImport() {
    if (!file || preview.length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Собираем CSV заново из (возможно отредактированных прямо в
      // предпросмотре) значений, а не отправляем исходный файл как есть —
      // иначе правки в таблице предпросмотра были бы чисто визуальными и
      // никак не влияли бы на то, что реально уходит на сервер.
      const rows = preview.map((r) => IMPORT_TEMPLATE_HEADER.map((h) => r.values[h] ?? ""));
      const csv = toCsv(IMPORT_TEMPLATE_HEADER, rows);
      const editedFile = new File(["﻿" + csv], file.name, { type: "text/csv;charset=utf-8" });
      const form = new FormData();
      form.append("file", editedFile);
      const res = await api.postForm<EquipmentImportResult>(`/businesses/${businessId}/equipment/import`, form);
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
        <h3>Массовый импорт оборудования из CSV</h3>
        <button type="button" className="icon-btn" onClick={handleClose}>
          <IconClose />
        </button>
      </div>
      <div className="modal-body">
        {!result && (
          <>
            <div className="field-hint" style={{ marginBottom: "10px" }}>
              Файл CSV с заголовком в первой строке. Обязательные колонки: <code>name</code>, <code>category</code>,{" "}
              <code>daily_rate</code>. Необязательные: <code>warehouse</code>, <code>code</code>, <code>deposit</code>,{" "}
              <code>period_days</code>, <code>period_price</code>, <code>period_price_after</code>,{" "}
              <code>after_period_days</code>, <code>notes</code>. Категория и склад должны либо уже быть в соответствующем справочнике, либо — если
              импорт делает владелец бизнеса — заведутся автоматически.
            </div>
            <button type="button" className="btn btn-sm" onClick={downloadImportTemplate}>
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
                  Окончательную проверку (включая справочник категорий) всё равно выполнит сервер.
                </div>
                <div className="table-wrap" style={{ maxHeight: "260px", overflowY: "auto", marginTop: "8px" }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Строка</th>
                        <th>Название</th>
                        <th>Категория</th>
                        <th>Ставка</th>
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
                            <CategoryAutocomplete
                              inputClassName="table-input"
                              value={r.values.category}
                              onChange={(v) => updateCell(idx, "category", v)}
                              categories={categories.map((c) => c.name)}
                            />
                          </td>
                          <td>
                            <input
                              className="table-input mono"
                              value={r.values.daily_rate}
                              onChange={(e) => updateCell(idx, "daily_rate", e.target.value)}
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
                    <th>Название</th>
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
                          <span style={{ color: "var(--good-ink)", fontWeight: 600 }}>Создано</span>
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
