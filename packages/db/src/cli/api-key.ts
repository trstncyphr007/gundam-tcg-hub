import { parseEnv } from '@gth/core';
import { generateToken, hashToken } from '@gth/security';
import { z } from 'zod';
import { createDb } from '../client.js';
import { createApiKey, revokeApiKey } from '../queries/ingest.js';

/**
 * Mint or revoke a machine API key (the scanner's credential).
 *   pnpm keys:create "gundam-scanner"
 *   pnpm keys:revoke <prefix>
 * The secret is printed once and only its keyed hash is stored (SR-3.1).
 */
const { DATABASE_URL_MIGRATOR, TOKEN_PEPPER, NODE_ENV } = parseEnv(
  z.object({
    DATABASE_URL_MIGRATOR: z.string().startsWith('postgres'),
    TOKEN_PEPPER: z.string().min(32),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  }),
);

const [command, argument] = process.argv.slice(2);
const { db, close } = createDb({ url: DATABASE_URL_MIGRATOR, max: 1 });

try {
  if (command === 'create') {
    const name = argument ?? 'unnamed';
    const prefix = generateToken(16)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 8);
    const secret = generateToken(32);
    const environment = NODE_ENV === 'production' ? 'live' : 'test';
    await createApiKey(db, {
      name,
      prefix,
      keyHash: hashToken(secret, TOKEN_PEPPER),
      scopes: ['ingest:write'],
    });
    console.log(`\nAPI key for "${name}" (shown once, store it in the scanner's secrets):\n`);
    console.log(`  gth_${environment}_${prefix}_${secret}\n`);
  } else if (command === 'revoke') {
    if (!argument) throw new Error('usage: revoke <prefix>');
    console.log((await revokeApiKey(db, argument)) ? 'revoked' : 'no active key with that prefix');
  } else {
    console.log('usage: create <name> | revoke <prefix>');
    process.exitCode = 1;
  }
} finally {
  await close();
}
