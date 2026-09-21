import { randomBytes } from 'node:crypto';
import { createAuth } from '@gth/auth';
import { asUser, createDb, ingestLiveSales, seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import { buildKeyRing } from '@gth/security';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';

const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let app: FastifyInstance;
let seller: string;
let otherSeller: string;
let viewer: string;
let variantId: string;
/** Needed for cleanup: rows can only be removed by the account that owns them. */
let sellerIds: string[] = [];
const sentLinks: { email: string; url: string }[] = [];
const keyRing = buildKeyRing(JSON.stringify({ k1: randomBytes(32).toString('base64') }), 'k1');

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `192.0.2.${String(ipCounter % 250)}`;
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
  const cookie = /gth\.session_token=[^;\s]+/.exec(joined)?.[0];
  expect(cookie, 'sign-in should set a session cookie').toBeDefined();
  return String(cookie);
}

async function log(
  cookie: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url: '/v1/live-sales', headers: { cookie }, payload });
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);

  const variants = await tdb.db.execute<{ id: string }>(
    `select v.id from app.card_variants v
       join app.cards c on c.id = v.card_id
      where v.finish = 'normal' order by c.number limit 1`,
  );
  variantId = String(variants[0]?.id);

  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 2 });

  const auth = createAuth(tdb.db, {
    baseURL: 'http://127.0.0.1:4000',
    secret: 'test-secret-at-least-32-characters-long',
    trustedOrigins: ['http://127.0.0.1:4000', 'http://127.0.0.1:3000'],
    production: false,
    trustProxyHeaders: true,
    sendMagicLink: ({ email, url }) => {
      sentLinks.push({ email, url });
      return Promise.resolve();
    },
  });

  app = await buildApp(config, {
    db: tdb.db,
    writeDb: webPool.db,
    auth,
    liveSales: { db: webPool.db, keyRing },
  });

  seller = await signIn('live-seller@example.com');
  otherSeller = await signIn('live-other@example.com');
  viewer = await signIn('live-viewer@example.com');
  // Selling is an admin-granted role; there is no self-service path to it.
  await tdb.db.execute(
    `update app.users set role = 'seller'
      where email in ('live-seller@example.com', 'live-other@example.com')`,
  );

  const ids = await tdb.db.execute<{ id: string }>(
    `select id from app.users
      where email in ('live-seller@example.com', 'live-other@example.com')`,
  );
  sellerIds = ids.map((r) => r.id);
});

afterAll(async () => {
  await app.close();
  await webPool.close();
  await workerPool.close();
  await tdb.close();
});

beforeEach(async () => {
  // Observations first: an ingested entry cannot be deleted while it is linked, and deleting
  // the observation is what unlinks it.
  await tdb.db.execute(`delete from app.price_observations`);
  // And as the owner, because `live_sales` is FORCE'd — a delete with no declared user
  // removes nothing at all, silently, and the next test ingests the leftovers.
  for (const id of sellerIds) {
    await asUser(tdb.db, id, (tx) => tx.execute(`delete from app.live_sales`));
  }
});

describe('logging a live sale (FR-4.1)', () => {
  it('requires a session', async () => {
    for (const call of [
      { method: 'GET' as const, url: '/v1/live-sales' },
      { method: 'POST' as const, url: '/v1/live-sales', payload: {} },
      { method: 'DELETE' as const, url: '/v1/live-sales/00000000-0000-0000-0000-000000000000' },
    ]) {
      expect((await app.inject(call)).statusCode, `${call.method} ${call.url}`).toBe(401);
    }
  });

  it('requires the seller role, not merely an account', async () => {
    const res = await log(viewer, { cardVariantId: variantId, priceCents: 1500 });
    expect(res.statusCode).toBe(403);
  });

  it('records a sale and reads it back', async () => {
    const created = await log(seller, {
      cardVariantId: variantId,
      priceCents: 1500,
      buyerHandle: '@alice',
      streamRef: 'https://vod.invalid/1',
    });
    expect(created.statusCode).toBe(201);

    const mine = await app.inject({
      method: 'GET',
      url: '/v1/live-sales',
      headers: { cookie: seller },
    });
    const [entry] = mine.json<{ items: { priceCents: number; buyerHandle: string }[] }>().items;
    expect(entry?.priceCents).toBe(1500);
    expect(entry?.buyerHandle).toBe('alice');
  });

  it('never caches a response carrying buyer handles', async () => {
    await log(seller, { cardVariantId: variantId, priceCents: 1500, buyerHandle: 'alice' });
    const mine = await app.inject({
      method: 'GET',
      url: '/v1/live-sales',
      headers: { cookie: seller },
    });
    // A shared proxy holding a copy of somebody else's customers is exactly the failure.
    expect(mine.headers['cache-control']).toBe('no-store');
  });

  it('shows one seller nothing of another’s stream (AC-3.2 shape, threat T4)', async () => {
    await log(seller, { cardVariantId: variantId, priceCents: 1500, buyerHandle: 'alice' });

    const theirs = await app.inject({
      method: 'GET',
      url: '/v1/live-sales',
      headers: { cookie: otherSeller },
    });
    expect(theirs.json<{ items: unknown[] }>().items).toHaveLength(0);
    expect(theirs.body).not.toContain('alice');
  });

  it('rejects an unknown field rather than ignoring it (SR-X.10)', async () => {
    const res = await log(seller, {
      cardVariantId: variantId,
      priceCents: 1500,
      sellerId: 'somebody-else',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an entry that identifies no card at all', async () => {
    expect((await log(seller, { priceCents: 1500 })).statusCode).toBe(400);
  });

  it('rejects a stream reference that is not https', async () => {
    const res = await log(seller, {
      cardVariantId: variantId,
      priceCents: 1500,
      streamRef: 'http://vod.invalid/1',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a buyer handle carrying control characters', async () => {
    const res = await log(seller, {
      cardVariantId: variantId,
      priceCents: 1500,
      buyerHandle: 'ali\u0000ce',
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps the buyer handle out of the audit log', async () => {
    await log(seller, { cardVariantId: variantId, priceCents: 1500, buyerHandle: 'alice' });
    const rows = await tdb.db.execute(
      `select * from app.audit_log where action = 'live_sale.logged'`,
    );
    // An audit log says what happened. It must not become a second copy of the thing being
    // protected — a decrypted one, in a table with different grants.
    expect(JSON.stringify(rows)).not.toContain('alice');
    expect(JSON.stringify(rows)).toContain('hasBuyerHandle');
  });
});

describe('corrections', () => {
  async function newEntry(cookie: string): Promise<string> {
    const created = await log(cookie, { cardVariantId: variantId, priceCents: 1500 });
    expect(created.statusCode).toBe(201);
    return created.json<{ id: string }>().id;
  }

  it('deletes a mistyped entry before it has reached the index', async () => {
    const id = await newEntry(seller);
    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/live-sales/${id}`,
      headers: { cookie: seller },
    });
    expect(removed.statusCode).toBe(204);
  });

  it('answers 404 for another seller’s entry, the same as for one that does not exist', async () => {
    const id = await newEntry(seller);
    const theirs = await app.inject({
      method: 'DELETE',
      url: `/v1/live-sales/${id}`,
      headers: { cookie: otherSeller },
    });
    const missing = await app.inject({
      method: 'DELETE',
      url: '/v1/live-sales/00000000-0000-0000-0000-000000000000',
      headers: { cookie: otherSeller },
    });
    // Distinguishing them would confirm that another seller's ids exist.
    expect(theirs.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
  });

  it('answers 404 once the entry is in the index, because the number needs its source', async () => {
    const id = await newEntry(seller);
    await ingestLiveSales(workerPool.db);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/live-sales/${id}`,
      headers: { cookie: seller },
    });
    expect(removed.statusCode).toBe(404);
  });
});

describe('the logger is not a way into the index (SR-3.5, threat T7)', () => {
  it('writes no price observation of its own', async () => {
    await log(seller, { cardVariantId: variantId, priceCents: 1500 });

    // The request records a sale and nothing else. Only the worker turns it into evidence,
    // which is what stops a compromised web process asserting a sale we never watched.
    const before = await tdb.db.execute<{ n: number }>(
      `select count(*)::int as n from app.price_observations`,
    );
    expect(before[0]?.n).toBe(0);

    await ingestLiveSales(workerPool.db);
    const after = await tdb.db.execute<{ n: number; source: string }>(
      `select count(*)::int as n, min(source) as source from app.price_observations`,
    );
    expect(after[0]?.n).toBe(1);
    expect(after[0]?.source).toBe('live_sale');
  });
});
