import {
  type PublishedOdds,
  type RarityComparison,
  compareRarities,
  isValidHandle,
} from '@gth/core';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { breaks } from '../schema/breaks.js';
import { creatorProfiles } from '../schema/profiles.js';
import { checkChains } from './fairness.js';
import { isUniqueViolation } from './pg-errors.js';
import { asUser } from './watches.js';

export type CreatorProfile = typeof creatorProfiles.$inferSelect;

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

/**
 * How many of a breaker's most recent breaks have their hash chains re-verified on a profile
 * view (SR-4.1).
 *
 * A cap is unavoidable: re-hashing every pull of 200 breaks would make a public page do
 * hundreds of thousands of SHA-256 operations on every request, which is both slow and a
 * gift to anyone looking for a cheap way to load the server. Twenty-five recent breaks is
 * the compromise, and the page states the number it checked rather than implying it checked
 * everything. Every break is still verifiable in full on its own page, by the reader's own
 * browser.
 */
export const PROFILE_CHAIN_SAMPLE = 25;

/** How many breaks are listed on the profile. */
export const PROFILE_RECENT_BREAKS = 10;

export interface ProfileInput {
  handle: string;
  displayName: string;
  bio?: string | undefined;
  published: boolean;
}

/**
 * Create or replace the signed-in creator's profile.
 *
 * One row per account (a unique index on `user_id`), so this is an upsert on that column
 * rather than an insert that could quietly give someone two public pages.
 */
export async function upsertProfile(
  db: Database,
  userId: string,
  input: ProfileInput,
): Promise<CreatorProfile> {
  const handle = input.handle.trim().toLowerCase();
  // Checked here as well as by the CHECK constraint, because the reserved list is a product
  // decision rather than a data-integrity one and the error should name the real reason.
  if (!isValidHandle(handle)) {
    throw new ProfileError('that handle is not available');
  }
  const displayName = input.displayName.trim();
  if (displayName.length === 0 || displayName.length > 60) {
    throw new ProfileError('a display name must be between 1 and 60 characters');
  }
  const bio = input.bio?.trim();
  if (bio !== undefined && bio.length > 280) {
    throw new ProfileError('a bio must be 280 characters or fewer');
  }

  return asUser(db, userId, async (tx) => {
    try {
      const [row] = await tx
        .insert(creatorProfiles)
        .values({
          userId,
          handle,
          displayName,
          bio: bio === undefined || bio.length === 0 ? null : bio,
          published: input.published,
        })
        .onConflictDoUpdate({
          target: creatorProfiles.userId,
          set: {
            handle,
            displayName,
            bio: bio === undefined || bio.length === 0 ? null : bio,
            published: input.published,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new ProfileError('profile write returned no row');
      return row;
    } catch (error) {
      // A taken handle is an ordinary outcome of a form, not a server fault. Postgres
      // reports it as 23505 on the handle index; anything else is a real error.
      if (isUniqueViolation(error, 'creator_profiles_handle_key')) {
        throw new ProfileError('that handle is already taken');
      }
      throw error;
    }
  });
}

export async function getMyProfile(db: Database, userId: string): Promise<CreatorProfile | null> {
  return asUser(db, userId, async (tx) => {
    const [row] = await tx
      .select()
      .from(creatorProfiles)
      .where(eq(creatorProfiles.userId, userId))
      .limit(1);
    return row ?? null;
  });
}

export async function deleteMyProfile(db: Database, userId: string): Promise<boolean> {
  return asUser(db, userId, async (tx) => {
    const rows = await tx
      .delete(creatorProfiles)
      .where(eq(creatorProfiles.userId, userId))
      .returning({ id: creatorProfiles.id });
    return rows.length > 0;
  });
}

export interface ProfileSummary {
  handle: string;
  displayName: string;
  bio: string | null;
}

/** Published profiles only. The policy would enforce it anyway; the filter makes it explicit. */
export async function listPublishedProfiles(db: Database, limit = 50): Promise<ProfileSummary[]> {
  return db
    .select({
      handle: creatorProfiles.handle,
      displayName: creatorProfiles.displayName,
      bio: creatorProfiles.bio,
    })
    .from(creatorProfiles)
    .where(eq(creatorProfiles.published, true))
    .orderBy(desc(creatorProfiles.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
}

export type FairnessBadge = 'verified' | 'none' | 'broken';

export interface BreakerFairness {
  /** Breaks that were committed to before they started. */
  committed: number;
  /** Of those, the ones whose seed has been revealed. */
  revealed: number;
  /** How many chains were re-verified for this page, out of how many ended breaks. */
  chainsChecked: number;
  endedBreaks: number;
  chainsValid: number;
  chainsBroken: number;
  /** Logs written before the chain existed: reported as unproven, never as passing. */
  chainsUnverifiable: number;
  badge: FairnessBadge;
}

export interface BreakerTotals {
  breaks: number;
  endedBreaks: number;
  pulls: number;
  totalValueCents: number;
  packsOpened: number;
  /** Ended breaks that recorded no pack count, and so sit outside every comparison. */
  breaksWithoutPackCount: number;
}

export interface RarityCount {
  rarity: string;
  pulls: number;
}

export interface OddsReport {
  sealedProductId: string;
  productName: string;
  breaks: number;
  packs: number;
  /** Pulls with no card variant, which therefore have no rarity to tally. */
  unidentifiedPulls: number;
  rarities: RarityComparison[];
  /** Where the odds came from, per rarity. Empty when none are published. */
  sources: { rarity: string; sourceUrl: string; publishedAt: Date | null }[];
}

export interface RecentBreak {
  id: string;
  title: string;
  productName: string | null;
  status: 'draft' | 'live' | 'ended';
  packsOpened: number | null;
  pulls: number;
  totalCents: number;
  endedAt: Date | null;
}

export interface BreakerProfile extends ProfileSummary {
  totals: BreakerTotals;
  fairness: BreakerFairness;
  rarityCounts: RarityCount[];
  oddsReports: OddsReport[];
  recentBreaks: RecentBreak[];
}

/**
 * A breaker's public page (FR-4.3).
 *
 * Runs on whatever role the caller hands in — the public API uses the read-only one, which
 * has no declared user and so sees published profiles and non-draft breaks only. Nothing
 * here filters by visibility in TypeScript; the policies do it, and these queries would
 * return the same rows if the application logic were wrong.
 *
 * Returns null for an unknown or unpublished handle, which are deliberately the same answer.
 */
export async function getBreakerProfile(
  db: Database,
  handle: string,
): Promise<BreakerProfile | null> {
  const [profile] = await db
    .select({
      userId: creatorProfiles.userId,
      handle: creatorProfiles.handle,
      displayName: creatorProfiles.displayName,
      bio: creatorProfiles.bio,
    })
    .from(creatorProfiles)
    .where(
      and(eq(creatorProfiles.handle, handle.toLowerCase()), eq(creatorProfiles.published, true)),
    )
    .limit(1);
  if (!profile) return null;

  const [totals, rarityCounts, oddsReports, recentBreaks, fairness] = await Promise.all([
    breakerTotals(db, profile.userId),
    breakerRarityCounts(db, profile.userId),
    breakerOddsReports(db, profile.userId),
    breakerRecentBreaks(db, profile.userId),
    breakerFairness(db, profile.userId),
  ]);

  return {
    handle: profile.handle,
    displayName: profile.displayName,
    bio: profile.bio,
    totals,
    fairness,
    rarityCounts,
    oddsReports,
    recentBreaks,
  };
}

/**
 * Type aliases rather than interfaces: `db.execute<T>` constrains T to
 * `Record<string, unknown>`, and an interface has no implicit index signature.
 *
 * `bigint` columns arrive as **strings**, because a Postgres bigint does not fit a JS
 * number and the driver will not silently lose the difference. They are typed that way
 * here so the conversion below is a real one rather than a defensive cast that reads as
 * noise.
 */
type TotalsRow = {
  breaks: number;
  ended_breaks: number;
  pulls: number;
  total_value_cents: string;
  packs_opened: number;
  breaks_without_pack_count: number;
};

async function breakerTotals(db: Database, userId: string): Promise<BreakerTotals> {
  // Counted over breaks the *reader* can see, which for a public page means non-drafts: a
  // draft is not part of a creator's record until they publish it.
  const rows = await db.execute<TotalsRow>(sql`
    with visible as (
      select b.id, b.status, b.packs_opened
        from app.breaks b
       where b.creator_id = ${userId}
    )
    select count(*)::int                                                as breaks,
           count(*) filter (where status = 'ended')::int                as ended_breaks,
           coalesce((select count(*) from app.break_pulls p
                      where p.break_id in (select id from visible)), 0)::int as pulls,
           coalesce((select sum(p.value_cents_at_pull) from app.break_pulls p
                      where p.break_id in (select id from visible)), 0)::bigint as total_value_cents,
           coalesce(sum(packs_opened) filter (where status = 'ended'), 0)::int  as packs_opened,
           count(*) filter (where status = 'ended' and packs_opened is null)::int
                                                                        as breaks_without_pack_count
      from visible
  `);

  const row = rows[0];
  return {
    breaks: row?.breaks ?? 0,
    endedBreaks: row?.ended_breaks ?? 0,
    pulls: row?.pulls ?? 0,
    totalValueCents: Number(row?.total_value_cents ?? 0),
    packsOpened: row?.packs_opened ?? 0,
    breaksWithoutPackCount: row?.breaks_without_pack_count ?? 0,
  };
}

async function breakerRarityCounts(db: Database, userId: string): Promise<RarityCount[]> {
  const rows = await db.execute<{ rarity: string | null; pulls: number }>(sql`
    select c.rarity, count(*)::int as pulls
      from app.break_pulls p
      join app.breaks b          on b.id = p.break_id
      join app.card_variants v   on v.id = p.card_variant_id
      join app.cards c           on c.id = v.card_id
     where b.creator_id = ${userId}
       and c.rarity is not null
     group by c.rarity
     order by count(*) desc, c.rarity asc
  `);
  // The WHERE clause excludes nulls, but the column is nullable, so the coalesce is what
  // makes that promise to the type system rather than an assertion.
  return rows.map((r) => ({ rarity: r.rarity ?? '', pulls: r.pulls }));
}

type RarityTallyRow = {
  sealed_product_id: string;
  product_name: string;
  breaks: number;
  packs: number;
  unidentified_pulls: number;
  rarity: string | null;
  hits: number;
  numerator: number | null;
  denominator: number | null;
  source_url: string | null;
  published_at: Date | null;
};

/**
 * Hit rates against published odds, grouped by product (FR-4.3).
 *
 * Grouped by product deliberately. Odds differ between sets, so pooling an SR pulled from a
 * 1-in-12 product with one from a 1-in-24 product produces a rate that is not comparable to
 * either — a subtle way to make an innocent breaker look lucky, or a lucky one look normal.
 *
 * Only **ended** breaks that recorded a pack count are counted. A live break is a sample
 * still being drawn, and a break with no pack count has no denominator at all.
 */
async function breakerOddsReports(db: Database, userId: string): Promise<OddsReport[]> {
  const rows = await db.execute<RarityTallyRow>(sql`
    with eligible as (
      select b.id, b.sealed_product_id, b.packs_opened
        from app.breaks b
       where b.creator_id = ${userId}
         and b.status = 'ended'
         and b.packs_opened is not null
         and b.sealed_product_id is not null
    ),
    per_product as (
      select sealed_product_id,
             count(*)::int              as breaks,
             sum(packs_opened)::int     as packs
        from eligible
       group by sealed_product_id
    ),
    tallies as (
      select e.sealed_product_id,
             c.rarity,
             count(*)::int as hits
        from app.break_pulls p
        join eligible e          on e.id = p.break_id
        join app.card_variants v on v.id = p.card_variant_id
        join app.cards c         on c.id = v.card_id
       where c.rarity is not null
       group by e.sealed_product_id, c.rarity
    ),
    unidentified as (
      select e.sealed_product_id, count(*)::int as pulls
        from app.break_pulls p
        join eligible e on e.id = p.break_id
        left join app.card_variants v on v.id = p.card_variant_id
        left join app.cards c on c.id = v.card_id
       where p.card_variant_id is null or c.rarity is null
       group by e.sealed_product_id
    ),
    -- Every rarity worth a row: one that was pulled, or one with published odds. The second
    -- half matters most — a rarity with published odds and zero hits is exactly the case a
    -- sceptic came to see, and a plain join to the tallies would drop it.
    rarities as (
      select sealed_product_id, rarity from tallies
      union
      select po.sealed_product_id, po.rarity
        from app.pack_odds po
       where po.sealed_product_id in (select sealed_product_id from per_product)
    )
    select pp.sealed_product_id,
           sp.name                        as product_name,
           pp.breaks,
           pp.packs,
           coalesce(u.pulls, 0)           as unidentified_pulls,
           r.rarity,
           coalesce(t.hits, 0)            as hits,
           po.numerator,
           po.denominator,
           po.source_url,
           po.published_at
      from per_product pp
      join app.sealed_products sp on sp.id = pp.sealed_product_id
      left join unidentified u    on u.sealed_product_id = pp.sealed_product_id
      left join rarities r        on r.sealed_product_id = pp.sealed_product_id
      left join tallies t         on t.sealed_product_id = r.sealed_product_id
                                 and t.rarity = r.rarity
      left join app.pack_odds po  on po.sealed_product_id = r.sealed_product_id
                                 and po.rarity = r.rarity
     order by pp.packs desc, r.rarity asc
  `);

  const byProduct = new Map<
    string,
    OddsReport & { raw: { rarity: string; hits: number; published: PublishedOdds | null }[] }
  >();
  for (const row of rows) {
    const rarity = row.rarity ?? null;
    const key = row.sealed_product_id;
    let report = byProduct.get(key);
    if (!report) {
      report = {
        sealedProductId: key,
        productName: row.product_name,
        breaks: row.breaks,
        packs: row.packs,
        unidentifiedPulls: row.unidentified_pulls,
        rarities: [],
        sources: [],
        raw: [],
      };
      byProduct.set(key, report);
    }
    if (rarity === null) continue;

    const published =
      row.numerator !== null && row.denominator !== null
        ? { numerator: row.numerator, denominator: row.denominator }
        : null;
    report.raw.push({ rarity, hits: row.hits, published });
    if (published && row.source_url !== null) {
      report.sources.push({ rarity, sourceUrl: row.source_url, publishedAt: row.published_at });
    }
  }

  return [...byProduct.values()].map(({ raw, ...report }) => ({
    ...report,
    // The comparison itself lives in @gth/core, tested on its own, so the page and the API
    // cannot reach different verdicts from the same tallies.
    rarities: compareRarities(raw.map((r) => ({ ...r, packs: report.packs }))),
  }));
}

async function breakerRecentBreaks(db: Database, userId: string): Promise<RecentBreak[]> {
  const rows = await db.execute<{
    id: string;
    title: string;
    product_name: string | null;
    status: 'draft' | 'live' | 'ended';
    packs_opened: number | null;
    pulls: number;
    /** bigint: a string on the wire, for the reason given on `TotalsRow`. */
    total_cents: string;
    ended_at: Date | null;
  }>(sql`
    select b.id,
           b.title,
           sp.name                                            as product_name,
           b.status,
           b.packs_opened,
           coalesce(count(p.id), 0)::int                      as pulls,
           coalesce(sum(p.value_cents_at_pull), 0)::bigint    as total_cents,
           b.ended_at
      from app.breaks b
      left join app.sealed_products sp on sp.id = b.sealed_product_id
      left join app.break_pulls p      on p.break_id = b.id
     where b.creator_id = ${userId}
     group by b.id, sp.name
     order by coalesce(b.ended_at, b.started_at, b.created_at) desc
     limit ${PROFILE_RECENT_BREAKS}
  `);

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    productName: r.product_name,
    status: r.status,
    packsOpened: r.packs_opened,
    pulls: r.pulls,
    totalCents: Number(r.total_cents),
    endedAt: r.ended_at,
  }));
}

/**
 * The "verified randomisation" badge (FR-4.3).
 *
 * Earned, and losable. A badge that can only ever be awarded is decoration; this one turns
 * to `broken` the moment any re-checked chain fails to re-derive, which is the single most
 * important thing a reader could learn from this page.
 *
 * `verified` needs a revealed commitment *and* no broken chain — the two halves of the claim.
 * Commit–reveal shows the shuffle was not chosen after the fact; the chain shows the log was
 * not edited after the fact. Either alone leaves the other open.
 */
async function breakerFairness(db: Database, userId: string): Promise<BreakerFairness> {
  const [counts] = await db.execute<{ committed: number; revealed: number; ended: number }>(sql`
    select count(bc.id) filter (where bc.id is not null)::int          as committed,
           count(bc.id) filter (where bc.revealed_seed is not null)::int as revealed,
           count(*) filter (where b.status = 'ended')::int             as ended
      from app.breaks b
      left join app.break_commitments bc on bc.break_id = b.id
     where b.creator_id = ${userId}
  `);

  const recent = await db
    .select({ id: breaks.id })
    .from(breaks)
    .where(and(eq(breaks.creatorId, userId), eq(breaks.status, 'ended')))
    .orderBy(desc(breaks.endedAt))
    .limit(PROFILE_CHAIN_SAMPLE);

  const statuses = await checkChains(
    db,
    recent.map((r) => r.id),
  );

  let chainsValid = 0;
  let chainsBroken = 0;
  let chainsUnverifiable = 0;
  for (const status of statuses.values()) {
    if (status.state === 'valid') chainsValid += 1;
    else if (status.state === 'invalid') chainsBroken += 1;
    else if (status.state === 'unverifiable') chainsUnverifiable += 1;
  }

  const revealed = counts?.revealed ?? 0;
  const badge: FairnessBadge = chainsBroken > 0 ? 'broken' : revealed > 0 ? 'verified' : 'none';

  return {
    committed: counts?.committed ?? 0,
    revealed,
    endedBreaks: counts?.ended ?? 0,
    // Breaks with no pulls return no chain status, so report what was actually examined
    // rather than how many ids were offered.
    chainsChecked: statuses.size,
    chainsValid,
    chainsBroken,
    chainsUnverifiable,
    badge,
  };
}
