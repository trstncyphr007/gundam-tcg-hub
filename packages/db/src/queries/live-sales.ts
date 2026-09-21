import {
  BuyerHandleError,
  MAX_LIVE_SALES_PER_DAY,
  BUYER_HANDLE_RETENTION_DAYS,
  isOutlier,
  normaliseBuyerHandle,
} from '@gth/core';
import { type KeyRing, decryptField, encryptField } from '@gth/security';
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { liveSales } from '../schema/live-sales.js';
import { priceObservations } from '../schema/pricing.js';
import type { CardCondition } from './pricing.js';
import { asUser } from './watches.js';

export type LiveSale = typeof liveSales.$inferSelect;

export { BuyerHandleError, MAX_LIVE_SALES_PER_DAY };

/**
 * Timestamps from a raw `execute` are whatever the driver produced — drizzle's column types
 * do not apply to it, so they can arrive as strings. Converting once, here, keeps a string
 * from reaching either an insert (which fails at bind time) or a page (which renders it
 * subtly wrong and says nothing).
 */
function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

export class LiveSaleLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveSaleLimitError';
  }
}

export class LiveSaleStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveSaleStateError';
  }
}

/**
 * How stale a published price may be and still be used to judge a live sale as an outlier.
 *
 * The same window the break calculator and the collection valuation use, for the same
 * reason: flagging tonight's sale against a number from three months ago would generate
 * review work from ordinary price movement.
 */
export const OUTLIER_BASELINE_MAX_AGE_DAYS = 30;

/** How far from the published spread a price has to sit to be held back (SR-4.4). */
export const OUTLIER_IQR_MULTIPLIER = 3;

export interface LogLiveSaleInput {
  cardVariantId?: string | undefined;
  label?: string | undefined;
  condition?: CardCondition | undefined;
  priceCents: number;
  currency?: string | undefined;
  soldAt?: Date | undefined;
  streamRef?: string | undefined;
  /** Optional, and deliberately so: a seller who does not need it should not store a name. */
  buyerHandle?: string | undefined;
}

/**
 * Record one sale as it happens (FR-4.1).
 *
 * Runs as the seller, under the row policies. Note what it does **not** do: write a price
 * observation. Migration 0013 forbids the web role from inserting anything but an unapproved
 * user report, so a session cannot assert "we watched this sale" — the worker does that
 * later, from these rows.
 */
export async function logLiveSale(
  db: Database,
  sellerId: string,
  input: LogLiveSaleInput,
  keyRing: KeyRing | null,
): Promise<LiveSale> {
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
    throw new LiveSaleStateError('a price must be a whole number of cents');
  }
  // Throws BuyerHandleError on a handle that is too long or carries control characters.
  const handle = normaliseBuyerHandle(input.buyerHandle);
  if (handle !== null && !keyRing) {
    // Refusing is the only safe answer: storing it in plaintext would quietly downgrade the
    // protection SR-4.5 asks for, and dropping it silently would lose data the seller needs.
    throw new LiveSaleStateError('buyer handles need field encryption to be configured');
  }

  return asUser(db, sellerId, async (tx) => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // `gte(...)` rather than a raw sql fragment: a Date interpolated into a template is
    // handed to the driver unconverted, which fails at bind time rather than at compile.
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(liveSales)
      .where(and(eq(liveSales.sellerId, sellerId), gte(liveSales.soldAt, since)));
    if (n >= MAX_LIVE_SALES_PER_DAY) {
      throw new LiveSaleLimitError(`daily entry limit reached (${String(MAX_LIVE_SALES_PER_DAY)})`);
    }

    const [row] = await tx
      .insert(liveSales)
      .values({
        sellerId,
        cardVariantId: input.cardVariantId,
        label: input.label,
        condition: input.condition ?? 'nm',
        priceCents: input.priceCents,
        currency: input.currency ?? 'USD',
        soldAt: input.soldAt ?? new Date(),
        streamRef: input.streamRef,
        buyerHandleEncrypted: handle === null ? null : encryptField(keyRing as KeyRing, handle),
        hasBuyerHandle: handle !== null,
      })
      .returning();
    if (!row) throw new Error('live sale insert failed');
    return row;
  });
}

export interface SellerLiveSale {
  id: string;
  cardVariantId: string | null;
  label: string;
  condition: CardCondition;
  priceCents: number;
  currency: string;
  soldAt: Date;
  streamRef: string | null;
  /** Plaintext, and only ever to the seller who typed it. Null once it has been erased. */
  buyerHandle: string | null;
  /** Whether this has reached the index yet, and whether it was held back for review. */
  published: boolean;
  flagged: boolean;
}

/**
 * The seller's own log (FR-4.1).
 *
 * The only place a buyer handle is ever returned. Decryption happens here rather than in the
 * route so that the one function which can produce a plaintext handle is also the one the
 * row policy has already restricted to its owner.
 */
export async function listLiveSales(
  db: Database,
  sellerId: string,
  keyRing: KeyRing | null,
  limit = 100,
): Promise<SellerLiveSale[]> {
  return asUser(db, sellerId, async (tx) => {
    const rows = await tx.execute<{
      id: string;
      card_variant_id: string | null;
      label: string | null;
      condition: CardCondition;
      price_cents: number;
      currency: string;
      sold_at: string | Date;
      stream_ref: string | null;
      buyer_handle_encrypted: string | null;
      price_observation_id: string | null;
      flagged_at: string | Date | null;
      card_name: string | null;
      finish: string | null;
    }>(sql`
      select s.id, s.card_variant_id, s.label, s.condition, s.price_cents, s.currency,
             s.sold_at, s.stream_ref, s.buyer_handle_encrypted, s.price_observation_id,
             o.flagged_at, c.name as card_name, v.finish
        from app.live_sales s
        left join app.price_observations o on o.id = s.price_observation_id
        left join app.card_variants v on v.id = s.card_variant_id
        left join app.cards c on c.id = v.card_id
       where s.seller_id = ${sellerId}
       order by s.sold_at desc
       limit ${Math.min(Math.max(limit, 1), 500)}
    `);

    return rows.map((r) => ({
      id: r.id,
      cardVariantId: r.card_variant_id,
      label: r.card_name
        ? `${r.card_name}${r.finish === 'normal' || r.finish === null ? '' : ` (${r.finish})`}`
        : (r.label ?? 'Unknown card'),
      condition: r.condition,
      priceCents: r.price_cents,
      currency: r.currency,
      soldAt: toDate(r.sold_at),
      streamRef: r.stream_ref,
      buyerHandle:
        r.buyer_handle_encrypted === null || !keyRing
          ? null
          : decryptField(keyRing, r.buyer_handle_encrypted),
      published: r.price_observation_id !== null,
      flagged: r.flagged_at !== null,
    }));
  });
}

/**
 * Remove a mistyped entry, but only before it has reached the index.
 *
 * The policy enforces the same condition, so this returning `false` and the policy refusing
 * the row are the same outcome: a published observation keeps its source.
 */
export async function deleteLiveSale(db: Database, sellerId: string, id: string): Promise<boolean> {
  return asUser(db, sellerId, async (tx) => {
    const rows = await tx
      .delete(liveSales)
      .where(and(eq(liveSales.id, id), eq(liveSales.sellerId, sellerId)))
      .returning({ id: liveSales.id });
    return rows.length > 0;
  });
}

export interface LiveSaleIngestResult {
  ingested: number;
  flagged: number;
  /** Entries that name no catalogued card, so there is nothing to price. */
  unpriceable: number;
}

/**
 * Turn logged sales into price observations (FR-4.1, SR-4.4).
 *
 * Runs on the **worker** role, which is the whole point: a session cannot write a `live_sale`
 * observation, so a seller's claim becomes evidence only after passing through a role no
 * request can reach.
 *
 * Each entry is compared against the currently published spread for that printing before it
 * counts. One that sits more than three interquartile ranges outside is inserted **flagged**,
 * which the rollup excludes — the sale is recorded, it just does not move the index until a
 * human has looked. That is the difference between "we ignore odd prices" and "we notice
 * them": a $900 sale of a $12 card is either a mistyped entry or the most interesting data
 * point of the week, and only a person can tell which.
 *
 * Idempotent through `price_observation_id`, and each row's insert and link share one
 * transaction — otherwise a crash between them would orphan the observation and the entry
 * would be ingested again, which is precisely how a seller could double-weight a sale.
 */
export async function ingestLiveSales(
  db: Database,
  batchSize = 500,
): Promise<LiveSaleIngestResult> {
  const pending = await db.execute<{
    id: string;
    card_variant_id: string | null;
    condition: CardCondition;
    price_cents: number;
    currency: string;
    /**
     * A raw `execute` returns whatever the driver produced; drizzle's column types do not
     * apply to it, so a timestamp can arrive as a string. Typed honestly and converted
     * below, because handing that string back to an insert fails at bind time.
     */
    sold_at: string | Date;
    stream_ref: string | null;
    p25_cents: number | null;
    p75_cents: number | null;
  }>(sql`
    select s.id, s.card_variant_id, s.condition, s.price_cents, s.currency, s.sold_at,
           s.stream_ref,
           -- The most recent published spread for this printing, within the freshness
           -- window. NULL when the index has nothing to say, in which case nothing is
           -- flagged: you cannot call a price an outlier with no baseline to be outside of.
           (select d.p25_cents from app.price_index_daily d
             where d.card_variant_id = s.card_variant_id
               and d.condition = s.condition
               and d.currency = s.currency
               and d.day >= current_date - make_interval(days => ${OUTLIER_BASELINE_MAX_AGE_DAYS})
             order by d.day desc limit 1) as p25_cents,
           (select d.p75_cents from app.price_index_daily d
             where d.card_variant_id = s.card_variant_id
               and d.condition = s.condition
               and d.currency = s.currency
               and d.day >= current_date - make_interval(days => ${OUTLIER_BASELINE_MAX_AGE_DAYS})
             order by d.day desc limit 1) as p75_cents
      from app.live_sales s
     where s.price_observation_id is null
     order by s.sold_at asc
     limit ${batchSize}
  `);

  let ingested = 0;
  let flagged = 0;
  let unpriceable = 0;

  for (const row of pending) {
    // A free-text entry is a real record of a sale and cannot be priced: there is no card to
    // attach it to. Counted and reported rather than retried forever.
    if (row.card_variant_id === null) {
      unpriceable += 1;
      continue;
    }

    const { price_cents: priceCents, p25_cents: p25Cents, p75_cents: p75Cents } = row;
    const isFlagged =
      p25Cents !== null &&
      p75Cents !== null &&
      isOutlier(priceCents, { p25Cents, p75Cents }, OUTLIER_IQR_MULTIPLIER);

    await db
      .transaction(async (tx) => {
        const [observation] = await tx
          .insert(priceObservations)
          .values({
            cardVariantId: row.card_variant_id as string,
            source: 'live_sale',
            saleType: 'sold',
            condition: row.condition,
            priceCents,
            currency: row.currency,
            observedAt: toDate(row.sold_at),
            evidenceRef: row.stream_ref,
            // Our own log, approved on arrival, exactly like a break pull — but held back from
            // the index by the flag when it looks wrong.
            approvedAt: new Date(),
            flaggedAt: isFlagged ? new Date() : null,
          })
          .returning({ id: priceObservations.id });
        if (!observation) throw new Error('live sale observation insert failed');

        const linked = await tx
          .update(liveSales)
          .set({ priceObservationId: observation.id, updatedAt: new Date() })
          .where(and(eq(liveSales.id, row.id), isNull(liveSales.priceObservationId)))
          .returning({ id: liveSales.id });
        // Somebody else linked it first. Roll the whole thing back rather than leave a second
        // observation for the same sale sitting in the index.
        if (linked.length === 0) throw new AlreadyLinked();
      })
      .catch((error: unknown) => {
        if (error instanceof AlreadyLinked) return;
        throw error;
      });

    ingested += 1;
    if (isFlagged) flagged += 1;
  }

  return { ingested, flagged, unpriceable };
}

/** Thrown and swallowed inside `ingestLiveSales` to roll back a losing race. */
class AlreadyLinked extends Error {}

/**
 * Erase buyer handles 90 days after the sale (SR-4.5).
 *
 * Runs on the worker, which **cannot read this column** (migration 0024). That is not a
 * limitation to work around: erasing a name is the one operation that should never require
 * seeing it, and the grant says so in a way a future refactor has to argue with.
 */
export async function purgeExpiredBuyerHandles(db: Database): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    update app.live_sales
       set buyer_handle_encrypted = null,
           has_buyer_handle = false,
           updated_at = now()
     -- The flag, not the column: Postgres requires SELECT on everything a statement reads,
     -- including its own WHERE, and this role deliberately cannot read the handle.
     where has_buyer_handle
       and sold_at < now() - make_interval(days => ${BUYER_HANDLE_RETENTION_DAYS})
    returning id
  `);
  return rows.length;
}

export interface FlaggedObservation {
  id: string;
  cardVariantId: string;
  cardName: string | null;
  source: string;
  condition: CardCondition;
  priceCents: number;
  currency: string;
  observedAt: Date;
  flaggedAt: Date;
  /** What it was measured against, so a reviewer can see why it was held. */
  medianCents: number | null;
  /** The VOD link the seller gave, if any — the fastest way to tell a typo from a real sale. */
  evidenceRef: string | null;
}

/** The review queue: recorded, approved, and deliberately not counting yet (SR-4.4). */
export async function listFlaggedObservations(
  db: Database,
  limit = 50,
): Promise<FlaggedObservation[]> {
  const rows = await db.execute<{
    id: string;
    card_variant_id: string;
    card_name: string | null;
    source: string;
    condition: CardCondition;
    price_cents: number;
    currency: string;
    observed_at: string | Date;
    flagged_at: string | Date;
    median_cents: number | null;
    evidence_ref: string | null;
  }>(sql`
    select o.id, o.card_variant_id, c.name as card_name, o.source, o.condition,
           o.price_cents, o.currency, o.observed_at, o.flagged_at, o.evidence_ref,
           (select d.median_cents from app.price_index_daily d
             where d.card_variant_id = o.card_variant_id
               and d.condition = o.condition
               and d.currency = o.currency
             order by d.day desc limit 1) as median_cents
      from app.price_observations o
      left join app.card_variants v on v.id = o.card_variant_id
      left join app.cards c on c.id = v.card_id
     where o.flagged_at is not null
       and o.rejected_at is null
     order by o.flagged_at asc
     limit ${Math.min(Math.max(limit, 1), 200)}
  `);

  return rows.map((r) => ({
    id: r.id,
    cardVariantId: r.card_variant_id,
    cardName: r.card_name,
    source: r.source,
    condition: r.condition,
    priceCents: r.price_cents,
    currency: r.currency,
    observedAt: toDate(r.observed_at),
    flaggedAt: toDate(r.flagged_at),
    medianCents: r.median_cents,
    evidenceRef: r.evidence_ref,
  }));
}

/**
 * Clear or reject a flagged observation (SR-4.4).
 *
 * `clear` means a human looked and the price was real, so it starts counting. `reject` means
 * it was not, and it never will — the row stays, because deleting the evidence that we
 * received a bad number is worse than keeping it.
 */
export async function reviewFlaggedObservation(
  db: Database,
  observationId: string,
  decision: 'clear' | 'reject',
): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`
    update app.price_observations
       set flagged_at  = null,
           rejected_at = ${decision === 'reject' ? sql`now()` : sql`null`},
           approved_at = ${decision === 'reject' ? sql`null` : sql`coalesce(approved_at, now())`}
     where id = ${observationId}
       and flagged_at is not null
    returning id
  `);
  return rows.length > 0;
}

/** Everything a seller has logged, for the account data export (SR-X.25). */
export async function countLiveSalesToday(db: Database, sellerId: string): Promise<number> {
  return asUser(db, sellerId, async (tx) => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(liveSales)
      .where(and(eq(liveSales.sellerId, sellerId), gte(liveSales.soldAt, since)));
    return n;
  });
}

/** Most recent entries first, for the seller's own page header. */
export async function latestLiveSale(db: Database, sellerId: string): Promise<LiveSale | null> {
  return asUser(db, sellerId, async (tx) => {
    const [row] = await tx
      .select()
      .from(liveSales)
      .where(eq(liveSales.sellerId, sellerId))
      .orderBy(desc(liveSales.soldAt))
      .limit(1);
    return row ?? null;
  });
}
