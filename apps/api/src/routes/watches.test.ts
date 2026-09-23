import { createAuth } from '@gth/auth';
import { seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';
import { TEST_PASSKEY } from '../test/auth-fixtures.js';

const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });

let tdb: TestDatabase;
let app: FastifyInstance;
let productId: string;
let listingId: string;
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
  const cookie = /gth\.session_token=[^;\s]+/.exec(joined)?.[0];
  expect(cookie, 'sign-in should set a session cookie').toBeDefined();
  return String(cookie);
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  const products = await tdb.db.execute<{ id: string }>(
    `select id from app.sealed_products limit 1`,
  );
  productId = String(products[0]?.id);
  const listings = await tdb.db.execute<{ id: string }>(
    `select id from app.retailer_products limit 1`,
  );
  listingId = String(listings[0]?.id);

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
  app = await buildApp(config, { db: tdb.db, writeDb: tdb.db, auth });
});

afterAll(async () => {
  await app.close();
  await tdb.close();
});

describe('watch endpoints', () => {
  it('requires authentication', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/watches' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/watches',
          payload: { sealedProductId: productId, channels: ['email'] },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/v1/watches/00000000-0000-0000-0000-000000000000',
        })
      ).statusCode,
    ).toBe(401);
  });

  it('creates, lists and deletes a watch', async () => {
    const cookie = await signIn('watcher@example.com');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/watches',
      headers: { cookie },
      payload: { sealedProductId: productId, channels: ['email', 'discord_dm'] },
    });
    expect(created.statusCode).toBe(201);
    const watch = created.json<{ id: string; userId: string; channels: string[] }>();
    expect(watch.channels).toEqual(['email', 'discord_dm']);

    const list = await app.inject({ method: 'GET', url: '/v1/watches', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(1);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/watches/${watch.id}`,
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/watches', headers: { cookie } })).json<{
        items: unknown[];
      }>().items,
    ).toHaveLength(0);
  });

  it('refuses a duplicate watch', async () => {
    const cookie = await signIn('dupe@example.com');
    const payload = { retailerProductId: listingId, channels: ['email'] };
    expect(
      (await app.inject({ method: 'POST', url: '/v1/watches', headers: { cookie }, payload }))
        .statusCode,
    ).toBe(201);
    const again = await app.inject({
      method: 'POST',
      url: '/v1/watches',
      headers: { cookie },
      payload,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: string }>().error).toBe('watch_exists');
  });

  it('answers 404 for a product that is not there, not 500', async () => {
    // A catalogue page open in a tab outlives the product behind it, so a well-formed id for
    // a row that has gone is ordinary traffic — not a server fault. The foreign key used to
    // reach the route as a driver error and come back as `internal_error`, which says we
    // broke, tells the caller nothing, and is a 5xx the API fuzzing gate exists to catch.
    const cookie = await signIn('gone-product@example.com');
    for (const payload of [
      { sealedProductId: '00000000-0000-4000-8000-000000000000', channels: ['email'] },
      { retailerProductId: '00000000-0000-4000-8000-000000000001', channels: ['email'] },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/watches',
        headers: { cookie },
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(404);
      expect(res.json<{ error: string }>().error).toBe('not_found');
    }
  });

  it('validates the payload', async () => {
    const cookie = await signIn('validate-watch@example.com');
    const bad: Record<string, unknown>[] = [
      {}, // no target, no channels
      { sealedProductId: productId }, // no channels
      { sealedProductId: productId, channels: [] }, // empty channels
      { sealedProductId: productId, channels: ['sms'] }, // unknown channel
      { sealedProductId: 'not-a-uuid', channels: ['email'] },
      { sealedProductId: productId, retailerProductId: listingId, channels: ['email'] }, // both
      { sealedProductId: productId, channels: ['email'], userId: 'someone-else' }, // extra field
    ];
    for (const payload of bad) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/watches',
        headers: { cookie },
        payload,
      });
      expect(res.statusCode, `should reject ${JSON.stringify(payload)}`).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('invalid_request');
    }
  });
});

describe('cross-user isolation (IDOR, threat T4)', () => {
  it('never shows or deletes another user’s watch', async () => {
    const alice = await signIn('alice-api@example.com');
    const bob = await signIn('bob-api@example.com');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/watches',
      headers: { cookie: alice },
      payload: { sealedProductId: productId, channels: ['email'] },
    });
    expect(created.statusCode).toBe(201);
    const aliceWatchId = created.json<{ id: string }>().id;

    // Bob cannot see it...
    const bobList = await app.inject({
      method: 'GET',
      url: '/v1/watches',
      headers: { cookie: bob },
    });
    expect(bobList.json<{ items: unknown[] }>().items).toHaveLength(0);

    // ...and cannot delete it by id. 404, not 403: don't confirm the id exists.
    const bobDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/watches/${aliceWatchId}`,
      headers: { cookie: bob },
    });
    expect(bobDelete.statusCode).toBe(404);

    // Alice's watch is untouched.
    const aliceList = await app.inject({
      method: 'GET',
      url: '/v1/watches',
      headers: { cookie: alice },
    });
    expect(aliceList.json<{ items: { id: string }[] }>().items[0]?.id).toBe(aliceWatchId);
  });

  it('ignores a forged owner id in the body', async () => {
    const victim = await signIn('victim@example.com');
    const attacker = await signIn('attacker@example.com');

    const victimId = (
      await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: victim } })
    ).json<{ id: string }>().id;

    // Extra fields are rejected outright...
    const withOwner = await app.inject({
      method: 'POST',
      url: '/v1/watches',
      headers: { cookie: attacker },
      payload: { sealedProductId: productId, channels: ['email'], userId: victimId },
    });
    expect(withOwner.statusCode).toBe(400);

    // ...and a legitimate create is owned by the attacker, not the victim.
    const created = await app.inject({
      method: 'POST',
      url: '/v1/watches',
      headers: { cookie: attacker },
      payload: { sealedProductId: productId, channels: ['email'] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ userId: string }>().userId).not.toBe(victimId);

    const victimList = await app.inject({
      method: 'GET',
      url: '/v1/watches',
      headers: { cookie: victim },
    });
    expect(victimList.json<{ items: unknown[] }>().items).toHaveLength(0);
  });
});
