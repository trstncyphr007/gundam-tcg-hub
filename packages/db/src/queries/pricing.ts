import {
  MIN_OBSERVATIONS,
  type PriceSourceKind,
  applySourceWeights,
  summarisePrices,
} from '@gth/core';
import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { type cardCondition, priceIndexDaily, priceObservations } from '../schema/pricing.js';
import { asUser } from './watches.js';

export type PriceObservation = typeof priceObservations.$inferSelect;
export type PriceIndexRow = typeof priceIndexDaily.$inferSelect;
export type CardCondition = (typeof cardCondition.enumValues)[number];

/** Per-user cap on unmoderated reports, so one account cannot bury the queue (SR-3.5). */
export const MAX_PENDING_REPORTS_PER_USER = 20;

export class ReportLimitError extends Error {
  constructor() {
    super(`too many reports awaiting moderation (${String(MAX_PENDING_REPORTS_PER_USER)})`);
    this.name = 'ReportLimitError';
  }
}

export interface UserPriceReport {
  cardVariantId: string;
  condition: CardCondition;
  priceCents: number;
  saleType?: 'sold' | 'listed';
  currency?: string;
  observedAt?: Date;
  evidenceRef?: string | undefined;
}

/**
 * File a price report as a user (FR-3.1, SR-3.5).
 *
 * It arrives **unapproved** and counts for nothing until a human says otherwise. The row
 * policy enforces the same thing, so a bug here cannot smuggle an approved row in.
 */
export async function reportPrice(
  db: Database,
  reporterId: string,
  input: UserPriceReport,
): Promise<PriceObservation> {
  return asUser(db, reporterId, async (tx) => {
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(priceObservations)
      .where(
        and(
          eq(priceObservations.reporterId, reporterId),
          isNull(priceObservations.approvedAt),
          isNull(priceObservations.rejectedAt),
        ),
      );
    if (n >= MAX_PENDING_REPORTS_PER_USER) throw new ReportLimitError();

    const [row] = await tx
      .insert(priceObservations)
      .values({
        cardVariantId: input.cardVariantId,
        source: 'user_report',
        saleType: input.saleType ?? 'sold',
        condition: input.condition,
        priceCents: input.priceCents,
        currency: input.currency ?? 'USD',
        observedAt: input.observedAt ?? new Date(),
        evidenceRef: input.evidenceRef,
        reporterId,
      })
      .returning();
    if (!row) throw new Error('observation insert failed');
    return row;
  });
}

/**
 * Turn logged pulls into price observations (FR-3.1, first source).
 *
 * Only pulls that named a real card variant, from a break that actually ran. A card out of
 * a freshly opened pack is near mint by definition, which is why the condition is not a
 * guess.
 *
 * Idempotent: a unique index on `break_pull_id` means re-running cannot inflate the sample,
 * which matters because this is the source we weight most heavily.
 *
 * **Only `manual` values.** The break calculator can fill a pull's value from the published
 * index; ingesting those would make the index quote itself at triple weight — a number it
 * published coming back as evidence, moving tomorrow's number, which comes back again. The
 * result would look like unusually strong data while drifting away from anything anyone
 * actually paid. A typed value is a sale someone saw. An index value is our own opinion, and
 * an opinion is not evidence for itself.
 */
export async function ingestBreakPulls(db: Database): Promise<number> {
  const inserted = await db.execute<{ id: string }>(sql`
    insert into app.price_observations
      (card_variant_id, source, sale_type, condition, price_cents, currency,
       observed_at, break_pull_id, approved_at)
    select p.card_variant_id,
           'break_pull',
           'sold',
           'nm',
           p.value_cents_at_pull,
           'USD',
           p.pulled_at,
           p.id,
           -- Our own log, so it is approved on arrival: we watched it happen.
           now()
      from app.break_pulls p
      join app.breaks b on b.id = p.break_id
     where p.card_variant_id is not null
       and b.status <> 'draft'
       -- See the note above: an index-filled value is a quote, not a sale.
       and p.value_source = 'manual'
    on conflict (break_pull_id) where break_pull_id is not null do nothing
    returning id
  `);
  return inserted.length;
}

/** Approve or reject a pending report (SR-3.5). Admin path only. */
export async function moderateObservation(
  db: Database,
  observationId: string,
  decision: 'approve' | 'reject',
): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`
    update app.price_observations
       set approved_at = ${decision === 'approve' ? sql`now()` : sql`null`},
           rejected_at = ${decision === 'reject' ? sql`now()` : sql`null`}
     where id = ${observationId}
       -- Reports only. A first-party observation is approved on arrival and held, when it
       -- is held, by its flag — so "approve this report" must never be a way to wave a
       -- flagged live sale into the index without clearing the flag.
       and source = 'user_report'
       and approved_at is null
       and rejected_at is null
    returning id
  `);
  return rows.length > 0;
}

interface RollupRow {
  card_variant_id: string;
  condition: CardCondition;
  price_cents: number;
  source: PriceSourceKind;
  currency: string;
}

/**
 * Recompute the published index for one day (FR-3.2).
 *
 * Recomputed rather than updated incrementally: a trimmed median is order-dependent, so it
 * cannot be nudged by adding one number to yesterday's answer. Cheap enough at this scale,
 * and it means a late-arriving or newly-approved observation is picked up on the next run
 * rather than being lost.
 *
 * Only **approved** observations count, which is what makes moderation meaningful.
 */
export async function rollUpDay(
  db: Database,
  day: Date,
): Promise<{ written: number; skipped: number }> {
  const dayStart = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const isoDay = dayStart.toISOString().slice(0, 10);

  const rows = await db
    .select({
      card_variant_id: priceObservations.cardVariantId,
      condition: priceObservations.condition,
      price_cents: priceObservations.priceCents,
      source: priceObservations.source,
      currency: priceObservations.currency,
    })
    .from(priceObservations)
    .where(
      and(
        gte(priceObservations.observedAt, dayStart),
        lte(priceObservations.observedAt, dayEnd),
        sql`${priceObservations.approvedAt} is not null`,
        isNull(priceObservations.flaggedAt),
      ),
    );

  // Group by variant + condition. Mixed currencies are kept apart rather than added
  // together: a median across USD and CAD is a number with no meaning.
  const groups = new Map<string, RollupRow[]>();
  for (const row of rows as RollupRow[]) {
    const key = `${row.card_variant_id}\u0000${row.condition}\u0000${row.currency}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  let written = 0;
  let skipped = 0;

  for (const [key, bucket] of groups) {
    const [cardVariantId, condition, currency] = key.split('\u0000') as [
      string,
      CardCondition,
      string,
    ];
    // The floor applies to REAL observations, not the weighted expansion. Weighting decides
    // how much each price pulls the median; it is not evidence that more sales happened.
    // Checking the weighted list instead would let two trusted sales publish as though they
    // had cleared a bar of three -- which the database CHECK caught when this was wrong.
    if (bucket.length < MIN_OBSERVATIONS) {
      skipped += 1;
      continue;
    }

    const weighted = applySourceWeights(
      bucket.map((r) => ({ cents: r.price_cents, source: r.source })),
    );
    // Already past the floor above, so the summary only has to do the maths.
    const summary = summarisePrices(weighted, { minObservations: 1 });
    if (!summary) {
      skipped += 1;
      continue;
    }

    await db
      .insert(priceIndexDaily)
      .values({
        cardVariantId,
        condition,
        day: isoDay,
        medianCents: summary.medianCents,
        p25Cents: summary.p25Cents,
        p75Cents: summary.p75Cents,
        lowCents: summary.lowCents,
        highCents: summary.highCents,
        // The honest count is how many observations there were, not how many the weighting
        // expanded them into. "Backed by 4 sales" must not read as 12.
        observationCount: bucket.length,
        currency,
      })
      .onConflictDoUpdate({
        target: [
          priceIndexDaily.cardVariantId,
          priceIndexDaily.condition,
          priceIndexDaily.day,
          priceIndexDaily.currency,
        ],
        set: {
          medianCents: summary.medianCents,
          p25Cents: summary.p25Cents,
          p75Cents: summary.p75Cents,
          lowCents: summary.lowCents,
          highCents: summary.highCents,
          observationCount: bucket.length,
          currency,
          computedAt: new Date(),
        },
      });
    written += 1;
  }

  return { written, skipped };
}

/** The latest published price for a variant, or null when there is not enough data. */
export async function latestPrice(
  db: Database,
  cardVariantId: string,
  condition: CardCondition = 'nm',
): Promise<PriceIndexRow | null> {
  const [row] = await db
    .select()
    .from(priceIndexDaily)
    .where(
      and(
        eq(priceIndexDaily.cardVariantId, cardVariantId),
        eq(priceIndexDaily.condition, condition),
      ),
    )
    .orderBy(desc(priceIndexDaily.day))
    .limit(1);
  return row ?? null;
}

/** Price history for a chart (FR-3.3). */
export async function priceHistory(
  db: Database,
  cardVariantId: string,
  options: { condition?: CardCondition; days?: number } = {},
): Promise<PriceIndexRow[]> {
  const days = options.days ?? 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return db
    .select()
    .from(priceIndexDaily)
    .where(
      and(
        eq(priceIndexDaily.cardVariantId, cardVariantId),
        options.condition ? eq(priceIndexDaily.condition, options.condition) : undefined,
        gte(priceIndexDaily.day, since),
      ),
    )
    .orderBy(asc(priceIndexDaily.day));
}

export interface CardPricePoint {
  cardVariantId: string;
  finish: string;
  language: string;
  condition: CardCondition;
  day: string;
  medianCents: number;
  p25Cents: number;
  p75Cents: number;
  lowCents: number;
  highCents: number;
  observationCount: number;
  currency: string;
}

/**
 * Published prices for every printing of one card (FR-3.3, FR-3.6).
 *
 * Keyed on the **card**, not the variant, because that is what a person or an API client
 * has: they know they own "Gundam Barbatos", and which of its printings are priced is an
 * answer, not a question they can be expected to ask.
 *
 * A variant with no published price simply has no rows here. That is deliberate -- the API
 * says "insufficient data" by omission rather than by inventing a zero.
 */
export async function priceHistoryForCard(
  db: Database,
  cardId: string,
  options: { condition?: CardCondition | undefined; days?: number | undefined } = {},
): Promise<CardPricePoint[]> {
  const days = Math.trunc(options.days ?? 30);
  const rows = await db.execute<{
    card_variant_id: string;
    finish: string;
    language: string;
    condition: CardCondition;
    day: string;
    median_cents: number;
    p25_cents: number;
    p75_cents: number;
    low_cents: number;
    high_cents: number;
    observation_count: number;
    currency: string;
  }>(sql`
    select d.card_variant_id,
           v.finish::text as finish,
           v.language::text as language,
           d.condition,
           d.day::text as day,
           d.median_cents,
           d.p25_cents,
           d.p75_cents,
           d.low_cents,
           d.high_cents,
           d.observation_count,
           d.currency
      from app.price_index_daily d
      join app.card_variants v on v.id = d.card_variant_id
     where v.card_id = ${cardId}
       and d.day >= current_date - make_interval(days => ${days})
       ${options.condition ? sql`and d.condition = ${options.condition}` : sql``}
     order by v.finish, v.language, d.condition, d.day
  `);

  return rows.map((r) => ({
    cardVariantId: r.card_variant_id,
    finish: r.finish,
    language: r.language,
    condition: r.condition,
    day: r.day,
    medianCents: r.median_cents,
    p25Cents: r.p25_cents,
    p75Cents: r.p75_cents,
    lowCents: r.low_cents,
    highCents: r.high_cents,
    observationCount: r.observation_count,
    currency: r.currency,
  }));
}

export interface PriceSourceMix {
  source: PriceSourceKind;
  observations: number;
}

/**
 * Where a card's prices came from, over the same window as its history (FR-3.3).
 *
 * This is the transparency half of the index. A median is only worth believing if you can
 * see what went into it, and "412 live sales and 96 marketplace pulls" is a different claim
 * from "508 numbers". Published alongside the chart for that reason.
 *
 * Counts **real observations**, never the weighted expansion of them — the same rule the
 * published `observation_count` follows, for the same reason (ADR-018).
 */
export async function priceSourceMix(
  db: Database,
  cardId: string,
  options: { condition?: CardCondition | undefined; days?: number | undefined } = {},
): Promise<PriceSourceMix[]> {
  const days = Math.trunc(options.days ?? 30);
  const rows = await db.execute<{ source: PriceSourceKind; observations: number }>(sql`
    select o.source, count(*)::int as observations
      from app.price_observations o
      join app.card_variants v on v.id = o.card_variant_id
     where v.card_id = ${cardId}
       and o.approved_at is not null
       and o.flagged_at is null
       and o.observed_at >= current_date - make_interval(days => ${days})
       ${options.condition ? sql`and o.condition = ${options.condition}` : sql``}
     group by o.source
     order by observations desc, o.source
  `);
  return rows.map((r) => ({ source: r.source, observations: r.observations }));
}

/** Reports waiting on a human (SR-3.5). */
export async function listPendingReports(db: Database, limit = 50): Promise<PriceObservation[]> {
  return db
    .select()
    .from(priceObservations)
    .where(
      and(
        eq(priceObservations.source, 'user_report'),
        isNull(priceObservations.approvedAt),
        isNull(priceObservations.rejectedAt),
      ),
    )
    .orderBy(asc(priceObservations.createdAt))
    .limit(limit);
}
