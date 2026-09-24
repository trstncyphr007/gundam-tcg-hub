import { PHOTO_REQUIRED_ABOVE_CENTS } from '@gth/core';
import { createAuth } from '@gth/auth';
import { createDb, seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';
import { TEST_PASSKEY } from '../test/auth-fixtures.js';

/**
 * Selling a card, over HTTP (FR-5.2).
 *
 * The two-user matrix AC-3.2 asks for, applied to listings: for every route that touches one,
 * a second signed-in person gets nothing — and the row is unchanged afterwards, not merely the
 * request refused. "It returned 404" and "it did not happen" are different claims.
 */
const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });
const ORIGIN = 'http://127.0.0.1:3000';

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let app: FastifyInstance;
let variantId = '';
let seller = '';
let other = '';
const sentLinks: { email: string; url: string }[] = [];

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.101.${String(ipCounter % 250)}`;
}

async function signIn(email: string): Promise<string> {
  const ip = nextIp();
  const before = sentLinks.length;
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/magic-link',
    headers: { origin: ORIGIN, 'x-forwarded-for': ip },
    payload: { email, callbackURL: '/' },
  });
  const url = new URL(String(sentLinks.at(before)?.url));
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

const draft = (over: Record<string, unknown> = {}) => ({
  cardVariantId: variantId,
  condition: 'nm',
  priceCents: 1000,
  quantity: 1,
  ...over,
});

async function create(cookie: string, over = {}): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/v1/listings',
    headers: { cookie, origin: ORIGIN },
    payload: draft(over),
  });
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  const [variant] = await tdb.db.execute<{ id: string }>(
    `select id from app.card_variants limit 1`,
  );
  variantId = String(variant?.id);

  const auth = createAuth(tdb.db, {
    baseURL: 'http://127.0.0.1:4000',
    secret: 'test-secret-at-least-32-characters-long',
    trustedOrigins: ['http://127.0.0.1:4000', ORIGIN],
    production: false,
    trustProxyHeaders: true,
    passkey: TEST_PASSKEY,
    sendMagicLink: ({ email, url }) => {
      sentLinks.push({ email, url });
      return Promise.resolve();
    },
  });
  // `writeDb` is the app_web pool, as it is in production. The listings policies are scoped
  // `TO app_web`, so a test that wrote as the migrator would be testing a role no request ever
  // runs on — and would have been refused by RLS anyway, which is how this was noticed.
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  app = await buildApp(config, { db: tdb.db, writeDb: webPool.db, auth });

  seller = await signIn('market-seller@example.com');
  other = await signIn('market-other@example.com');
}, 180_000);

afterAll(async () => {
  await app.close();
  await webPool.close();
  await tdb.close();
});

beforeEach(async () => {
  await tdb.db.execute(`truncate app.orders, app.listings cascade`);
});

describe('a listing needs a session', () => {
  it('refuses every route without one', async () => {
    for (const [method, url] of [
      ['GET', '/v1/listings'],
      ['POST', '/v1/listings'],
      ['GET', '/v1/listings/00000000-0000-4000-8000-000000000000'],
      ['PATCH', '/v1/listings/00000000-0000-4000-8000-000000000000'],
      ['POST', '/v1/listings/00000000-0000-4000-8000-000000000000/status'],
      ['DELETE', '/v1/listings/00000000-0000-4000-8000-000000000000'],
    ] as const) {
      const res = await app.inject({ method, url, headers: { origin: ORIGIN }, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe('creating one', () => {
  it('starts as a draft owned by the caller', async () => {
    const res = await create(seller);
    expect(res.statusCode).toBe(201);
    expect(res.json<{ status: string }>().status).toBe('draft');

    const mine = await app.inject({
      method: 'GET',
      url: '/v1/listings',
      headers: { cookie: seller },
    });
    expect(mine.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it('will not take a seller id from the body', async () => {
    // `.strict()` refuses the field outright rather than ignoring it, so a client that thinks
    // it can choose an owner is told no instead of quietly getting its own.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/listings',
      headers: { cookie: seller, origin: ORIGIN },
      payload: { ...draft(), sellerId: 'somebody-else' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('answers 404 for a card that does not exist, not 500', async () => {
    // The shape #64 found six times: an id too well-formed to reject and too absent to use.
    const res = await create(seller, { cardVariantId: '00000000-0000-4000-8000-000000000000' });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a price outside the range with a code a form can use', async () => {
    const res = await create(seller, { priceCents: 0 });
    expect(res.statusCode).toBe(400);
  });
});

describe('another person', () => {
  it('cannot see, change, publish or delete it', async () => {
    const id = (await create(seller)).json<{ id: string }>().id;

    const attempts: [string, LightMyRequestResponse][] = [
      [
        'get',
        await app.inject({ method: 'GET', url: `/v1/listings/${id}`, headers: { cookie: other } }),
      ],
      [
        'patch',
        await app.inject({
          method: 'PATCH',
          url: `/v1/listings/${id}`,
          headers: { cookie: other, origin: ORIGIN },
          payload: { priceCents: 1, quantity: 1 },
        }),
      ],
      [
        'publish',
        await app.inject({
          method: 'POST',
          url: `/v1/listings/${id}/status`,
          headers: { cookie: other, origin: ORIGIN },
          payload: { status: 'active' },
        }),
      ],
      [
        'delete',
        await app.inject({
          method: 'DELETE',
          url: `/v1/listings/${id}`,
          headers: { cookie: other, origin: ORIGIN },
        }),
      ],
    ];
    for (const [name, res] of attempts) expect(res.statusCode, name).toBe(404);

    // And nothing happened to it, which is the claim that matters.
    const after = await app.inject({
      method: 'GET',
      url: `/v1/listings/${id}`,
      headers: { cookie: seller },
    });
    expect(after.json<{ priceCents: number; status: string }>()).toMatchObject({
      priceCents: 1000,
      status: 'draft',
    });
  });

  it('does not see it in their own list', async () => {
    await create(seller);
    const theirs = await app.inject({
      method: 'GET',
      url: '/v1/listings',
      headers: { cookie: other },
    });
    expect(theirs.json<{ items: unknown[] }>().items).toHaveLength(0);
  });
});

describe('going on sale', () => {
  const publish = (cookie: string, id: string) =>
    app.inject({
      method: 'POST',
      url: `/v1/listings/${id}/status`,
      headers: { cookie, origin: ORIGIN },
      payload: { status: 'active' },
    });

  it('works below the photo threshold', async () => {
    const id = (await create(seller, { priceCents: PHOTO_REQUIRED_ABOVE_CENTS })).json<{
      id: string;
    }>().id;
    const res = await publish(seller, id);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('active');
  });

  it('is refused above it until there are photos', async () => {
    // Slice 4 gives it photos to count. Until then everything over $25 is unpublishable,
    // which is the correct answer rather than a placeholder.
    const id = (await create(seller, { priceCents: PHOTO_REQUIRED_ABOVE_CENTS + 1 })).json<{
      id: string;
    }>().id;
    const res = await publish(seller, id);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('photos_required');
  });

  it('will not accept `sold` from a seller', async () => {
    // The schema refuses it, the database refuses it, and the state machine says why. Three
    // layers, because this one decides whether somebody has been paid.
    const id = (await create(seller)).json<{ id: string }>().id;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/listings/${id}/status`,
      headers: { cookie: seller, origin: ORIGIN },
      payload: { status: 'sold' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('removing one', () => {
  it('deletes a draft and refuses one that has been on sale', async () => {
    const live = (await create(seller)).json<{ id: string }>().id;
    await app.inject({
      method: 'POST',
      url: `/v1/listings/${live}/status`,
      headers: { cookie: seller, origin: ORIGIN },
      payload: { status: 'active' },
    });
    const refused = await app.inject({
      method: 'DELETE',
      url: `/v1/listings/${live}`,
      headers: { cookie: seller, origin: ORIGIN },
    });
    expect(refused.statusCode).toBe(404);

    const drafted = (await create(seller)).json<{ id: string }>().id;
    const gone = await app.inject({
      method: 'DELETE',
      url: `/v1/listings/${drafted}`,
      headers: { cookie: seller, origin: ORIGIN },
    });
    expect(gone.statusCode).toBe(204);
  });
});

describe('the audit log', () => {
  it('records who listed what', async () => {
    // SR-X.21: a listing is a thing somebody offered to sell. Who and when is worth keeping.
    const id = (await create(seller)).json<{ id: string }>().id;
    const rows = await tdb.db.execute<{ action: string; target_id: string }>(
      `select action, target_id from app.audit_log where action like 'listing.%' order by at`,
    );
    expect(rows.map((r) => r.action)).toContain('listing.created');
    expect(rows.some((r) => r.target_id === id)).toBe(true);
  });
});
