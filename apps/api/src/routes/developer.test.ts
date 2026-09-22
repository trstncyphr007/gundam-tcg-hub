import { createAuth } from '@gth/auth';
import { asUser, createDb, seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';
import { publicRoutes } from '../v1/routes.js';
import { TEST_PASSKEY } from '../test/auth-fixtures.js';

const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });

let tdb: TestDatabase;
let app: FastifyInstance;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let alice: string;
let bob: string;
let cardId: string;
/** Stands in for `:handle` the way `cardId` stands in for `:id`. */
const CONTRACT_HANDLE = 'contract-breaker';
const sentLinks: { email: string; url: string }[] = [];

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${String(ipCounter % 250)}`;
}

async function signIn(email: string): Promise<string> {
  const ip = nextIp();
  const before = sentLinks.length;
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/magic-link',
    headers: { origin: 'http://127.0.0.1:3000', 'x-forwarded-for': ip },
    payload: { email, callbackURL: '/' },
  });
  const link = sentLinks.at(before);
  const url = new URL(String(link?.url));
  const verified = await app.inject({
    method: 'GET',
    url: url.pathname + url.search,
    headers: { 'x-forwarded-for': ip },
  });
  const raw = verified.headers['set-cookie'];
  const joined = Array.isArray(raw) ? raw.join('\n') : String(raw);
  return String(/gth\.session_token=[^;\s]+/.exec(joined)?.[0]);
}

async function mintKey(cookie: string, name: string): Promise<{ id: string; key: string }> {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/developer/keys',
    headers: { cookie },
    payload: { name, scopes: ['catalog:read', 'prices:read'] },
  });
  expect(created.statusCode).toBe(201);
  return created.json<{ id: string; key: string }>();
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 2 });

  const cards = await tdb.db.execute<{ id: string }>(
    `select id from app.cards order by number limit 1`,
  );
  cardId = String(cards[0]?.id);

  const auth = createAuth(tdb.db, {
    baseURL: 'http://127.0.0.1:4000',
    secret: 'test-secret-at-least-32-characters-long',
    trustedOrigins: ['http://127.0.0.1:4000', 'http://127.0.0.1:3000'],
    production: false,
    trustProxyHeaders: true,
    passkey: TEST_PASSKEY,
    sendMagicLink: ({ email, url }) => {
      sentLinks.push({ email, url });
      return Promise.resolve();
    },
  });

  app = await buildApp(config, {
    db: tdb.db,
    writeDb: webPool.db,
    keysDb: workerPool.db,
    auth,
  });

  alice = await signIn('dev-alice@example.com');
  bob = await signIn('dev-bob@example.com');

  // A published breaker profile, so the contract test below has something for `:handle` to
  // resolve to. Written as the owner, because `creator_profiles` is FORCE'd: even the table
  // owner cannot insert somebody's public identity without declaring who it belongs to.
  const owners = await tdb.db.execute<{ id: string }>(
    `select id from app.users where email = 'dev-alice@example.com'`,
  );
  const ownerId = String(owners[0]?.id);
  await asUser(tdb.db, ownerId, (tx) =>
    tx.execute(
      `insert into app.creator_profiles (user_id, handle, display_name, published)
       values ('${ownerId}', '${CONTRACT_HANDLE}', 'Contract Breaker', true)
       on conflict do nothing`,
    ),
  );
});

afterAll(async () => {
  await app.close();
  await webPool.close();
  await workerPool.close();
  await tdb.close();
});

describe('self-serve API keys (FR-3.7)', () => {
  it('requires a session on every route', async () => {
    const id = '00000000-0000-0000-0000-000000000000';
    for (const call of [
      { method: 'GET' as const, url: '/v1/developer/keys' },
      { method: 'POST' as const, url: '/v1/developer/keys', payload: { name: 'x', scopes: [] } },
      { method: 'DELETE' as const, url: `/v1/developer/keys/${id}` },
    ]) {
      expect((await app.inject(call)).statusCode, call.url).toBe(401);
    }
  });

  it('shows the secret exactly once', async () => {
    const { id, key } = await mintKey(alice, 'First key');
    expect(key).toMatch(/^gth_test_[a-z0-9]{8}_[A-Za-z0-9_-]{32,}$/);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/developer/keys',
      headers: { cookie: alice },
    });
    const body = list.body;
    // Neither the secret nor anything derived from it comes back a second time.
    expect(body).not.toContain(key);
    // Everything after the prefix, not after the last underscore: the secret is base64url,
    // which has underscores of its own. Splitting on the last one sometimes left a single
    // character — which the prefix could contain — and failed this at random.
    const secret = /^gth_test_[a-z0-9]{8}_(.+)$/.exec(key)?.[1] ?? 'unreachable';
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(body).not.toContain(secret);
    expect(body).not.toContain('keyHash');
    expect(body).not.toContain('key_hash');

    const entry = list
      .json<{ items: { id: string; prefix: string }[] }>()
      .items.find((k) => k.id === id);
    // The prefix is the public half, and is shown so a key can be recognised in a list.
    expect(key).toContain(String(entry?.prefix));
  });

  it('works as a credential on the public API', async () => {
    const { key } = await mintKey(alice, 'Working key');
    const response = await app.inject({
      method: 'GET',
      url: '/v1/cards',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(response.statusCode).toBe(200);
    // A keyed request gets its own allowance, and is told what is left of it.
    expect(response.headers['ratelimit-limit']).toBe('60');
    expect(Number(response.headers['ratelimit-remaining'])).toBeLessThan(60);
  });

  it('rejects a right prefix with a wrong secret', async () => {
    const { key } = await mintKey(alice, 'Prefix probe');
    const [, , prefix] = key.split('_');
    const forged = `gth_test_${String(prefix)}_${'a'.repeat(43)}`;
    const response = await app.inject({
      method: 'GET',
      url: '/v1/cards',
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a malformed key rather than serving it as anonymous', async () => {
    // Someone meant to authenticate and failed. Serving them anyway hides a broken
    // integration from the person who owns it.
    for (const header of ['Bearer nonsense', 'Bearer gth_test_short_x', 'Bearer ']) {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/cards',
        headers: { authorization: header },
      });
      expect(response.statusCode, header).toBe(401);
    }
  });

  it('stops accepting a key the moment it is revoked (AC-3.3)', async () => {
    const { id, key } = await mintKey(alice, 'Short-lived');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/cards',
          headers: { authorization: `Bearer ${key}` },
        })
      ).statusCode,
    ).toBe(200);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/v1/developer/keys/${id}`,
      headers: { cookie: alice },
    });
    expect(revoked.statusCode).toBe(204);

    // Immediately, not within five seconds: there is no cache to expire.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/v1/cards',
          headers: { authorization: `Bearer ${key}` },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('will not mint a key that can write', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/developer/keys',
      headers: { cookie: alice },
      payload: { name: 'Sneaky', scopes: ['ingest:write'] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('keeps one account out of another’s keys (AC-3.2)', async () => {
    const { id } = await mintKey(alice, 'Alice only');

    const bobsList = await app.inject({
      method: 'GET',
      url: '/v1/developer/keys',
      headers: { cookie: bob },
    });
    expect(bobsList.json<{ items: { id: string }[] }>().items.map((k) => k.id)).not.toContain(id);

    // 404, not 403: a 403 would confirm the id is real.
    const stolen = await app.inject({
      method: 'DELETE',
      url: `/v1/developer/keys/${id}`,
      headers: { cookie: bob },
    });
    expect(stolen.statusCode).toBe(404);

    const stillWorks = await app.inject({
      method: 'GET',
      url: '/v1/developer/keys',
      headers: { cookie: alice },
    });
    expect(
      stillWorks
        .json<{ items: { id: string; revokedAt: string | null }[] }>()
        .items.find((k) => k.id === id)?.revokedAt,
    ).toBeNull();
  });

  it('denies the web role the hash column outright (SR-3.1)', async () => {
    // Not a policy, a column privilege: the tier that serves sessions cannot read the
    // material that would let someone forge a key, whatever query it is tricked into running.
    let caught: unknown;
    try {
      await webPool.db.execute(`select key_hash from app.api_keys limit 1`);
    } catch (error) {
      caught = error;
    }
    const messages: string[] = [];
    for (let e: unknown = caught; e instanceof Error; e = e.cause) messages.push(e.message);
    expect(messages.join(' | ')).toMatch(/permission denied/i);

    // ...while the columns it does need are readable.
    await expect(
      webPool.db.execute(`select prefix from app.api_keys limit 1`),
    ).resolves.toBeDefined();
  });
});

describe('quotas (SR-3.2)', () => {
  it('cuts a key off at its per-minute allowance and says when to come back', async () => {
    const { key } = await mintKey(alice, 'Noisy');
    const headers = { authorization: `Bearer ${key}` };

    let last = await app.inject({ method: 'GET', url: '/v1/games', headers });
    for (let i = 0; i < 60 && last.statusCode === 200; i += 1) {
      last = await app.inject({ method: 'GET', url: '/v1/games', headers });
    }

    expect(last.statusCode).toBe(429);
    expect(last.json<{ error: string }>().error).toBe('quota_exceeded');
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    expect(last.headers['ratelimit-remaining']).toBe('0');
  });
});

describe('CORS (SR-3.7)', () => {
  it('opens the public API to any origin, without credentials', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/cards',
      headers: { origin: 'https://someone-elses-site.test' },
    });
    expect(response.headers['access-control-allow-origin']).toBe('*');
    // The wildcard is only safe because no cookie may ride along with it.
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('leaves session routes closed to other origins', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { origin: 'https://someone-elses-site.test', cookie: alice },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not treat a deeper path as part of the public surface', async () => {
    // A prefix check would make /v1/collections/<id>/export look like /v1/collections.
    const response = await app.inject({
      method: 'GET',
      url: '/v1/cards/not-a-uuid/secret',
      headers: { origin: 'https://someone-elses-site.test' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('prices (FR-3.6)', () => {
  it('404s for a card that does not exist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/cards/00000000-0000-0000-0000-000000000000/prices',
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns an empty series rather than a zero price', async () => {
    const response = await app.inject({ method: 'GET', url: `/v1/cards/${cardId}/prices` });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ cardId: string; points: unknown[] }>();
    expect(body.cardId).toBe(cardId);
    // "We have nothing to cite" is a different answer from "it is worth nothing".
    expect(body.points).toEqual([]);
  });

  it('publishes points once the index has them', async () => {
    const variants = await tdb.db.execute<{ id: string }>(
      `select v.id from app.card_variants v where v.card_id = '${cardId}' limit 1`,
    );
    const variantId = String(variants[0]?.id);
    await tdb.db.execute(
      `insert into app.price_index_daily
         (card_variant_id, condition, day, median_cents, p25_cents, p75_cents,
          low_cents, high_cents, observation_count, currency)
       values ('${variantId}', 'nm', current_date, 1500, 1400, 1600, 1200, 9800, 4, 'USD')
       on conflict do nothing`,
    );

    const response = await app.inject({ method: 'GET', url: `/v1/cards/${cardId}/prices` });
    const [point] = response.json<{ points: { medianCents: number; observationCount: number }[] }>()
      .points;
    expect(point?.medianCents).toBe(1500);
    // The honest count, never the weighted expansion of it (ADR-018).
    expect(point?.observationCount).toBe(4);
  });

  it('is cached less aggressively than the catalog, because a stale price is a wrong price', async () => {
    const prices = await app.inject({ method: 'GET', url: `/v1/cards/${cardId}/prices` });
    const cards = await app.inject({ method: 'GET', url: '/v1/cards' });
    expect(prices.headers['cache-control']).toBe('public, max-age=60');
    expect(cards.headers['cache-control']).toBe('public, max-age=300');
  });
});

describe('the contract (plan §24)', () => {
  /**
   * Every documented response is validated against the schema the document was generated
   * from. This is the assertion that makes the spec worth publishing: without it, "the
   * OpenAPI says so" is a claim about a file rather than about the server.
   */
  it.each(publicRoutes.map((route) => [route.path, route] as const))(
    'GET %s returns exactly what it promises',
    async (_path, route) => {
      // Every path parameter needs a real value, or the route answers 400 and this test
      // silently stops checking the schema it was written to check.
      const url = route.path.replaceAll(':id', cardId).replaceAll(':handle', CONTRACT_HANDLE);
      expect(url, 'every path parameter needs a fixture above').not.toContain(':');

      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);

      const parsed = route.response.safeParse(response.json());
      // Print the mismatch rather than a bare false, or a failure here is a scavenger hunt.
      expect(parsed.success ? [] : parsed.error.issues, url).toEqual([]);
    },
  );

  it('sends a cursor that can actually be sent back', async () => {
    const first = await app.inject({ method: 'GET', url: '/v1/cards?limit=1' });
    const { nextCursor } = first.json<{ nextCursor: string | null }>();
    expect(nextCursor).toBeTruthy();

    const second = await app.inject({
      method: 'GET',
      url: `/v1/cards?limit=1&cursor=${String(nextCursor)}`,
    });
    expect(second.statusCode).toBe(200);
    // And it moved: the same row twice would be a cursor that does not cursor.
    expect(second.json<{ items: { id: string }[] }>().items[0]?.id).not.toBe(
      first.json<{ items: { id: string }[] }>().items[0]?.id,
    );
  });

  it('varies on Authorization, so a shared cache cannot hand one caller another’s headers', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/cards' });
    expect(String(response.headers['vary'])).toContain('Authorization');
  });
});

describe('the served document', () => {
  it('serves the spec and the page', async () => {
    const spec = await app.inject({ method: 'GET', url: '/docs/openapi.json' });
    expect(spec.statusCode).toBe(200);
    expect(spec.json<{ openapi: string }>().openapi).toBe('3.1.0');

    const docs = await app.inject({ method: 'GET', url: '/docs' });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers['content-type']).toContain('text/html');
    expect(docs.body).not.toContain('<script');
  });
});
