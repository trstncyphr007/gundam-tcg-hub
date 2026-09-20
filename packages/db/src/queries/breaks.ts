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
  valueCentsAtPull: number;
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

    const [row] = await tx
      .insert(breakPulls)
      .values({
        breakId,
        cardVariantId: input.cardVariantId,
        label: input.label,
        valueCentsAtPull: input.valueCentsAtPull,
        seq: sql`(select coalesce(max(p.seq), 0) + 1 from app.break_pulls p where p.break_id = ${breakId})`,
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
  pulledAt: Date;
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

  const pulls = await listPulls(db, breakId);
  return {
    ...row,
    pulls,
    totalCents: pulls.reduce((sum, p) => sum + p.valueCentsAtPull, 0),
  };
}

/** Pulls in order, with the card name resolved, or the creator's free-text label. */
export async function listPulls(db: Database, breakId: string): Promise<PublicPull[]> {
  const rows = await db
    .select({
      seq: breakPulls.seq,
      label: breakPulls.label,
      valueCentsAtPull: breakPulls.valueCentsAtPull,
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
