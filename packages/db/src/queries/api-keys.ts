import { generateToken, hashToken } from '@gth/security';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { type apiKeyScope, apiKeys } from '../schema/ingest.js';
import { asUser } from './watches.js';

export type ApiKeyScope = (typeof apiKeyScope.enumValues)[number];

/** What a self-serve key may be given. Writing to the platform is not on this list. */
export const SELF_SERVE_SCOPES = [
  'catalog:read',
  'prices:read',
] as const satisfies readonly ApiKeyScope[];

/** Per-account cap. Keys are cheap to make and awkward to keep track of (FR-3.7). */
export const MAX_KEYS_PER_USER = 10;

export class KeyLimitError extends Error {
  constructor() {
    super(`API key limit reached (${String(MAX_KEYS_PER_USER)})`);
    this.name = 'KeyLimitError';
  }
}

/**
 * A key as its owner may see it.
 *
 * There is no `keyHash` field, and that is not an oversight: the web role has no SELECT
 * privilege on that column at all (migration 0017), so this shape is the only shape the
 * database will return. The type and the grant say the same thing.
 */
export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  tier: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

const summaryColumns = {
  id: apiKeys.id,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  scopes: apiKeys.scopes,
  tier: apiKeys.tier,
  lastUsedAt: apiKeys.lastUsedAt,
  revokedAt: apiKeys.revokedAt,
  createdAt: apiKeys.createdAt,
};

/**
 * Build a key: `gth_<env>_<prefix8>_<secret32>` (SR-3.1).
 *
 * The prefix is a public handle so a presented key can be looked up by one indexed equality
 * instead of hashing every row. The secret is 32 bytes of CSPRNG output and is returned to
 * the caller exactly once -- only its keyed hash is ever stored.
 */
export function mintKeyMaterial(production: boolean): {
  prefix: string;
  secret: string;
  plaintext: string;
} {
  const prefix = generateToken(16)
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, '')
    .slice(0, 8);
  const secret = generateToken(32);
  return {
    prefix,
    secret,
    plaintext: `gth_${production ? 'live' : 'test'}_${prefix}_${secret}`,
  };
}

/** The keys an account owns, newest first. Revoked ones stay listed, as a record. */
export async function listApiKeys(db: Database, ownerId: string): Promise<ApiKeySummary[]> {
  return asUser(db, ownerId, (tx) =>
    tx
      .select(summaryColumns)
      .from(apiKeys)
      .where(eq(apiKeys.ownerId, ownerId))
      .orderBy(desc(apiKeys.createdAt)),
  );
}

/**
 * Create a key for an account (FR-3.7).
 *
 * Returns the plaintext alongside the record because this is the only moment it exists. It
 * is never written down, never logged, and cannot be recovered -- a lost key is replaced,
 * not looked up.
 */
export async function createUserApiKey(
  db: Database,
  ownerId: string,
  input: { name: string; scopes: readonly ApiKeyScope[]; pepper: string; production: boolean },
): Promise<{ key: ApiKeySummary; plaintext: string }> {
  const scopes = [...new Set(input.scopes)];
  if (scopes.length === 0) throw new Error('a key needs at least one scope');
  // Belt and braces with the row policy and the CHECK constraint. Three layers because the
  // consequence of a write-scoped self-serve key is someone else's data.
  if (scopes.some((scope) => !SELF_SERVE_SCOPES.includes(scope as never))) {
    throw new Error('that scope cannot be granted to a self-serve key');
  }

  return asUser(db, ownerId, async (tx) => {
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(apiKeys)
      .where(and(eq(apiKeys.ownerId, ownerId), isNull(apiKeys.revokedAt)));
    if (n >= MAX_KEYS_PER_USER) throw new KeyLimitError();

    const material = mintKeyMaterial(input.production);
    const [key] = await tx
      .insert(apiKeys)
      .values({
        // ownerId comes from the session, never from the request body.
        ownerId,
        name: input.name.trim(),
        prefix: material.prefix,
        keyHash: hashToken(material.secret, input.pepper),
        scopes,
      })
      .returning(summaryColumns);
    if (!key) throw new Error('api key insert returned no row');
    return { key, plaintext: material.plaintext };
  });
}

/**
 * Revoke one of this account's keys (FR-3.7).
 *
 * By id rather than prefix: the prefix is the public half of someone's credential, and
 * accepting it here would mean a revoke endpoint that takes a value found in logs and
 * request headers.
 */
export async function revokeUserApiKey(
  db: Database,
  ownerId: string,
  id: string,
): Promise<boolean> {
  return asUser(db, ownerId, async (tx) => {
    const revoked = await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.ownerId, ownerId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    return revoked.length > 0;
  });
}
