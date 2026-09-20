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

// --------------------------------------------------------------------------- //
// Reading
// --------------------------------------------------------------------------- //

export class CsvLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvLimitError';
  }
}

export class CsvFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvFormatError';
  }
}

export interface CsvDocument {
  header: string[];
  rows: string[][];
}

export interface ParseCsvOptions {
  /** Hard row cap, excluding the header (SR-3.4). */
  maxRows?: number;
  /** Hard byte cap on the whole document. */
  maxBytes?: number;
}

/**
 * Parse RFC 4180 CSV.
 *
 * Written rather than pulled in, for two reasons: the writing half already lives here, so
 * reader and writer stay in step; and a parser is exactly the kind of small, total function
 * that is cheaper to own and test than to audit as a dependency.
 *
 * Caps are enforced **before** the work, not after, so an oversized file costs nothing.
 * Nothing here evaluates anything: a cell beginning `=` is text, and stays text.
 */
export function parseCsv(text: string, options: ParseCsvOptions = {}): CsvDocument {
  const maxRows = options.maxRows ?? 5000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;

  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) {
    throw new CsvLimitError(`file is ${String(bytes)} bytes; the limit is ${String(maxBytes)}`);
  }

  // A byte-order mark would otherwise become part of the first column's name, and the
  // mapping would fail in a way nobody can see by looking at the file.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawAnyChar = false;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    // Skip a row that is entirely empty, which is what a trailing newline produces.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    if (rows.length > maxRows + 1) {
      throw new CsvLimitError(`more than ${String(maxRows)} rows`);
    }
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input.charAt(i);
    sawAnyChar = true;

    if (inQuotes) {
      if (char === '"') {
        if (input.charAt(i + 1) === '"') {
          field += '"'; // an escaped quote
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      if (field.length > 0) {
        throw new CsvFormatError(
          `unexpected quote in the middle of a field on row ${String(rows.length + 1)}`,
        );
      }
      inQuotes = true;
    } else if (char === ',') {
      endField();
    } else if (char === '\n') {
      endRow();
    } else if (char === '\r') {
      // CRLF: the \n does the work. A lone CR also ends the row.
      if (input.charAt(i + 1) === '\n') i += 1;
      endRow();
    } else {
      field += char;
    }
  }

  if (inQuotes) throw new CsvFormatError('the file ends inside a quoted field');
  if (sawAnyChar && (field.length > 0 || row.length > 0)) endRow();

  const header = rows.shift();
  if (!header) throw new CsvFormatError('the file has no header row');
  if (rows.length > maxRows) throw new CsvLimitError(`more than ${String(maxRows)} rows`);

  return { header: header.map((h) => h.trim()), rows };
}

/**
 * Turn rows into objects keyed by header name (FR-3.5, "column mapping").
 *
 * A row with the wrong number of cells is reported rather than padded: silently filling a
 * missing column with an empty string is how a quantity becomes zero without anyone noticing.
 */
export function mapCsvRows(doc: CsvDocument): {
  records: Record<string, string>[];
  /**
   * The file row each record came from, parallel to `records`.
   *
   * Necessary because `records` skips the rows that failed: without this, the caller's
   * `index + 2` would drift by one for every skipped row, and an error message would point
   * at the wrong line -- which is worse than giving no line at all.
   */
  rowNumbers: number[];
  errors: { row: number; message: string }[];
} {
  const records: Record<string, string>[] = [];
  const rowNumbers: number[] = [];
  const errors: { row: number; message: string }[] = [];

  doc.rows.forEach((cells, index) => {
    // +2: one for the header, one because humans count from 1.
    const rowNumber = index + 2;
    if (cells.length !== doc.header.length) {
      errors.push({
        row: rowNumber,
        message: `expected ${String(doc.header.length)} columns, found ${String(cells.length)}`,
      });
      return;
    }
    // fromEntries rather than assigning into an object by key: the key comes from a file
    // someone uploaded, and `record[name] = ...` with an attacker-chosen name is how a cell
    // called "__proto__" stops being a cell.
    records.push(
      Object.fromEntries(doc.header.map((name, column) => [name, (cells.at(column) ?? '').trim()])),
    );
    rowNumbers.push(rowNumber);
  });

  return { records, rowNumbers, errors };
}
