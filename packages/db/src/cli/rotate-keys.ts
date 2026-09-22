import { parseEnv } from '@gth/core';
import { buildKeyRing } from '@gth/security';
import { z } from 'zod';
import { createDb } from '../client.js';
import { rotateEncryptedFields } from '../queries/key-rotation.js';

/**
 * Re-encrypt every encrypted field under the active key (SR-X.18, ADR-029).
 *
 *   pnpm keys:rotate --dry-run    # what would change, and which keys are still needed
 *   pnpm keys:rotate              # do it
 *
 * The procedure is in `docs/runbooks/key-rotation.md`: add the new key, make it active,
 * deploy, run this, and only then remove the old key — when this says nothing needs it.
 *
 * Runs on the migrator (owner) connection, but inside the same row policies as a request:
 * it declares each account in turn and only touches that account's rows.
 */
const env = parseEnv(
  z.object({
    DATABASE_URL_MIGRATOR: z.string().startsWith('postgres'),
    DATA_ENCRYPTION_KEYS: z.string().min(2),
    DATA_ENCRYPTION_ACTIVE_KID: z.string().min(1),
  }),
);

const dryRun = process.argv.includes('--dry-run');
const ring = buildKeyRing(env.DATA_ENCRYPTION_KEYS, env.DATA_ENCRYPTION_ACTIVE_KID);
const { db, close } = createDb({ url: env.DATABASE_URL_MIGRATOR, max: 1 });

try {
  const report = await rotateEncryptedFields(db, ring, { dryRun });
  console.log(`${dryRun ? 'DRY RUN — nothing written. ' : ''}active key: ${report.activeKid}`);
  for (const field of report.fields) {
    const keys = Object.entries(field.byKey)
      .map(([kid, n]) => `${kid}=${String(n)}`)
      .join(', ');
    console.log(
      `  ${field.field}: ${keys || 'none'}; re-encrypted ${String(field.reencrypted)}` +
        (field.failed > 0 ? `; FAILED ${String(field.failed)} (left untouched)` : ''),
    );
  }
  const removable = [...ring.keys.keys()].filter((kid) => !report.stillNeeded.includes(kid));
  console.log(`still needed: ${report.stillNeeded.join(', ')}`);
  console.log(
    removable.length > 0
      ? `safe to remove from DATA_ENCRYPTION_KEYS: ${removable.join(', ')}`
      : 'no key can be removed yet',
  );
  if (report.fields.some((f) => f.failed > 0)) process.exitCode = 2;
} finally {
  await close();
}
