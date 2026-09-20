import {
  type CollectionCsvRow,
  collectionCsvRowSchema,
  formatCentsAsAmount,
  validateCollectionCsvHeader,
} from '@gth/core';
import {
  type CsvDocument,
  CsvFormatError,
  CsvLimitError,
  mapCsvRows,
  parseCsv,
  toCsv,
} from '@gth/security';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { cardVariants, cards, sets } from '../schema/catalog.js';
import { collectionItems, collections } from '../schema/collections.js';
import type { CardCondition } from './pricing.js';
import { asUser } from './watches.js';

export type Collection = typeof collections.$inferSelect;
export type CollectionItem = typeof collectionItems.$inferSelect;
export type CollectionVisibility = (typeof collections.$inferSelect)['visibility'];

/** Per-user cap. A collection is a list, not a database (FR-3.4). */
export const MAX_COLLECTIONS_PER_USER = 25;

export class CollectionLimitError extends Error {
  constructor() {
    super(`collection limit reached (${String(MAX_COLLECTIONS_PER_USER)})`);
    this.name = 'CollectionLimitError';
  }
}

export class CollectionNotFoundError extends Error {
  constructor() {
    super('collection not found');
    this.name = 'CollectionNotFoundError';
  }
}

/**
 * Run `fn` with the *viewer* declared to Postgres, where the viewer may be nobody.
 *
 * An anonymous read still runs inside a transaction that sets `app.user_id` explicitly, to
 * the empty string. Leaving it unset would work today -- `set_local` is transaction-scoped,
 * so there is nothing to inherit -- but "works because of how the pool happens to behave" is
 * not a sentence worth betting a private collection on. Setting it empty makes the anonymous
 * case a stated fact rather than an absence.
 */
export async function asViewer<T>(
  db: Database,
  viewerId: string | null,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return asUser(db, viewerId ?? '', fn);
}

// --------------------------------------------------------------------------- //
// Collections
// --------------------------------------------------------------------------- //

export async function createCollection(
  db: Database,
  ownerId: string,
  input: { name: string; visibility?: CollectionVisibility | undefined },
): Promise<Collection> {
  return asUser(db, ownerId, async (tx) => {
    const existing = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from app.collections where owner_id = ${ownerId}`,
    );
    if ((existing[0]?.n ?? 0) >= MAX_COLLECTIONS_PER_USER) throw new CollectionLimitError();

    const [created] = await tx
      .insert(collections)
      // ownerId comes from the session, never from the request body.
      .values({ ownerId, name: input.name.trim(), visibility: input.visibility ?? 'private' })
      .returning();
    if (!created) throw new Error('collection insert returned no row');
    return created;
  });
}

export async function listCollections(db: Database, ownerId: string): Promise<Collection[]> {
  return asUser(db, ownerId, (tx) =>
    tx
      .select()
      .from(collections)
      .where(eq(collections.ownerId, ownerId))
      .orderBy(desc(collections.updatedAt)),
  );
}

/**
 * Collections anyone may browse.
 *
 * Note the explicit `visibility = 'public'`: row-level security lets an *unlisted* row
 * through too, because it cannot know whether the caller already had the id. Being missing
 * from this list is the whole difference between unlisted and public, so it is enforced
 * here, in the query, and tested there.
 */
export async function listPublicCollections(db: Database, limit = 50): Promise<Collection[]> {
  return asViewer(db, null, (tx) =>
    tx
      .select()
      .from(collections)
      .where(eq(collections.visibility, 'public'))
      .orderBy(desc(collections.updatedAt))
      .limit(limit),
  );
}

/** One collection, if this viewer is allowed it. Returns null rather than throwing on 404. */
export async function getCollection(
  db: Database,
  viewerId: string | null,
  id: string,
): Promise<Collection | null> {
  return asViewer(db, viewerId, async (tx) => {
    const [row] = await tx.select().from(collections).where(eq(collections.id, id)).limit(1);
    return row ?? null;
  });
}

export async function updateCollection(
  db: Database,
  ownerId: string,
  id: string,
  patch: { name?: string | undefined; visibility?: CollectionVisibility | undefined },
): Promise<Collection | null> {
  return asUser(db, ownerId, async (tx) => {
    const [row] = await tx
      .update(collections)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
        ...(patch.visibility === undefined ? {} : { visibility: patch.visibility }),
        updatedAt: new Date(),
      })
      .where(and(eq(collections.id, id), eq(collections.ownerId, ownerId)))
      .returning();
    return row ?? null;
  });
}

export async function deleteCollection(
  db: Database,
  ownerId: string,
  id: string,
): Promise<boolean> {
  return asUser(db, ownerId, async (tx) => {
    const deleted = await tx
      .delete(collections)
      .where(and(eq(collections.id, id), eq(collections.ownerId, ownerId)))
      .returning({ id: collections.id });
    return deleted.length > 0;
  });
}

// --------------------------------------------------------------------------- //
// Items
// --------------------------------------------------------------------------- //

export interface CollectionItemInput {
  cardVariantId: string;
  condition?: CardCondition | undefined;
  quantity?: number | undefined;
  /** Per card, not per line. */
  acquiredPriceCents?: number | undefined;
  currency?: string | undefined;
  acquiredAt?: Date | undefined;
  notes?: string | undefined;
}

/**
 * Add cards to a collection (FR-3.4).
 *
 * Adding a card already on the line increases the quantity rather than failing, which is
 * what "add" means to a person holding a second copy. The cost basis of the merged line is
 * the quantity-weighted average of the two, because that is what the lot actually cost.
 *
 * If either side has no known cost, the merged line has no known cost: an average that
 * treats an unknown as zero is not an average, it is an understatement that compounds every
 * time the line grows.
 */
export async function addItem(
  db: Database,
  ownerId: string,
  collectionId: string,
  input: CollectionItemInput,
): Promise<CollectionItem> {
  return asUser(db, ownerId, async (tx) => {
    const item = await upsertItem(tx, collectionId, input, 'add');
    await touchCollection(tx, collectionId);
    return item;
  });
}

async function upsertItem(
  tx: Database,
  collectionId: string,
  input: CollectionItemInput,
  mode: 'add' | 'replace',
): Promise<CollectionItem> {
  const condition = input.condition ?? 'nm';
  const quantity = input.quantity ?? 1;
  const currency = input.currency ?? 'USD';

  const [existing] = await tx
    .select()
    .from(collectionItems)
    .where(
      and(
        eq(collectionItems.collectionId, collectionId),
        eq(collectionItems.cardVariantId, input.cardVariantId),
        eq(collectionItems.condition, condition),
      ),
    )
    .limit(1);

  if (!existing || mode === 'replace') {
    const values = {
      collectionId,
      cardVariantId: input.cardVariantId,
      condition,
      quantity,
      acquiredPriceCents: input.acquiredPriceCents ?? null,
      currency,
      acquiredAt: input.acquiredAt ?? null,
      notes: input.notes ?? null,
    };
    const [row] = existing
      ? await tx
          .update(collectionItems)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(collectionItems.id, existing.id))
          .returning()
      : await tx.insert(collectionItems).values(values).returning();
    if (!row) throw new Error('collection item write returned no row');
    return row;
  }

  if (existing.currency !== currency) {
    throw new Error(
      `line is recorded in ${existing.currency}; cannot add a ${currency} purchase to it`,
    );
  }

  const mergedQuantity = existing.quantity + quantity;
  const mergedPrice = weightedAverageCents(
    { quantity: existing.quantity, unitCents: existing.acquiredPriceCents },
    { quantity, unitCents: input.acquiredPriceCents ?? null },
  );

  const [row] = await tx
    .update(collectionItems)
    .set({
      quantity: mergedQuantity,
      acquiredPriceCents: mergedPrice,
      // A note on the incoming rows replaces nothing: the existing note was written by the
      // same person about the same cards, and losing it silently would be rude.
      notes: existing.notes ?? input.notes ?? null,
      updatedAt: new Date(),
    })
    .where(eq(collectionItems.id, existing.id))
    .returning();
  if (!row) throw new Error('collection item merge returned no row');
  return row;
}

/** Quantity-weighted unit cost, or null when either side's cost is unknown. */
export function weightedAverageCents(
  a: { quantity: number; unitCents: number | null },
  b: { quantity: number; unitCents: number | null },
): number | null {
  if (a.unitCents === null || b.unitCents === null) return null;
  const total = a.quantity * a.unitCents + b.quantity * b.unitCents;
  return Math.round(total / (a.quantity + b.quantity));
}

export async function updateItem(
  db: Database,
  ownerId: string,
  itemId: string,
  patch: {
    quantity?: number;
    acquiredPriceCents?: number | null;
    acquiredAt?: Date | null;
    notes?: string | null;
  },
): Promise<CollectionItem | null> {
  return asUser(db, ownerId, async (tx) => {
    const [row] = await tx
      .update(collectionItems)
      .set({
        ...(patch.quantity === undefined ? {} : { quantity: patch.quantity }),
        ...(patch.acquiredPriceCents === undefined
          ? {}
          : { acquiredPriceCents: patch.acquiredPriceCents }),
        ...(patch.acquiredAt === undefined ? {} : { acquiredAt: patch.acquiredAt }),
        ...(patch.notes === undefined ? {} : { notes: patch.notes }),
        updatedAt: new Date(),
      })
      .where(eq(collectionItems.id, itemId))
      .returning();
    if (row) await touchCollection(tx, row.collectionId);
    return row ?? null;
  });
}

export async function removeItem(db: Database, ownerId: string, itemId: string): Promise<boolean> {
  return asUser(db, ownerId, async (tx) => {
    const deleted = await tx
      .delete(collectionItems)
      .where(eq(collectionItems.id, itemId))
      .returning({ collectionId: collectionItems.collectionId });
    const first = deleted.at(0);
    if (first) await touchCollection(tx, first.collectionId);
    return deleted.length > 0;
  });
}

async function touchCollection(tx: Database, collectionId: string): Promise<void> {
  await tx
    .update(collections)
    .set({ updatedAt: new Date() })
    .where(eq(collections.id, collectionId));
}

export interface CollectionItemView {
  id: string;
  cardVariantId: string;
  setCode: string;
  cardNumber: string;
  cardName: string;
  finish: string;
  language: string;
  condition: CardCondition;
  quantity: number;
  acquiredPriceCents: number | null;
  currency: string;
  acquiredAt: Date | null;
  notes: string | null;
}

/**
 * The items of a collection, with enough card detail to display or export them.
 *
 * **What a viewer who is not the owner does not get:** what was paid, when it was bought, and
 * the owner's notes. Row-level security decides which *rows* a shared collection hands out;
 * it cannot mask a column, and a public collection was never meant to publish someone's
 * purchase history alongside their card list. So the columns are nulled in SQL, for the
 * owner check to live next to the data rather than in whichever route remembered to strip it.
 */
export async function listItems(
  db: Database,
  viewerId: string | null,
  collectionId: string,
): Promise<CollectionItemView[]> {
  return asViewer(db, viewerId, async (tx) => {
    const rows = await tx.execute<{
      id: string;
      card_variant_id: string;
      set_code: string;
      card_number: string;
      card_name: string;
      finish: string;
      language: string;
      condition: CardCondition;
      quantity: number;
      acquired_price_cents: number | null;
      currency: string;
      acquired_at: Date | null;
      notes: string | null;
    }>(sql`
      select i.id,
             i.card_variant_id,
             s.code as set_code,
             c.number as card_number,
             c.name as card_name,
             v.finish::text as finish,
             v.language::text as language,
             i.condition,
             i.quantity,
             case when col.owner_id = current_setting('app.user_id', true)
                  then i.acquired_price_cents end as acquired_price_cents,
             i.currency,
             case when col.owner_id = current_setting('app.user_id', true)
                  then i.acquired_at end as acquired_at,
             case when col.owner_id = current_setting('app.user_id', true)
                  then i.notes end as notes
        from app.collection_items i
        join app.collections col on col.id = i.collection_id
        join app.card_variants v on v.id = i.card_variant_id
        join app.cards c on c.id = v.card_id
        join app.sets s on s.id = c.set_id
       where i.collection_id = ${collectionId}
       order by s.code, c.number, i.condition
    `);

    return rows.map((r) => ({
      id: r.id,
      cardVariantId: r.card_variant_id,
      setCode: r.set_code,
      cardNumber: r.card_number,
      cardName: r.card_name,
      finish: r.finish,
      language: r.language,
      condition: r.condition,
      quantity: r.quantity,
      acquiredPriceCents: r.acquired_price_cents,
      currency: r.currency,
      acquiredAt: r.acquired_at,
      notes: r.notes,
    }));
  });
}

// --------------------------------------------------------------------------- //
// Valuation
// --------------------------------------------------------------------------- //

export interface CollectionValuation {
  currency: string;
  /** Lines and cards, which are different numbers and are asked about differently. */
  lines: number;
  cards: number;
  /** Cards covered by a published price, and what they are worth. */
  valuedCards: number;
  currentValueCents: number;
  /**
   * Gain or loss over the **comparable** subset only: the cards that have both a current
   * price and a known cost. Anything else would be subtracting one set of cards from another.
   */
  costBasisCents: number;
  comparableValueCents: number;
  gainLossCents: number;
  /** Lines we could not value, and why. Reported, never rounded away. */
  unpricedLines: number;
  unpricedCards: number;
  otherCurrencyLines: number;
  /** The oldest index day used, so the UI can say how fresh this is. */
  oldestPriceDay: string | null;
}

/**
 * Value a collection against the published index (FR-3.4).
 *
 * Three honesty rules, each of which the obvious implementation gets wrong:
 *
 *  1. **A card with no published price is not worth zero.** It is counted in `unpriced` and
 *     kept out of the total, so the headline number never quietly absorbs the cards the
 *     index cannot speak for.
 *  2. **A stale price is not a current price.** Only index rows inside `maxAgeDays` count; an
 *     eight-month-old median is a memory, not a valuation.
 *  3. **Gain and loss are computed over the cards that have both sides.** Comparing a total
 *     value that includes unpriced cards against a cost basis that excludes them produces a
 *     number that is wrong in a direction nobody can predict.
 */
export async function valueCollection(
  db: Database,
  viewerId: string | null,
  collectionId: string,
  options: { currency?: string | undefined; maxAgeDays?: number | undefined } = {},
): Promise<CollectionValuation> {
  const currency = options.currency ?? 'USD';
  const maxAgeDays = options.maxAgeDays ?? 30;

  return asViewer(db, viewerId, async (tx) => {
    const rows = await tx.execute<{
      quantity: number;
      acquired_price_cents: number | null;
      currency: string;
      median_cents: number | null;
      day: string | null;
    }>(sql`
      select i.quantity,
             -- Same rule as listItems: a visitor to a shared collection sees what it is
             -- worth, never what it cost. With this null, every line falls out of the
             -- comparable subset and the gain/loss reported to a stranger is nothing --
             -- which is the correct answer to a question that was not theirs to ask.
             case when col.owner_id = current_setting('app.user_id', true)
                  then i.acquired_price_cents end as acquired_price_cents,
             i.currency,
             p.median_cents,
             p.day::text as day
        from app.collection_items i
        join app.collections col on col.id = i.collection_id
        -- LATERAL, so "latest price" is decided per item rather than by a join that would
        -- multiply each item by its whole price history.
        left join lateral (
          select d.median_cents, d.day
            from app.price_index_daily d
           where d.card_variant_id = i.card_variant_id
             and d.condition = i.condition
             and d.currency = i.currency
             and d.day >= current_date - make_interval(days => ${Math.trunc(maxAgeDays)})
           order by d.day desc
           limit 1
        ) p on true
       where i.collection_id = ${collectionId}
    `);

    const valuation: CollectionValuation = {
      currency,
      lines: rows.length,
      cards: 0,
      valuedCards: 0,
      currentValueCents: 0,
      costBasisCents: 0,
      comparableValueCents: 0,
      gainLossCents: 0,
      unpricedLines: 0,
      unpricedCards: 0,
      otherCurrencyLines: 0,
      oldestPriceDay: null,
    };

    for (const row of rows) {
      valuation.cards += row.quantity;

      // A line in another currency is not converted. We do not hold exchange rates, and
      // inventing one would put a made-up number inside a number people trust.
      if (row.currency !== currency) {
        valuation.otherCurrencyLines += 1;
        continue;
      }

      if (row.median_cents === null) {
        valuation.unpricedLines += 1;
        valuation.unpricedCards += row.quantity;
        continue;
      }

      const lineValue = row.median_cents * row.quantity;
      valuation.valuedCards += row.quantity;
      valuation.currentValueCents += lineValue;
      if (
        row.day !== null &&
        (valuation.oldestPriceDay === null || row.day < valuation.oldestPriceDay)
      ) {
        valuation.oldestPriceDay = row.day;
      }

      if (row.acquired_price_cents !== null) {
        valuation.costBasisCents += row.acquired_price_cents * row.quantity;
        valuation.comparableValueCents += lineValue;
      }
    }

    valuation.gainLossCents = valuation.comparableValueCents - valuation.costBasisCents;
    return valuation;
  });
}

// --------------------------------------------------------------------------- //
// CSV (FR-3.5)
// --------------------------------------------------------------------------- //

export const COLLECTION_CSV_HEADER = [
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

/** Export a collection as CSV. Every cell goes through the formula guard (SR-2.5). */
export async function exportCollectionCsv(
  db: Database,
  viewerId: string | null,
  collectionId: string,
): Promise<string> {
  const items = await listItems(db, viewerId, collectionId);
  return toCsv(
    COLLECTION_CSV_HEADER,
    items.map((i) => [
      i.setCode,
      i.cardNumber,
      i.finish,
      i.language,
      i.condition,
      i.quantity,
      i.acquiredPriceCents === null ? '' : formatCentsAsAmount(i.acquiredPriceCents),
      i.currency,
      i.acquiredAt === null ? '' : i.acquiredAt.toISOString().slice(0, 10),
      i.notes ?? '',
    ]),
  );
}

export interface ImportError {
  row: number;
  message: string;
}

export interface ImportReport {
  /** True when nothing was written, whatever the outcome. */
  dryRun: boolean;
  rows: number;
  /** Rows that passed validation and resolved to a real card. */
  valid: number;
  created: number;
  updated: number;
  cardsAdded: number;
  errors: ImportError[];
}

interface ResolvedRow {
  row: number;
  cardVariantId: string;
  parsed: CollectionCsvRow;
}

/**
 * Import a CSV into a collection (FR-3.5, SR-3.4, AC-3.5).
 *
 * **Deviation from the plan, recorded on purpose:** §12 says parsing runs in a worker. There
 * is no worker service yet -- Phase 1's jobs run in the scanner process -- so this runs in
 * the request. What the worker was *for* is bounded work, and that is enforced here instead:
 * the parser rejects a file over 2 MB or 5,000 rows before it does any work at all, and the
 * route caps the body independently. When `apps/worker` exists this function moves behind a
 * job unchanged, because it takes text and returns a report.
 *
 * `dryRun` is the default. An import that rewrites someone's collection should have been
 * previewed first, and making the safe path the one you get by forgetting is the only way
 * that actually happens.
 */
export async function importCollectionCsv(
  db: Database,
  ownerId: string,
  collectionId: string,
  text: string,
  options: { dryRun?: boolean; mode?: 'add' | 'replace' } = {},
): Promise<ImportReport> {
  const dryRun = options.dryRun ?? true;
  const mode = options.mode ?? 'add';
  const report: ImportReport = {
    dryRun,
    rows: 0,
    valid: 0,
    created: 0,
    updated: 0,
    cardsAdded: 0,
    errors: [],
  };

  let parsedCsv: CsvDocument;
  try {
    parsedCsv = parseCsv(text);
  } catch (error) {
    if (error instanceof CsvLimitError || error instanceof CsvFormatError) {
      report.errors.push({ row: 0, message: error.message });
      return report;
    }
    throw error;
  }

  const headerProblems = validateCollectionCsvHeader(parsedCsv.header);
  if (headerProblems.length > 0) {
    // Row 0 means "the file itself", not a line in it. A bad header is one mistake, and
    // reporting it five thousand times would bury it.
    report.errors.push(...headerProblems.map((message) => ({ row: 0, message })));
    return report;
  }

  const { records, rowNumbers, errors } = mapCsvRows({
    header: parsedCsv.header.map((h) => h.toLowerCase()),
    rows: parsedCsv.rows,
  });
  report.rows = parsedCsv.rows.length;
  report.errors.push(...errors);

  const parsedRows: { row: number; parsed: CollectionCsvRow }[] = [];
  records.forEach((record, index) => {
    // rowNumbers is parallel to records, so this is the line in the file the person is
    // looking at -- not the index into the rows that happened to survive mapping.
    const rowNumber = rowNumbers.at(index) ?? index + 2;
    const result = collectionCsvRowSchema.safeParse(record);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const column = issue.path.at(0);
        const where = typeof column === 'string' ? `${column}: ` : '';
        report.errors.push({ row: rowNumber, message: `${where}${issue.message}` });
      }
      return;
    }
    parsedRows.push({ row: rowNumber, parsed: result.data });
  });

  if (parsedRows.length === 0) return report;

  const variants = await lookupVariants(
    db,
    parsedRows.map((r) => r.parsed),
  );

  const resolved: ResolvedRow[] = [];
  const seen = new Map<string, number>();
  for (const { row, parsed } of parsedRows) {
    const key = variantKey(parsed.set, parsed.number, parsed.finish, parsed.language);
    const cardVariantId = variants.get(key);
    if (cardVariantId === undefined) {
      report.errors.push({
        row,
        message: `no card ${parsed.number} in set ${parsed.set} with that finish and language`,
      });
      continue;
    }
    // A file that says two different things about one line is a file we refuse to guess at.
    const lineKey = `${cardVariantId}\u0000${parsed.condition ?? 'nm'}`;
    const firstSeen = seen.get(lineKey);
    if (firstSeen !== undefined) {
      report.errors.push({ row, message: `duplicates row ${String(firstSeen)}` });
      continue;
    }
    seen.set(lineKey, row);
    resolved.push({ row, cardVariantId, parsed });
  }

  report.valid = resolved.length;
  if (dryRun || resolved.length === 0) return report;

  // One transaction for the whole file: a half-applied import is worse than a rejected one,
  // because nobody can tell which half.
  await asUser(db, ownerId, async (tx) => {
    for (const { cardVariantId, parsed } of resolved) {
      const existing = await tx
        .select({ id: collectionItems.id })
        .from(collectionItems)
        .where(
          and(
            eq(collectionItems.collectionId, collectionId),
            eq(collectionItems.cardVariantId, cardVariantId),
            eq(collectionItems.condition, parsed.condition ?? 'nm'),
          ),
        )
        .limit(1);

      await upsertItem(
        tx,
        collectionId,
        {
          cardVariantId,
          condition: parsed.condition ?? 'nm',
          quantity: parsed.quantity,
          acquiredPriceCents: parsed.acquired_price,
          currency: parsed.currency ?? 'USD',
          acquiredAt: parsed.acquired_at,
          notes: parsed.notes,
        },
        mode,
      );

      if (existing.length > 0) report.updated += 1;
      else report.created += 1;
      report.cardsAdded += parsed.quantity;
    }
    await touchCollection(tx, collectionId);
  });

  return report;
}

function variantKey(
  setCode: string,
  number: string,
  finish: string | undefined,
  language: string | undefined,
): string {
  return [
    setCode.trim().toLowerCase(),
    number.trim().toLowerCase(),
    finish ?? 'normal',
    language ?? 'en',
  ].join('\u0000');
}

/**
 * Resolve every card in the file with one query.
 *
 * Keyed on the set codes the file mentions rather than on 5,000 tuples: an import is almost
 * always a handful of sets, so this reads a few thousand rows once instead of issuing a
 * query per line.
 */
async function lookupVariants(
  db: Database,
  rows: readonly CollectionCsvRow[],
): Promise<Map<string, string>> {
  const setCodes = [...new Set(rows.map((r) => r.set.trim().toLowerCase()))];
  const found = await db
    .select({
      setCode: sql<string>`lower(${sets.code})`,
      number: sql<string>`lower(${cards.number})`,
      finish: sql<string>`${cardVariants.finish}::text`,
      language: sql<string>`${cardVariants.language}::text`,
      id: cardVariants.id,
    })
    .from(cardVariants)
    .innerJoin(cards, eq(cards.id, cardVariants.cardId))
    .innerJoin(sets, eq(sets.id, cards.setId))
    .where(inArray(sql<string>`lower(${sets.code})`, setCodes));

  const map = new Map<string, string>();
  for (const row of found) {
    map.set(variantKey(row.setCode, row.number, row.finish, row.language), row.id);
  }
  return map;
}

/** How many lines a collection holds, subject to whatever this viewer may see. */
export async function collectionItemCount(
  db: Database,
  viewerId: string | null,
  collectionId: string,
): Promise<number> {
  return asViewer(db, viewerId, async (tx) => {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(collectionItems)
      .where(eq(collectionItems.collectionId, collectionId));
    return row?.n ?? 0;
  });
}
