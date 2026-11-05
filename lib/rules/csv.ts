import { normalizeName } from "./clients";

/** Minimal RFC-4180 parser: quoted fields, escaped quotes, CRLF/LF, embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/** `line` is the row number among non-blank rows (header = 1). */
export type ClientImportPreview = {
  valid: { name: string; line: number }[];
  errors: { line: number; message: string }[];
};

/** Validate before commit: header required, names present, no duplicates in the file or against existing clients. Safe to re-run: existing names are skipped, not duplicated. */
export function previewClientImport(text: string, existingNames: string[]): ClientImportPreview {
  const rows = parseCsv(text);
  const out: ClientImportPreview = { valid: [], errors: [] };
  const header = rows[0]?.map((h) => h.trim().toLowerCase());
  const col = header?.indexOf("name") ?? -1;
  if (col < 0) return { valid: [], errors: [{ line: 1, message: 'Header row must include a "name" column' }] };
  const seen = new Set(existingNames.map(normalizeName));
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const name = (r[col] ?? "").trim();
    if (!name) return void out.errors.push({ line, message: "Name is empty" });
    if (name.length > 200) return void out.errors.push({ line, message: "Name is longer than 200 characters" });
    const n = normalizeName(name);
    if (seen.has(n)) return void out.errors.push({ line, message: `Duplicate: "${name}" already exists or appears earlier in the file` });
    seen.add(n);
    out.valid.push({ name, line });
  });
  return out;
}

/** CSV export with formula-injection protection for spreadsheet apps. */
export function toCsv(rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    let s = v === null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s) && typeof v === "string") s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
