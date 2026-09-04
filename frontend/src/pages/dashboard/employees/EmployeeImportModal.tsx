/**
 * Упрощённый CSV-импорт сотрудников (66-й проход, "делаем всё") — тот же
 * <dialog>-каркас, что EquipmentImportModal.tsx/ClientImportModal.tsx, но
 * сознательно БЕЗ редактируемого превью-грида: файл выбирается и сразу
 * отправляется на POST .../employees/import (см. import_employees в
 * app/api/routes/employees.py), а результат — построчный отчёт — виден
 * сразу после ответа. Приглашение — операция с реальными учётными
 * данными (email, временный пароль), а не карточка товара, поэтому
 * промежуточный шаг "поправить перед отправкой" здесь не так ценен, как
 * для оборудования/клиентов, и опущен ради простоты (см. обсуждение в
 * README округа/notes-round66).
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../../api/client";
import type { EmployeeImportResult } from "../../../api/types";
import { IconClose } from "../../../lib/icons";
import { downloadEmployeeImportTemplate } from "./csv";

export function EmployeeImportModal({
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
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<EmployeeImportResult | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function reset() {
    setFile(null);
    setSubmitError(null);
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleImport() {
    if (!file) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await api.postForm<EmployeeImportResult>(`/businesses/${businessId}/employees/import`, form);
      setResult(res);
      if (res.created > 0) onImported();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Не удалось загрузить файл");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <dialog
      id="modal"
      ref={ref}
      onClose={handleClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="modal-head">
        <h3>Массовый импорт сотрудников из CSV</h3>
        <button type="button" className="icon-btn" onClick={handleClose}>
          <IconClose />
        </button>
      </div>
      <div className="modal-body">
        {!result && (
          <>
            <div className="field-hint" style={{ marginBottom: "10px" }}>
              Файл CSV с заголовком в первой строке. Обязательные колонки: <code>email</code>, <code>name</code>,{" "}
              <code>temporary_password</code> (минимум 12 символов, тот же тест сложности пароля, что и при
              приглашении вручную). Необязательно — <code>position</code> (точное название уже существующей
              должности; неизвестное название не создаст новую, а пометит строку ошибкой). Каждый успешно
              импортированный сотрудник получает статус «приглашён», как и при обычном приглашении — станет
              «активным» после своего первого входа.
            </div>
            <button type="button" className="btn btn-sm" onClick={downloadEmployeeImportTemplate}>
              Скачать шаблон CSV
            </button>
            <div className="field" style={{ marginTop: "14px" }}>
              <label>Файл</label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
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
                          <span style={{ color: "var(--good-ink)", fontWeight: 600 }}>Приглашён</span>
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
            <button type="button" className="btn btn-primary" disabled={!file || submitting} onClick={() => void handleImport()}>
              {submitting ? "Импортируем…" : "Импортировать"}
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}
