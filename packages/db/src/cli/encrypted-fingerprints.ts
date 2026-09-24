import { createHash } from 'node:crypto';
import { parseEnv } from '@gth/core';
import { buildKeyRing, decryptField } from '@gth/security';
import { z } from 'zod';
import { createDb } from '../client.js';

/**
 * A fingerprint of every encrypted value, without printing any of them (SR-X.18, ADR-029).
 *
 *   pnpm keys:fingerprint
 *
 * Rotation re-encrypts. The only thing that matters afterwards is that the **plaintext** did
 * not change, and that is the one thing you cannot check by looking: the ciphertext is
 * supposed to be different, so "it looks different" tells you nothing, and comparing the
 * plaintexts means having them on a terminal.
 *
 * So: `id  key-id  sha256(plaintext)`, one line per value, sorted. Run it before a rotation and
 * after, and diff. The key ids must change and the hashes must not. A hash that moved means a
 * value was mangled; a row that vanished means one could no longer be read at all.
 *
 * Reads on the migrator connection inside the same row policies a request would face, because
 * both encrypted columns live in FORCE'd tables.
 */
const env = parseEnv(
  z.object({
    DATABASE_URL_MIGRATOR: z.string().startsWith('postgres'),
    DATA_ENCRYPTION_KEYS: z.string().min(2),
    DATA_ENCRYPTION_ACTIVE_KID: z.string().min(1),
  }),
);

const ring = buildKeyRing(env.DATA_ENCRYPTION_KEYS, env.DATA_ENCRYPTION_ACTIVE_KID);
const { db, close } = createDb({ url: env.DATABASE_URL_MIGRATOR, max: 1 });

/** Truncated: enough to detect a change, short enough to read in a diff. */
function fingerprint(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex').slice(0, 16);
}

/**
 * Read as each account in turn, inside the same row policies a request would face.
 *
 * Both encrypted columns live in FORCE'd tables, where **even the owner sees nothing** without
 * declaring whose rows these are. Reading them directly on the migrator connection returns a
 * short list and no error, which for this tool is the worst possible failure: its entire job
 * is to notice a value that has gone, and a value it cannot see has already gone as far as it
 * is concerned. (It did exactly that, and reported two values out of four.)
 *
 * `rotateEncryptedFields` walks accounts for the same reason. This mirrors it deliberately: if
 * the rotation can reach a value, so must the check that the rotation did not break it.
 */
async function everyEncryptedValue(): Promise<{ kind: string; id: string; value: string }[]> {
  const accounts = await db.execute<{ id: string }>(`select id from app.users`);
  const found: { kind: string; id: string; value: string }[] = [];
  for (const { id: userId } of accounts) {
    await db.transaction(async (tx) => {
      await tx.execute(`select set_config('app.user_id', '${userId}', true)`);
      const rows = await tx.execute<{ kind: string; id: string; value: string }>(`
        select 'break_seed' kind, c.id::text id, c.server_seed_encrypted value
          from app.break_commitments c join app.breaks b on b.id = c.break_id
         where b.creator_id = '${userId}'
        union all
        select 'buyer_handle', s.id::text, s.buyer_handle_encrypted
          from app.live_sales s
         where s.seller_id = '${userId}' and s.buyer_handle_encrypted is not null
      `);
      found.push(...rows);
    });
  }
  return found.sort((a, b) => `${a.kind}${a.id}`.localeCompare(`${b.kind}${b.id}`));
}

try {
  const rows = await everyEncryptedValue();

  let unreadable = 0;
  for (const row of rows) {
    const kid = row.value.split(':')[1] ?? '?';
    let mark: string;
    try {
      mark = fingerprint(decryptField(ring, row.value));
    } catch {
      // The point of running this *before* removing a key: a value nobody can read any more
      // is the failure this whole procedure exists to avoid, and it is silent otherwise.
      mark = 'UNREADABLE';
      unreadable += 1;
    }
    console.log(`${row.kind}\t${row.id}\t${kid}\t${mark}`);
  }
  console.log(`# ${String(rows.length)} encrypted values, ${String(unreadable)} unreadable`);
  if (unreadable > 0) process.exitCode = 2;
} finally {
  await close();
}
