import {
  GENESIS_HASH,
  SHUFFLE_ALGORITHM,
  commitmentFor,
  deriveShuffle,
  verifyChain,
} from '@gth/core';
import { type KeyRing, decryptField, encryptField, generateToken } from '@gth/security';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { breakCommitments, breakPulls, breaks } from '../schema/breaks.js';
import { asUser } from './watches.js';

export class CommitmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitmentError';
  }
}

/** What anyone may see. Note what is absent: the encrypted seed, at every stage. */
export interface PublicCommitment {
  commitment: string;
  clientSeed: string | null;
  revealedSeed: string | null;
  slotCount: number;
  algorithmVersion: string;
  committedAt: Date;
  revealedAt: Date | null;
}

const publicColumns = {
  commitment: breakCommitments.commitment,
  clientSeed: breakCommitments.clientSeed,
  revealedSeed: breakCommitments.revealedSeed,
  slotCount: breakCommitments.slotCount,
  algorithmVersion: breakCommitments.algorithmVersion,
  committedAt: breakCommitments.committedAt,
  revealedAt: breakCommitments.revealedAt,
};

/**
 * Commit to a shuffle before the break starts (FR-4.2).
 *
 * Generates 32 bytes of CSPRNG output, stores it encrypted, and returns only the commitment.
 * **The seed is never returned from this function**, not even to the creator: a creator who
 * knows the seed in advance knows the assignment in advance, and the scheme protects the
 * audience from the creator as much as from us.
 */
export async function commitBreak(
  db: Database,
  creatorId: string,
  breakId: string,
  input: { slotCount: number; keyRing: KeyRing },
): Promise<PublicCommitment> {
  const serverSeed = generateToken(32);
  const commitment = await commitmentFor(serverSeed);

  return asUser(db, creatorId, async (tx) => {
    const [owned] = await tx
      .select({ status: breaks.status })
      .from(breaks)
      .where(and(eq(breaks.id, breakId), eq(breaks.creatorId, creatorId)))
      .limit(1);
    if (!owned) throw new CommitmentError('break not found');
    // Before it starts, or the commitment proves nothing about what already happened.
    if (owned.status !== 'draft') {
      throw new CommitmentError('commit before the break starts, not after');
    }

    const [row] = await tx
      .insert(breakCommitments)
      .values({
        breakId,
        commitment,
        serverSeedEncrypted: encryptField(input.keyRing, serverSeed),
        slotCount: input.slotCount,
        algorithmVersion: SHUFFLE_ALGORITHM,
      })
      .returning(publicColumns);
    if (!row) throw new CommitmentError('commitment insert returned no row');
    return row;
  });
}

/**
 * Record the audience's seed (FR-4.2).
 *
 * Set once and not changeable: a client seed that could be edited after the fact is a client
 * seed the creator could choose to suit the outcome, which is the same hole commit–reveal
 * exists to close from the other direction.
 */
export async function setClientSeed(
  db: Database,
  creatorId: string,
  breakId: string,
  clientSeed: string,
): Promise<PublicCommitment> {
  const trimmed = clientSeed.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    throw new CommitmentError('a client seed must be between 1 and 200 characters');
  }

  return asUser(db, creatorId, async (tx) => {
    const [row] = await tx
      .update(breakCommitments)
      .set({ clientSeed: trimmed })
      .where(and(eq(breakCommitments.breakId, breakId), isNull(breakCommitments.clientSeed)))
      .returning(publicColumns);
    if (!row) throw new CommitmentError('no open commitment, or a client seed is already set');
    return row;
  });
}

/**
 * Reveal the seed and publish the assignment (FR-4.2).
 *
 * Only after the break has ended. Revealing earlier would hand the remaining slots to
 * anyone watching — the seed is the one thing that must stay secret for exactly as long as
 * it can still change what happens.
 */
export async function revealBreak(
  db: Database,
  /**
   * The pool whose role may read `server_seed_encrypted`: the worker, and only the worker.
   * The web role has no SELECT privilege on that column at all (migration 0020), so the tier
   * that serves requests cannot read the ciphertext even here — it hands the one operation
   * that needs it to a role that can, exactly as API-key verification does.
   */
  secretsDb: Database,
  creatorId: string,
  breakId: string,
  keyRing: KeyRing,
): Promise<{ commitment: PublicCommitment; order: number[] }> {
  // Ownership and state first, as the creator, under the row policies.
  const context = await asUser(db, creatorId, async (tx) => {
    const [owned] = await tx
      .select({ status: breaks.status })
      .from(breaks)
      .where(and(eq(breaks.id, breakId), eq(breaks.creatorId, creatorId)))
      .limit(1);
    if (!owned) throw new CommitmentError('break not found');
    if (owned.status !== 'ended') throw new CommitmentError('reveal after the break ends');

    const [commitment] = await tx
      .select({ clientSeed: breakCommitments.clientSeed, slotCount: breakCommitments.slotCount })
      .from(breakCommitments)
      .where(eq(breakCommitments.breakId, breakId))
      .limit(1);
    if (!commitment) throw new CommitmentError('this break was not committed to');
    if (commitment.clientSeed === null) {
      throw new CommitmentError('record the audience seed before revealing');
    }
    return { clientSeed: commitment.clientSeed, slotCount: commitment.slotCount };
  });

  // The one place the ciphertext is read, on the one role that may. Columns are named
  // explicitly so a future addition never joins a payload by accident.
  const [secret] = await secretsDb
    .select({
      encrypted: breakCommitments.serverSeedEncrypted,
      revealedSeed: breakCommitments.revealedSeed,
    })
    .from(breakCommitments)
    .where(eq(breakCommitments.breakId, breakId))
    .limit(1);
  if (!secret) throw new CommitmentError('this break was not committed to');

  const serverSeed = secret.revealedSeed ?? decryptField(keyRing, secret.encrypted);
  const order = await deriveShuffle({
    serverSeed,
    clientSeed: context.clientSeed,
    breakId,
    count: context.slotCount,
  });

  return asUser(db, creatorId, async (tx) => {
    // Idempotent: revealing twice publishes the same seed and the same order rather than
    // failing, because a creator who refreshes the page has done nothing wrong.
    const [row] = await tx
      .update(breakCommitments)
      .set({ revealedSeed: serverSeed, revealedAt: new Date() })
      .where(and(eq(breakCommitments.breakId, breakId), isNull(breakCommitments.revealedSeed)))
      .returning(publicColumns);
    if (row) return { commitment: row, order };

    const [existing] = await tx
      .select(publicColumns)
      .from(breakCommitments)
      .where(eq(breakCommitments.breakId, breakId))
      .limit(1);
    if (!existing) throw new CommitmentError('this break was not committed to');
    return { commitment: existing, order };
  });
}

/** The commitment as a viewer sees it, at whatever stage it has reached. */
export async function getCommitment(
  db: Database,
  breakId: string,
): Promise<PublicCommitment | null> {
  const [row] = await db
    .select(publicColumns)
    .from(breakCommitments)
    .where(eq(breakCommitments.breakId, breakId))
    .limit(1);
  return row ?? null;
}

export interface ChainStatus {
  /** `unverifiable` when the log predates the chain — an absent proof is not a passing one. */
  state: 'valid' | 'invalid' | 'unverifiable' | 'empty';
  brokenAtSeq: number | null;
  /** The last row's hash, published when the break closes (SR-4.1). */
  head: string | null;
}

/**
 * Re-compute the pull log's hash chain (SR-4.1, AC-4.2).
 *
 * Reads what is actually in the table and re-derives every hash, so a row edited directly in
 * the database — by us, by a compromised process, by anyone with a psql prompt — shows up
 * here, at the pull where it happened.
 */
export async function checkChain(db: Database, breakId: string): Promise<ChainStatus> {
  const results = await checkChains(db, [breakId]);
  return results.get(breakId) ?? { state: 'empty', brokenAtSeq: null, head: null };
}

/** The columns the chain committed to, named once so the two readers cannot drift apart. */
const chainColumns = {
  breakId: breakPulls.breakId,
  seq: breakPulls.seq,
  cardVariantId: breakPulls.cardVariantId,
  label: breakPulls.label,
  valueCentsAtPull: breakPulls.valueCentsAtPull,
  valueSource: breakPulls.valueSource,
  pulledAt: breakPulls.pulledAt,
  prevHash: breakPulls.prevHash,
  rowHash: breakPulls.rowHash,
};

interface ChainRow {
  breakId: string;
  seq: number;
  cardVariantId: string | null;
  label: string | null;
  valueCentsAtPull: number;
  valueSource: string;
  pulledAt: Date;
  prevHash: string | null;
  rowHash: string | null;
}

async function statusOf(rows: readonly ChainRow[]): Promise<ChainStatus> {
  if (rows.length === 0) return { state: 'empty', brokenAtSeq: null, head: null };
  if (rows.some((r) => r.prevHash === null || r.rowHash === null)) {
    return { state: 'unverifiable', brokenAtSeq: null, head: null };
  }

  const result = await verifyChain(
    rows.map((r) => ({
      seq: r.seq,
      cardVariantId: r.cardVariantId,
      label: r.label,
      valueCentsAtPull: r.valueCentsAtPull,
      valueSource: r.valueSource,
      pulledAt: r.pulledAt.toISOString(),
      prevHash: String(r.prevHash),
      rowHash: String(r.rowHash),
    })),
  );

  return {
    state: result.valid ? 'valid' : 'invalid',
    brokenAtSeq: result.brokenAtSeq,
    head: result.valid ? String(rows.at(-1)?.rowHash) : null,
  };
}

/**
 * Re-check several breaks' chains in one pass.
 *
 * A breaker profile summarises many breaks at once, and a query per break would turn one
 * page view into dozens of round trips. The verification itself is unchanged: the same rows,
 * the same hashes, in the same order — grouped in memory rather than fetched repeatedly.
 *
 * Ids not present in the result had no pulls at all.
 */
export async function checkChains(
  db: Database,
  breakIds: readonly string[],
): Promise<Map<string, ChainStatus>> {
  const results = new Map<string, ChainStatus>();
  if (breakIds.length === 0) return results;

  const rows = await db
    .select(chainColumns)
    .from(breakPulls)
    .where(inArray(breakPulls.breakId, [...breakIds]))
    // By break, then by seq: the chain is only meaningful in order, and one ORDER BY here
    // is what lets the grouping below stay a single pass.
    .orderBy(asc(breakPulls.breakId), asc(breakPulls.seq));

  const grouped = new Map<string, ChainRow[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.breakId);
    if (bucket) bucket.push(row);
    else grouped.set(row.breakId, [row]);
  }

  for (const [breakId, bucket] of grouped) {
    results.set(breakId, await statusOf(bucket));
  }
  return results;
}

/** The hash the next pull in this break chains from. `GENESIS_HASH` when it is the first. */
export async function chainTip(db: Database, breakId: string): Promise<string> {
  const [row] = await db
    .select({ rowHash: breakPulls.rowHash })
    .from(breakPulls)
    .where(eq(breakPulls.breakId, breakId))
    .orderBy(sql`${breakPulls.seq} desc`)
    .limit(1);
  return row?.rowHash ?? GENESIS_HASH;
}
