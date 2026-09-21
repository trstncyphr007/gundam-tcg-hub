import { GENESIS_HASH, hashPull } from '@gth/core';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { breakPulls, breaks } from '../schema/breaks.js';
import { cardVariants, cards, sealedProducts } from '../schema/catalog.js';
import { asUser } from './watches.js';

export type Break = typeof breaks.$inferSelect;
export type BreakPull = typeof breakPulls.$inferSelect;

/** Per-creator cap, so one account cannot fill the table with abandoned drafts. */
export const MAX_BREAKS_PER_CREATOR = 200;
/** Per-break cap. A booster case is ~720 packs; this is far above any real break. */
export const MAX_PULLS_PER_BREAK = 2000;

export class BreakLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BreakLimitError';
  }
}

export class BreakStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BreakStateError';
  }
}

export interface CreateBreakInput {
  title: string;
  sealedProductId?: string | undefined;
  costCents?: number | undefined;
  /** HMAC of the overlay token. The caller keeps the plaintext and shows it once. */
  overlayTokenHash: string;
}

export async function createBreak(
  db: Database,
  creatorId: string,
  input: CreateBreakInput,
): Promise<Break> {
  return asUser(db, creatorId, async (tx) => {
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(breaks)
      .where(eq(breaks.creatorId, creatorId));
    if (n >= MAX_BREAKS_PER_CREATOR) {
      throw new BreakLimitError(`break limit reached (${String(MAX_BREAKS_PER_CREATOR)})`);
    }

    const [row] = await tx
      .insert(breaks)
      .values({
        creatorId,
        title: input.title,
        sealedProductId: input.sealedProductId,
        costCents: input.costCents,
        overlayTokenHash: input.overlayTokenHash,
      })
      .returning();
    if (!row) throw new Error('break insert failed');
    return row;
  });
}

export async function listBreaks(db: Database, creatorId: string): Promise<Break[]> {
  return asUser(db, creatorId, (tx) =>
    tx.select().from(breaks).where(eq(breaks.creatorId, creatorId)).orderBy(desc(breaks.createdAt)),
  );
}

export async function getBreakForCreator(
  db: Database,
  creatorId: string,
  breakId: string,
): Promise<Break | null> {
  return asUser(db, creatorId, async (tx) => {
    const [row] = await tx
      .select()
      .from(breaks)
      .where(and(eq(breaks.id, breakId), eq(breaks.creatorId, creatorId)))
      .limit(1);
    return row ?? null;
  });
}

/**
 * draft → live → ended, one way. The database enforces the timestamp/status pairing; this
 * enforces the ordering, so a break cannot be restarted after it ends and have its log
 * reopened.
 */
export async function setBreakStatus(
  db: Database,
  creatorId: string,
  breakId: string,
  next: 'live' | 'ended',
): Promise<Break> {
  return asUser(db, creatorId, async (tx) => {
    const [current] = await tx
      .select()
      .from(breaks)
      .where(and(eq(breaks.id, breakId), eq(breaks.creatorId, creatorId)))
      .limit(1);
    if (!current) throw new BreakStateError('break not found');

    const allowed = next === 'live' ? current.status === 'draft' : current.status === 'live';
    if (!allowed) {
      throw new BreakStateError(`cannot go from ${current.status} to ${next}`);
    }

    const [row] = await tx
      .update(breaks)
      .set(
        next === 'live'
          ? { status: 'live', startedAt: new Date(), updatedAt: new Date() }
          : { status: 'ended', endedAt: new Date(), updatedAt: new Date() },
      )
      .where(and(eq(breaks.id, breakId), eq(breaks.creatorId, creatorId)))
      .returning();
    if (!row) throw new BreakStateError('break not found');
    return row;
  });
}

/** A case is 12 boxes of 24. The database enforces the same bound. */
export const MAX_PACKS_PER_BREAK = 5000;

/**
 * Record how many packs were opened (FR-4.3).
 *
 * Separate from creation because it is usually known at the end, not the start — a creator
 * opening "whatever fits in the hour" has no number until the hour is over. Editable while
 * the break runs and after it ends, which is a deliberate asymmetry with the pull log: a
 * pull is evidence and cannot be rewritten, whereas the pack count is a fact about the
 * session that the creator is the only source for. Every change is audited by the caller.
 */
export async function setPacksOpened(
  db: Database,
  creatorId: string,
  breakId: string,
  packsOpened: number | null,
): Promise<Break> {
  if (packsOpened !== null && (!Number.isInteger(packsOpened) || packsOpened < 1)) {
    throw new BreakStateError('a pack count must be a whole number of at least 1');
  }
  if (packsOpened !== null && packsOpened > MAX_PACKS_PER_BREAK) {
    throw new BreakLimitError(`pack count above the limit (${String(MAX_PACKS_PER_BREAK)})`);
  }

  return asUser(db, creatorId, async (tx) => {
    const [row] = await tx
      .update(breaks)
      .set({ packsOpened, updatedAt: new Date() })
      .where(and(eq(breaks.id, breakId), eq(breaks.creatorId, creatorId)))
      .returning();
    if (!row) throw new BreakStateError('break not found');
    return row;
  });
}

/**
 * Replace the overlay token (SR-2.1). The version bump is what makes rotation provable:
 * the old token's hash is gone, so it cannot match again even if someone kept it.
 */
export async function rotateOverlayToken(
  db: Database,
  creatorId: string,
  breakId: string,
  newHash: string,
): Promise<Break> {
  return asUser(db, creatorId, async (tx) => {
    const [row] = await tx
      .update(breaks)
      .set({
        overlayTokenHash: newHash,
        overlayTokenVersion: sql`${breaks.overlayTokenVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(breaks.id, breakId), eq(breaks.creatorId, creatorId)))
      .returning();
    if (!row) throw new BreakStateError('break not found');
    return row;
  });
}

export interface LogPullInput {
  cardVariantId?: string | undefined;
  label?: string | undefined;
  /** Omit to have the index fill it, when the pull names a card variant (FR-2.1). */
  valueCentsAtPull?: number | undefined;
}

/**
 * How long a published price is allowed to stand in for a card's value.
 *
 * The same window the collection valuation uses, for the same reason: a stale price is a
 * memory, not a valuation, and a break log is a claim about what happened tonight.
 */
export const INDEX_FILL_MAX_AGE_DAYS = 30;

/**
 * The latest published price for a freshly-pulled card, or null.
 *
 * Near mint is not a guess: a card out of a pack that was sealed an hour ago is near mint by
 * definition. Returns null rather than zero when the index has nothing to say — the caller
 * decides what to do with "we don't know", and it must never be the number 0.
 */
export async function latestIndexValue(
  db: Database,
  cardVariantId: string,
): Promise<number | null> {
  const rows = await db.execute<{ median_cents: number }>(sql`
    select d.median_cents
      from app.price_index_daily d
     where d.card_variant_id = ${cardVariantId}
       and d.condition = 'nm'
       and d.currency = 'USD'
       and d.day >= current_date - make_interval(days => ${INDEX_FILL_MAX_AGE_DAYS})
     order by d.day desc
     limit 1
  `);
  return rows[0]?.median_cents ?? null;
}

/**
 * Append one pull. `seq` is assigned from the current maximum inside the same transaction,
 * so two rapid pulls cannot collide -- and if they somehow do, the unique index rejects
 * the second rather than silently reordering the log.
 */
export async function logPull(
  db: Database,
  creatorId: string,
  breakId: string,
  input: LogPullInput,
): Promise<BreakPull> {
  return asUser(db, creatorId, async (tx) => {
    const [owned] = await tx
      .select({ status: breaks.status })
      .from(breaks)
      .where(and(eq(breaks.id, breakId), eq(breaks.creatorId, creatorId)))
      .limit(1);
    if (!owned) throw new BreakStateError('break not found');
    if (owned.status !== 'live') throw new BreakStateError('break is not live');

    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(breakPulls)
      .where(eq(breakPulls.breakId, breakId));
    if (n >= MAX_PULLS_PER_BREAK) {
      throw new BreakLimitError(`pull limit reached (${String(MAX_PULLS_PER_BREAK)})`);
    }

    // A value the creator typed always wins. The index only fills a blank, and only when the
    // pull says which card it was — a free-text label cannot be priced.
    let valueCentsAtPull = input.valueCentsAtPull;
    let valueSource: 'manual' | 'index' = 'manual';
    if (valueCentsAtPull === undefined) {
      if (input.cardVariantId) {
        const filled = await latestIndexValue(tx, input.cardVariantId);
        // No published price means zero *recorded*, but never zero *claimed*: the source
        // stays `index` so nothing downstream reads the absence as a sale at nothing.
        valueCentsAtPull = filled ?? 0;
        valueSource = 'index';
      } else {
        // A free-text label cannot be looked up, so a blank here is a blank a person left.
        valueCentsAtPull = 0;
      }
    }

    // Link this pull to the one before it (SR-4.1). Inside the same transaction as the
    // insert, so two rapid pulls cannot both chain from the same tip and produce a fork.
    const [tip] = await tx
      .select({ seq: breakPulls.seq, rowHash: breakPulls.rowHash })
      .from(breakPulls)
      .where(eq(breakPulls.breakId, breakId))
      .orderBy(sql`${breakPulls.seq} desc`)
      .limit(1);

    const seq = (tip?.seq ?? 0) + 1;
    const prevHash = tip?.rowHash ?? GENESIS_HASH;
    const pulledAt = new Date();
    const rowHash = await hashPull(prevHash, {
      seq,
      cardVariantId: input.cardVariantId ?? null,
      label: input.label ?? null,
      valueCentsAtPull,
      valueSource,
      pulledAt: pulledAt.toISOString(),
    });

    const [row] = await tx
      .insert(breakPulls)
      .values({
        breakId,
        cardVariantId: input.cardVariantId,
        label: input.label,
        valueCentsAtPull,
        valueSource,
        seq,
        pulledAt,
        prevHash,
        rowHash,
      })
      .returning();
    if (!row) throw new Error('pull insert failed');
    return row;
  });
}

export interface PublicPull {
  seq: number;
  label: string;
  valueCentsAtPull: number;
  /**
   * Published, because a viewer deserves to know whether a number was typed by the creator
   * or looked up from the index. A break log people can check is the whole point of the
   * public page (FR-2.2), and "where did this figure come from" is the first thing anyone
   * sceptical would ask.
   */
  valueSource: 'manual' | 'index';
  pulledAt: Date;
}

/**
 * Exactly the values that were hashed, for a viewer to re-derive the chain themselves.
 *
 * Deliberately separate from `PublicPull`, which is for display: that one's `label` is the
 * resolved card name, and hashing a display string would mean the proof depended on how we
 * happened to render it. These are the raw columns, in the form the chain committed to.
 */
export interface VerifiablePull {
  seq: number;
  cardVariantId: string | null;
  label: string | null;
  valueCentsAtPull: number;
  valueSource: string;
  pulledAt: string;
  prevHash: string | null;
  rowHash: string | null;
}

export interface PublicBreak {
  id: string;
  title: string;
  status: 'draft' | 'live' | 'ended';
  costCents: number | null;
  productName: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  pulls: PublicPull[];
  totalCents: number;
  /** The evidence. Everything needed to check this break without trusting our answer. */
  verification: { rows: VerifiablePull[] };
}

/**
 * The break as a viewer sees it (FR-2.2, FR-2.4).
 *
 * Deliberately returns no creator id, no user name and no email: "stream-safe" means the
 * only things that can reach the overlay are the ones the creator typed for display.
 */
export async function getPublicBreak(db: Database, breakId: string): Promise<PublicBreak | null> {
  const [row] = await db
    .select({
      id: breaks.id,
      title: breaks.title,
      status: breaks.status,
      costCents: breaks.costCents,
      startedAt: breaks.startedAt,
      endedAt: breaks.endedAt,
      productName: sealedProducts.name,
    })
    .from(breaks)
    .leftJoin(sealedProducts, eq(sealedProducts.id, breaks.sealedProductId))
    .where(eq(breaks.id, breakId))
    .limit(1);
  if (!row || row.status === 'draft') return null;

  const [pulls, rows] = await Promise.all([
    listPulls(db, breakId),
    listVerifiablePulls(db, breakId),
  ]);
  return {
    ...row,
    pulls,
    totalCents: pulls.reduce((sum, p) => sum + p.valueCentsAtPull, 0),
    verification: { rows },
  };
}

/** The raw, hashed form of each pull, in order. */
export async function listVerifiablePulls(
  db: Database,
  breakId: string,
): Promise<VerifiablePull[]> {
  const rows = await db
    .select({
      seq: breakPulls.seq,
      cardVariantId: breakPulls.cardVariantId,
      label: breakPulls.label,
      valueCentsAtPull: breakPulls.valueCentsAtPull,
      valueSource: breakPulls.valueSource,
      pulledAt: breakPulls.pulledAt,
      prevHash: breakPulls.prevHash,
      rowHash: breakPulls.rowHash,
    })
    .from(breakPulls)
    .where(eq(breakPulls.breakId, breakId))
    .orderBy(asc(breakPulls.seq));

  return rows.map((r) => ({ ...r, pulledAt: r.pulledAt.toISOString() }));
}

/** Pulls in order, with the card name resolved, or the creator's free-text label. */
export async function listPulls(db: Database, breakId: string): Promise<PublicPull[]> {
  const rows = await db
    .select({
      seq: breakPulls.seq,
      label: breakPulls.label,
      valueCentsAtPull: breakPulls.valueCentsAtPull,
      valueSource: breakPulls.valueSource,
      pulledAt: breakPulls.pulledAt,
      cardName: cards.name,
      finish: cardVariants.finish,
    })
    .from(breakPulls)
    .leftJoin(cardVariants, eq(cardVariants.id, breakPulls.cardVariantId))
    .leftJoin(cards, eq(cards.id, cardVariants.cardId))
    .where(eq(breakPulls.breakId, breakId))
    .orderBy(asc(breakPulls.seq));

  return rows.map((r) => ({
    seq: r.seq,
    label: r.cardName
      ? `${r.cardName}${r.finish === 'normal' ? '' : ` (${String(r.finish)})`}`
      : (r.label ?? 'Unknown card'),
    valueCentsAtPull: r.valueCentsAtPull,
    valueSource: r.valueSource,
    pulledAt: r.pulledAt,
  }));
}

/**
 * Run `fn` in a transaction that presents an overlay token's hash to Postgres, so the
 * `breaks_select_by_overlay_token` policy admits exactly the break it belongs to.
 *
 * `set_local` (the `true` argument) scopes it to the transaction, so a pooled connection
 * cannot carry one viewer's access into the next request.
 */
export async function asOverlay<T>(
  db: Database,
  tokenHash: string,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.overlay_token', ${tokenHash}, true)`);
    return fn(tx as unknown as Database);
  });
}

/**
 * Resolve an overlay token to its break (SR-2.1).
 *
 * Lookup is by the token's hash, which is unique-indexed, so a wrong token costs one index
 * probe and leaks no timing signal about which part was wrong. A rotated token's hash is
 * simply absent from the table, so it can never match again -- revocation is immediate and
 * needs no separate list of dead tokens (AC-2.2).
 */
export async function findBreakByOverlayToken(
  db: Database,
  tokenHash: string,
): Promise<{ id: string; status: 'draft' | 'live' | 'ended' } | null> {
  return asOverlay(db, tokenHash, async (tx) => {
    const [row] = await tx
      .select({ id: breaks.id, status: breaks.status })
      .from(breaks)
      .where(eq(breaks.overlayTokenHash, tokenHash))
      .limit(1);
    return row ?? null;
  });
}

/** The overlay's payload: the break as its token-holder may see it, pulls included. */
export async function getOverlayState(
  db: Database,
  tokenHash: string,
): Promise<{
  id: string;
  title: string;
  costCents: number | null;
  pulls: PublicPull[];
  totalCents: number;
} | null> {
  return asOverlay(db, tokenHash, async (tx) => {
    const [row] = await tx
      .select({ id: breaks.id, title: breaks.title, costCents: breaks.costCents })
      .from(breaks)
      .where(eq(breaks.overlayTokenHash, tokenHash))
      .limit(1);
    if (!row) return null;
    const pulls = await listPulls(tx, row.id);
    return { ...row, pulls, totalCents: pulls.reduce((s, p) => s + p.valueCentsAtPull, 0) };
  });
}
