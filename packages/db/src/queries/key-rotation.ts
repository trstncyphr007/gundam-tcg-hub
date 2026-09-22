import { DecryptionError, type KeyRing, decryptField, encryptField, keyIdOf } from '@gth/security';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Database } from '../client.js';
import { users } from '../schema/auth.js';
import { breakCommitments, breaks } from '../schema/breaks.js';
import { liveSales } from '../schema/live-sales.js';
import { asUser } from './watches.js';

/**
 * Re-encrypt every encrypted field under the active key, so an old key can be retired
 * (SR-X.18, ASVS 11.4, ADR-029).
 *
 * Rotation used to mean *adding* a key: new writes used it, old values kept decrypting with
 * whichever key wrote them. That is fine for a planned rotation and useless for the case that
 * matters — a key that may have leaked — because the leaked key stays load-bearing for every
 * value it ever wrote. This finishes the job.
 *
 * Both encrypted columns live in FORCE'd tables, where even the owner sees nothing without
 * saying whose rows these are. So the job walks accounts and works *as* each one, inside
 * the same row policies a request would face. That is slower than one sweeping UPDATE, and
 * it is the point: no new privilege exists for this, and no policy was loosened to allow it.
 *
 * Each value is decrypted, re-encrypted, checked to decrypt back to the same plaintext, and
 * written only if the stored value is still the one that was read — so a concurrent write
 * (a seller logging a sale mid-rotation) is never overwritten with stale data.
 */
export interface FieldRotation {
  field: 'break_commitments.server_seed_encrypted' | 'live_sales.buyer_handle_encrypted';
  /** Values found, by the key id that wrote them — before this run changed anything. */
  byKey: Record<string, number>;
  reencrypted: number;
  /** Could not be decrypted with any key in the ring. Left exactly as they were. */
  failed: number;
}

export interface RotationReport {
  activeKid: string;
  dryRun: boolean;
  fields: FieldRotation[];
  /**
   * Key ids still needed after this run: the active key, plus any key that a value which
   * failed (or, in a dry run, would need re-encrypting) still depends on. A key not in this
   * list can be deleted from `DATA_ENCRYPTION_KEYS`.
   */
  stillNeeded: string[];
}

interface Rewriter {
  /** Returns true if the row was updated (it still held `from`). */
  write: (tx: Database, id: string, from: string, to: string) => Promise<boolean>;
}

/** Counted in a Map: key ids come from stored values, and are never used as object keys. */
type Tally = Omit<FieldRotation, 'byKey'> & { counts: Map<string, number> };

function emptyField(field: FieldRotation['field']): Tally {
  return { field, counts: new Map(), reencrypted: 0, failed: 0 };
}

function toReport({ counts, ...rest }: Tally): FieldRotation {
  return { ...rest, byKey: Object.fromEntries(counts) };
}

async function rotateValue(
  ring: KeyRing,
  tx: Database,
  row: { id: string; value: string },
  result: Tally,
  rewriter: Rewriter,
  dryRun: boolean,
  stillNeeded: Set<string>,
): Promise<void> {
  const kid = keyIdOf(row.value) ?? '(unrecognised)';
  result.counts.set(kid, (result.counts.get(kid) ?? 0) + 1);
  if (kid === ring.activeKid) return;

  let plaintext: string;
  try {
    plaintext = decryptField(ring, row.value);
  } catch (error) {
    if (!(error instanceof DecryptionError)) throw error;
    result.failed += 1;
    stillNeeded.add(kid);
    return;
  }
  if (dryRun) {
    stillNeeded.add(kid);
    return;
  }

  const next = encryptField(ring, plaintext);
  // Belt and braces: never write a value we have not just proven we can read back.
  if (decryptField(ring, next) !== plaintext) throw new Error('re-encryption did not round-trip');
  if (await rewriter.write(tx, row.id, row.value, next)) {
    result.reencrypted += 1;
  } else {
    // Changed under us — a new write, which used the active key. Count it where it now is.
    stillNeeded.add(kid);
  }
}

export async function rotateEncryptedFields(
  db: Database,
  ring: KeyRing,
  options: { dryRun?: boolean } = {},
): Promise<RotationReport> {
  const dryRun = options.dryRun ?? false;
  const seeds = emptyField('break_commitments.server_seed_encrypted');
  const handles = emptyField('live_sales.buyer_handle_encrypted');
  const stillNeeded = new Set<string>([ring.activeKid]);

  const seedWriter: Rewriter = {
    write: async (tx, id, from, to) =>
      (
        await tx
          .update(breakCommitments)
          .set({ serverSeedEncrypted: to })
          .where(and(eq(breakCommitments.id, id), eq(breakCommitments.serverSeedEncrypted, from)))
          .returning({ id: breakCommitments.id })
      ).length > 0,
  };
  const handleWriter: Rewriter = {
    write: async (tx, id, from, to) =>
      (
        await tx
          .update(liveSales)
          .set({ buyerHandleEncrypted: to })
          .where(and(eq(liveSales.id, id), eq(liveSales.buyerHandleEncrypted, from)))
          .returning({ id: liveSales.id })
      ).length > 0,
  };

  const accounts = await db.select({ id: users.id }).from(users);
  for (const { id: userId } of accounts) {
    await asUser(db, userId, async (tx) => {
      const seedRows = await tx
        .select({ id: breakCommitments.id, value: breakCommitments.serverSeedEncrypted })
        .from(breakCommitments)
        .innerJoin(breaks, eq(breaks.id, breakCommitments.breakId))
        .where(eq(breaks.creatorId, userId));
      for (const row of seedRows) {
        await rotateValue(ring, tx, row, seeds, seedWriter, dryRun, stillNeeded);
      }

      const handleRows = await tx
        .select({ id: liveSales.id, value: liveSales.buyerHandleEncrypted })
        .from(liveSales)
        .where(and(eq(liveSales.sellerId, userId), isNotNull(liveSales.buyerHandleEncrypted)));
      for (const row of handleRows) {
        if (row.value === null) continue;
        await rotateValue(
          ring,
          tx,
          { id: row.id, value: row.value },
          handles,
          handleWriter,
          dryRun,
          stillNeeded,
        );
      }
    });
  }

  return {
    activeKid: ring.activeKid,
    dryRun,
    fields: [toReport(seeds), toReport(handles)],
    stillNeeded: [...stillNeeded].sort(),
  };
}
