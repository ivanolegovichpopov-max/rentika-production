/**
 * Минимальный ручной CSV-парсер/сериализатор — без внешней npm-зависимости
 * (по запросу пользователя в тринадцатом проходе: "как считаешь ты", решено
 * не тащить пакет ради одной фичи импорта). Поддерживает то, что реально
 * нужно для экспорта из Excel/Google Таблиц: запятая-разделитель, кавычки
 * вокруг полей с запятой/переводом строки/самой кавычкой (удвоенная "" —
 * экранированная кавычка внутри поля), \r\n и \n как разделители строк.
 * НЕ поддерживает: другие разделители (;) — если понадобится, придётся
 * добавить автоопределение по первой строке, сейчас не запрошено.
 */

export interface ParsedCsv {
  header: string[];
  rows: string[][];
}

export function parseCsv(text: string): ParsedCsv {
  // Убираем BOM, если Excel его дописал.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  function pushField() {
    row.push(field);
    field = "";
  }
  function pushRow() {
    pushField();
    // Пропускаем полностью пустые строки (частый хвост файла) — но не
    // строку из одного пустого поля посреди данных (row.length может быть 1
    // с полем "" — это осознанно оставляем на валидацию вызывающего кода).
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  }

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue; // \r\n — сам \r просто съедаем, перевод строки обработает \n (или конец файла)
    }
    if (ch === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Последняя строка без завершающего перевода строки.
  if (field !== "" || row.length > 0) pushRow();

  const [header, ...dataRows] = rows;
  return { header: header ?? [], rows: dataRows };
}

/** Превращает список объектов-строк в CSV-текст (для шаблона импорта и
 * возможного экспорта позже) — поле в кавычках только если это реально
 * нужно (содержит запятую/кавычку/перевод строки), как это обычно делает
 * Excel при сохранении. */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  function escapeField(value: string | number | null | undefined): string {
    const s = value == null ? "" : String(value);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  const lines = [header.map(escapeField).join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeField).join(","));
  }
  return lines.join("\r\n");
}

/** Строки CSV → объекты по заголовку (регистронезависимо, обрезая пробелы у
 * имён колонок) — то, что реально нужно форме предпросмотра импорта. */
export function csvRowsToObjects(parsed: ParsedCsv): Record<string, string>[] {
  const keys = parsed.header.map((h) => h.trim().toLowerCase());
  return parsed.rows.map((row) => {
    const obj: Record<string, string> = {};
    keys.forEach((key, idx) => {
      if (key) obj[key] = (row[idx] ?? "").trim();
    });
    return obj;
  });
}
