/**
 * CSV export with a formula-injection guard (SR-2.5).
 *
 * A spreadsheet treats a cell beginning `=`, `+`, `-`, `@`, tab or CR as a formula, so an
 * exported file can execute whatever an attacker put in a break title. Excel's DDE
 * (`=cmd|'/c calc'!A1`) has been used to run commands from an opened CSV, and it is the
 * *recipient* who gets hit, not us -- which is why escaping on export is our job.
 */

/** Characters a spreadsheet may read as the start of a formula. */
const FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Neutralise one cell: prefix a leading formula character with an apostrophe, which
 * spreadsheets treat as "this is text", then quote it for CSV.
 *
 * The apostrophe goes *inside* the quotes deliberately: quoting alone does not stop a
 * formula, because the spreadsheet unquotes before deciding what the cell is.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  // Explicit per type: a bare String() on an object yields "[object Object]", which is
  // silently useless in an export someone is relying on.
  const raw =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
        ? value.toString()
        : value instanceof Date
          ? value.toISOString()
          : JSON.stringify(value);
  const first = raw.charAt(0);
  const safe = FORMULA_PREFIXES.has(first) ? `'${raw}` : raw;
  // RFC 4180: double every quote, wrap the lot. Always quote, so a comma, newline or
  // leading space in the data can never shift a column.
  return `"${safe.replaceAll('"', '""')}"`;
}

/** One CSV row from any set of values. */
export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(',');
}

/**
 * A whole CSV document. CRLF line endings per RFC 4180, which is also what Excel expects.
 */
export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [csvRow(header), ...rows.map(csvRow)].join('\r\n');
}
