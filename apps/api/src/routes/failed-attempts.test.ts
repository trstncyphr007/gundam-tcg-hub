import { AUTH_FAILURE_ACTION, IP_HASH_PATTERN, createAuth } from '@gth/auth';
import { createDb, getSecuritySummary, seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';
import { TEST_PASSKEY } from '../test/auth-fixtures.js';

/**
 * Attempts that failed are written down (SR-X.21, SR-X.22).
 *
 * The audit log recorded successes only, so "two hundred failed sign-ins from one place in
 * ten minutes" was not a fact anything could state — and it is the fact that distinguishes an
 * attack from a typo. The rows must say enough to count, and nothing that would make the log
 * itself worth stealing.
 */
const config: ApiConfig = loadConfig({
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
  API_TRUST_PROXY: 'true',
});
const ORIGIN = 'http://127.0.0.1:3000';
const SECRET_EMAIL = 'someone-private@example.com';

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let app: FastifyInstance;

interface AuditRow extends Record<string, unknown> {
  actor_id: string | null;
  action: string;
  target_id: string | null;
  ip_hash: string | null;
  diff: { status: number; code: string | null } | null;
}

async function failures(): Promise<AuditRow[]> {
  return tdb.db.execute<AuditRow>(
    `select actor_id, action, target_id, ip_hash, diff from app.audit_log
      where action like 'auth.%' and action not in ('auth.user.created', 'auth.session.created')
      order by at`,
  );
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });

  const auth = createAuth(webPool.db, {
    baseURL: 'http://127.0.0.1:4000',
    secret: 'test-secret-at-least-32-characters-long',
    trustedOrigins: ['http://127.0.0.1:4000', ORIGIN],
    production: false,
    trustProxyHeaders: true,
    passkey: TEST_PASSKEY,
    sendMagicLink: () => Promise.resolve(),
  });
  app = await buildApp(config, { db: tdb.db, writeDb: webPool.db, auth });
}, 180_000);

afterAll(async () => {
  await app.close();
  await webPool.close();
  await tdb.close();
});

describe('a refused sign-in', () => {
  it('is recorded, with its source hashed and no address that was tried', async () => {
    // A token that was never issued — what someone guessing looks like.
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/magic-link/verify?token=not-a-real-token&callbackURL=/',
      headers: { 'x-forwarded-for': '198.18.9.9' },
    });
    // A bad link refuses by sending the browser back with a code in the query, not with a
    // 4xx. Pinned here because a version of the recorder that only looked for 4xx wrote
    // nothing at all while looking perfectly correct.
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['location'])).toContain('error=INVALID_TOKEN');

    const rows = await failures();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.action).toBe(AUTH_FAILURE_ACTION);
    // Which door was tried, not whose: no account exists to attribute this to, and inventing
    // one would be the enumeration answer these endpoints exist to withhold (SR-X.4).
    expect(row?.actor_id).toBeNull();
    expect(row?.target_id).toBe('/magic-link/verify');
    // The source is the same day-hash form sessions use, never an address (ADR-028).
    expect(row?.ip_hash).toMatch(IP_HASH_PATTERN);
    expect(JSON.stringify(row)).not.toContain('198.18.9.9');
    // A short code, not a message — messages can carry whatever the caller sent.
    expect(row?.diff?.code ?? '').not.toMatch(/\s/);
  });

  it('never records the address someone tried to sign in as', async () => {
    // Requesting a link for an address answers the same either way; what must not happen is
    // the log quietly keeping the address that was asked about.
    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      headers: { origin: ORIGIN, 'x-forwarded-for': '198.18.9.10' },
      payload: { email: SECRET_EMAIL, callbackURL: '/' },
    });

    const all = await tdb.db.execute<{ row: string }>(
      `select row_to_json(l)::text as row from app.audit_log l`,
    );
    for (const { row } of all) expect(row).not.toContain(SECRET_EMAIL);
  });

  it('shows up in the summary the operations page reads', async () => {
    const summary = await getSecuritySummary(tdb.db);
    const failed = summary.counts.find((c) => c.action === AUTH_FAILURE_ACTION);
    expect(failed?.lastHour).toBeGreaterThanOrEqual(1);
    expect(summary.endpoints.map((e) => e.endpoint)).toContain('/magic-link/verify');
    // Aggregates only: a source is eight characters of a hash that means nothing tomorrow.
    for (const source of summary.noisySources) expect(source.source).toHaveLength(8);
  });
});
