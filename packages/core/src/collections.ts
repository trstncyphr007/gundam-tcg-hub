/**
 * The collection CSV contract (FR-3.5, SR-3.4).
 *
 * A collection import is one of the few places a user hands us a file, so the rules about
 * what a row may contain live here, in one place, shared by the importer and the API.
 *
 * Two decisions worth stating, because both could have gone the lazy way:
 *
 *  - **A card is named the way it is printed**, by set code and number, not by a database id.
 *    Asking someone to paste UUIDs into a spreadsheet is asking them not to bother.
 *  - **Money in the file is written the way people write it** ("12.50"), and converted to
 *    integer cents here, without ever becoming a float. `12.50 * 100` is `1250.0000000000002`
 *    in IEEE 754, and a cost basis that is off by a hundredth of a cent is a cost basis that
 *    will not reconcile against a receipt.
 */

import { z } from 'zod';

/** Columns the importer understands. Anything else is an error, not a shrug (SR-X.10). */
export const COLLECTION_CSV_COLUMNS = [
  'set',
  'number',
  'finish',
  'language',
  'condition',
  'quantity',
  'acquired_price',
  'currency',
  'acquired_at',
  'notes',
] as const;

/** Without these three a row does not describe anything we could store. */
export const COLLECTION_CSV_REQUIRED_COLUMNS = ['set', 'number', 'quantity'] as const;

export const CARD_CONDITIONS = ['nm', 'lp', 'mp', 'hp', 'dmg'] as const;
export const CARD_FINISHES = ['normal', 'parallel', 'alt_art', 'promo'] as const;
export const CARD_LANGUAGES = ['en', 'ja'] as const;

/**
 * Convert a written amount to integer cents.
 *
 * Returns null rather than throwing, so the caller can report *which row* was wrong. Accepts
 * an optional currency symbol, thousands separators and up to two decimal places, because
 * that is what spreadsheets export; rejects anything else rather than guessing at it.
 */
export function parseMoneyToCents(input: string): number | null {
  const cleaned = input
    .trim()
    .replace(/^[$£€¥]/u, '')
    .replaceAll(',', '');

  // Split on the point and test each half separately, rather than one regex with optional
  // groups: two bounded patterns are easier to read and cannot be argued about.
  const parts = cleaned.split('.');
  if (parts.length > 2) return null;
  const [whole = '', fraction] = parts;
  if (!/^\d{1,9}$/u.test(whole)) return null;
  // "12." is not an amount. An empty fraction after a point is a typo, not zero cents.
  if (fraction !== undefined && !/^\d{1,2}$/u.test(fraction)) return null;

  // Pad so "1.5" is 50 cents, not 5. String work throughout: no float ever holds this value.
  const cents = (fraction ?? '').padEnd(2, '0');
  return Number.parseInt(whole, 10) * 100 + Number.parseInt(cents, 10);
}

/** Render integer cents the way the export should show them. */
export function formatCentsAsAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${String(Math.trunc(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * An empty cell means "not given", which is different from a bad value -- and different
 * again from zero. The column may also be absent from the file entirely, which is why this
 * accepts `undefined` as well as `""`: only `set`, `number` and `quantity` are required.
 */
const optionalText = z
  .string()
  .optional()
  .transform((v) => {
    const trimmed = (v ?? '').trim();
    return trimmed === '' ? undefined : trimmed;
  });

// strictObject, not object(): unknown columns are rejected rather than ignored. A mistyped
// "qty" column silently importing every card as quantity 1 is worse than being told the
// header is wrong.
export const collectionCsvRowSchema = z.strictObject({
  set: z.string().trim().min(1, 'set code is required').max(32),
  number: z.string().trim().min(1, 'card number is required').max(32),
  finish: optionalText.pipe(z.enum(CARD_FINISHES).optional()),
  language: optionalText.pipe(z.enum(CARD_LANGUAGES).optional()),
  condition: optionalText.pipe(z.enum(CARD_CONDITIONS).optional()),
  quantity: z
    .string()
    .trim()
    .regex(/^\d{1,6}$/u, 'quantity must be a whole number')
    .transform((v) => Number.parseInt(v, 10))
    .refine((v) => v >= 1, 'quantity must be at least 1')
    .refine((v) => v <= 100000, 'quantity is implausibly large'),
  acquired_price: optionalText
    .refine((v) => v === undefined || parseMoneyToCents(v) !== null, 'price is not an amount')
    .transform((v) => (v === undefined ? undefined : (parseMoneyToCents(v) ?? 0))),
  currency: optionalText.pipe(
    z
      .string()
      .regex(/^[A-Za-z]{3}$/u, 'currency must be a 3-letter code')
      .transform((v) => v.toUpperCase())
      .optional(),
  ),
  acquired_at: optionalText.pipe(
    z.iso
      .date()
      .transform((v) => new Date(`${v}T00:00:00.000Z`))
      .optional(),
  ),
  // Kept as written. A cell beginning `=` is text here and text on the way out; the export
  // side is what makes it inert in a spreadsheet, and doing it twice would double-escape.
  notes: optionalText.pipe(z.string().max(500, 'notes are longer than 500 characters').optional()),
});

export type CollectionCsvRow = z.infer<typeof collectionCsvRowSchema>;

/**
 * Check the header before reading a single row.
 *
 * A wrong header is one mistake affecting every row, so it deserves one message rather than
 * five thousand identical ones.
 */
export function validateCollectionCsvHeader(header: readonly string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const known = new Set<string>(COLLECTION_CSV_COLUMNS);

  for (const name of header) {
    const column = name.trim().toLowerCase();
    if (!known.has(column)) problems.push(`unknown column "${name}"`);
    else if (seen.has(column)) problems.push(`duplicate column "${column}"`);
    seen.add(column);
  }
  for (const required of COLLECTION_CSV_REQUIRED_COLUMNS) {
    if (!seen.has(required)) problems.push(`missing required column "${required}"`);
  }
  return problems;
}
