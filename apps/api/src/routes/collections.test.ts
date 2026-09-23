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
let variantId: string;
let otherVariantId: string;
let alice: string;
let bob: string;
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

async function newCollection(cookie: string, name: string): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/collections',
    headers: { cookie },
    payload: { name },
  });
  expect(created.statusCode).toBe(201);
  return created.json<{ id: string }>().id;
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  const variants = await tdb.db.execute<{ id: string }>(
    `select v.id from app.card_variants v
       join app.cards c on c.id = v.card_id
      where v.finish = 'normal' order by c.number`,
  );
  variantId = String(variants[0]?.id);
  otherVariantId = String(variants[1]?.id);

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

  alice = await signIn('alice@example.com');
  bob = await signIn('bob@example.com');
});

afterAll(async () => {
  await app.close();
  await tdb.close();
});

describe('collection endpoints (FR-3.4)', () => {
  it('requires authentication for anything that writes', async () => {
    const id = '00000000-0000-0000-0000-000000000000';
    for (const call of [
      { method: 'GET' as const, url: '/v1/collections' },
      { method: 'POST' as const, url: '/v1/collections', payload: { name: 'x' } },
      { method: 'PATCH' as const, url: `/v1/collections/${id}`, payload: { name: 'x' } },
      { method: 'DELETE' as const, url: `/v1/collections/${id}` },
      { method: 'POST' as const, url: `/v1/collections/${id}/items`, payload: {} },
      { method: 'POST' as const, url: `/v1/collections/${id}/import` },
    ]) {
      expect((await app.inject(call)).statusCode, `${call.method} ${call.url}`).toBe(401);
    }
  });

  it('creates, reads and deletes', async () => {
    const id = await newCollection(alice, 'Binder');

    const read = await app.inject({
      method: 'GET',
      url: `/v1/collections/${id}`,
      headers: { cookie: alice },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ visibility: string }>().visibility).toBe('private');

    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/v1/collections/${id}`,
          headers: { cookie: alice },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/collections/${id}`,
          headers: { cookie: alice },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('rejects an unknown field rather than ignoring it', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/collections',
      headers: { cookie: alice },
      payload: { name: 'Binder', ownerId: 'somebody-else' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: string }>().error).toBe('invalid_request');
  });
});

describe('a card that is not there', () => {
  it('is a 404, not a 500', async () => {
    // The same shape as the watches case: a well-formed id for a row that has gone. The
    // foreign key is the right guard, but its error must not reach the caller as
    // `internal_error` — that says we broke, tells them nothing, and is a 5xx the API
    // fuzzing gate exists to catch (AC-3.4).
    const id = await newCollection(alice, 'Missing card');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/collections/${id}/items`,
      headers: { cookie: alice },
      payload: { cardVariantId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.statusCode, res.body).toBe(404);
  });
});

describe('the two-user IDOR matrix over HTTP (AC-3.2, SR-3.3)', () => {
  it('answers 404 for someone else’s private collection, on every route', async () => {
    const id = await newCollection(alice, 'Alice private');
    const item = await app.inject({
      method: 'POST',
      url: `/v1/collections/${id}/items`,
      headers: { cookie: alice },
      payload: { cardVariantId: variantId },
    });
    const itemId = item.json<{ id: string }>().id;

    // 404 rather than 403 everywhere: a 403 would confirm the id exists.
    for (const call of [
      { method: 'GET' as const, url: `/v1/collections/${id}` },
      { method: 'GET' as const, url: `/v1/collections/${id}/value` },
      { method: 'GET' as const, url: `/v1/collections/${id}/export` },
      { method: 'PATCH' as const, url: `/v1/collections/${id}`, payload: { name: 'stolen' } },
      { method: 'DELETE' as const, url: `/v1/collections/${id}` },
      {
        method: 'POST' as const,
        url: `/v1/collections/${id}/items`,
        payload: { cardVariantId: otherVariantId },
      },
      {
        method: 'PATCH' as const,
        url: `/v1/collections/${id}/items/${itemId}`,
        payload: { quantity: 99 },
      },
      { method: 'DELETE' as const, url: `/v1/collections/${id}/items/${itemId}` },
    ]) {
      const response = await app.inject({ ...call, headers: { cookie: bob } });
      expect(response.statusCode, `${call.method} ${call.url}`).toBe(404);
    }

    // And nothing changed.
    const after = await app.inject({
      method: 'GET',
      url: `/v1/collections/${id}`,
      headers: { cookie: alice },
    });
    expect(after.json<{ name: string; items: unknown[] }>().name).toBe('Alice private');
    expect(after.json<{ items: unknown[] }>().items).toHaveLength(1);
  });

  it('lets Bob read a public collection but not write it', async () => {
    const id = await newCollection(alice, 'Alice public');
    await app.inject({
      method: 'PATCH',
      url: `/v1/collections/${id}`,
      headers: { cookie: alice },
      payload: { visibility: 'public' },
    });

    expect(
      (await app.inject({ method: 'GET', url: `/v1/collections/${id}`, headers: { cookie: bob } }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/collections/${id}/items`,
          headers: { cookie: bob },
          payload: { cardVariantId: variantId },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('sharing (FR-3.4, SR-3.8)', () => {
  it('never sends a visitor what the owner paid', async () => {
    const id = await newCollection(alice, 'Shared prices');
    await app.inject({
      method: 'POST',
      url: `/v1/collections/${id}/items`,
      headers: { cookie: alice },
      payload: {
        cardVariantId: variantId,
        quantity: 2,
        acquiredPriceCents: 1000,
        notes: 'traded for it at locals',
      },
    });
    await app.inject({
      method: 'PATCH',
      url: `/v1/collections/${id}`,
      headers: { cookie: alice },
      payload: { visibility: 'public' },
    });

    const asVisitor = await app.inject({ method: 'GET', url: `/v1/collections/${id}` });
    const item = asVisitor.json<{ items: Record<string, unknown>[] }>().items[0];
    expect(item?.['quantity']).toBe(2);
    expect(item?.['acquiredPriceCents']).toBeNull();
    expect(item?.['notes']).toBeNull();
    // Belt and braces: the note must not appear anywhere in the response body.
    expect(asVisitor.body).not.toContain('traded for it at locals');

    const value = await app.inject({ method: 'GET', url: `/v1/collections/${id}/value` });
    expect(value.json<{ costBasisCents: number; gainLossCents: number }>()).toMatchObject({
      costBasisCents: 0,
      gainLossCents: 0,
    });

    const exported = await app.inject({ method: 'GET', url: `/v1/collections/${id}/export` });
    expect(exported.body).not.toContain('10.00');

    // The owner still sees all of it.
    const asOwner = await app.inject({
      method: 'GET',
      url: `/v1/collections/${id}`,
      headers: { cookie: alice },
    });
    expect(asOwner.body).toContain('traded for it at locals');
  });

  it('shows a shared collection to a signed-out visitor without naming its owner', async () => {
    const id = await newCollection(alice, 'Shared');
    await app.inject({
      method: 'PATCH',
      url: `/v1/collections/${id}`,
      headers: { cookie: alice },
      payload: { visibility: 'unlisted' },
    });

    const anonymous = await app.inject({ method: 'GET', url: `/v1/collections/${id}` });
    expect(anonymous.statusCode).toBe(200);
    const body = anonymous.json<Record<string, unknown>>();
    expect(body['name']).toBe('Shared');
    // A public collection shows a name and cards, never who owns it.
    expect(body['ownerId']).toBeUndefined();

    const owner = await app.inject({
      method: 'GET',
      url: `/v1/collections/${id}`,
      headers: { cookie: alice },
    });
    expect(owner.json<Record<string, unknown>>()['ownerId']).toBeDefined();
  });

  it('keeps an unlisted collection out of the public list', async () => {
    const unlisted = await newCollection(alice, 'Not listed');
    const listed = await newCollection(alice, 'Listed');
    for (const [id, visibility] of [
      [unlisted, 'unlisted'],
      [listed, 'public'],
    ] as const) {
      await app.inject({
        method: 'PATCH',
        url: `/v1/collections/${id}`,
        headers: { cookie: alice },
        payload: { visibility },
      });
    }

    const list = await app.inject({ method: 'GET', url: '/v1/collections/public' });
    const names = list.json<{ items: { name: string }[] }>().items.map((c) => c.name);
    expect(names).toContain('Listed');
    expect(names).not.toContain('Not listed');
  });
});

describe('CSV over HTTP (FR-3.5, AC-3.5)', () => {
  it('exports as an attachment, not something the browser will render', async () => {
    const id = await newCollection(alice, 'Export me');
    await app.inject({
      method: 'POST',
      url: `/v1/collections/${id}/items`,
      headers: { cookie: alice },
      payload: { cardVariantId: variantId, quantity: 2, acquiredPriceCents: 1250 },
    });

    const exported = await app.inject({
      method: 'GET',
      url: `/v1/collections/${id}/export`,
      headers: { cookie: alice },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    expect(String(exported.headers['content-disposition'])).toContain('attachment');
    expect(exported.body).toContain('"12.50"');
  });

  it('previews an import without applying it, then applies it', async () => {
    const id = await newCollection(alice, 'Import me');
    const csv = 'set,number,quantity\nSAMPLE-01,001,3\n';

    const preview = await app.inject({
      method: 'POST',
      url: `/v1/collections/${id}/import`,
      headers: { cookie: alice, 'content-type': 'text/csv' },
      payload: csv,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json<{ dryRun: boolean; valid: number }>()).toMatchObject({
      dryRun: true,
      valid: 1,
      created: 0,
    });

    const applied = await app.inject({
      method: 'POST',
      url: `/v1/collections/${id}/import?apply=true`,
      headers: { cookie: alice, 'content-type': 'text/csv' },
      payload: csv,
    });
    expect(applied.json<{ created: number }>().created).toBe(1);

    const read = await app.inject({
      method: 'GET',
      url: `/v1/collections/${id}`,
      headers: { cookie: alice },
    });
    expect(read.json<{ items: { quantity: number }[] }>().items[0]?.quantity).toBe(3);
  });

  it('answers 200 with a per-row report when only some rows are good', async () => {
    // A partially valid file is a normal outcome. A 400 would throw away the detail the
    // person needs in order to fix it.
    const id = await newCollection(alice, 'Half good');
    const response = await app.inject({
      method: 'POST',
      url: `/v1/collections/${id}/import`,
      headers: { cookie: alice, 'content-type': 'text/csv' },
      payload: 'set,number,quantity\nSAMPLE-01,001,1\nSAMPLE-01,999,1\n',
    });
    expect(response.statusCode).toBe(200);
    const report = response.json<{ valid: number; errors: { row: number }[] }>();
    expect(report.valid).toBe(1);
    expect(report.errors[0]?.row).toBe(3);
  });

  it('rejects a body that is not CSV', async () => {
    const id = await newCollection(alice, 'Not csv');
    const response = await app.inject({
      method: 'POST',
      url: `/v1/collections/${id}/import`,
      headers: { cookie: alice, 'content-type': 'application/json' },
      payload: { set: 'SAMPLE-01' },
    });
    expect(response.statusCode).toBe(415);
  });

  it('refuses a body over the 2 MB cap before parsing it', async () => {
    const id = await newCollection(alice, 'Too big');
    const response = await app.inject({
      method: 'POST',
      url: `/v1/collections/${id}/import`,
      headers: { cookie: alice, 'content-type': 'text/csv' },
      payload: `set,number,quantity\n${'x'.repeat(3 * 1024 * 1024)},001,1\n`,
    });
    expect(response.statusCode).toBe(413);
  });
});

describe('valuation over HTTP (FR-3.4)', () => {
  it('reports the cards it could not value instead of calling them zero', async () => {
    const id = await newCollection(alice, 'Valued');
    await app.inject({
      method: 'POST',
      url: `/v1/collections/${id}/items`,
      headers: { cookie: alice },
      payload: { cardVariantId: variantId, quantity: 2 },
    });

    const value = await app.inject({
      method: 'GET',
      url: `/v1/collections/${id}/value`,
      headers: { cookie: alice },
    });
    expect(value.statusCode).toBe(200);
    expect(value.json<{ currentValueCents: number; unpricedCards: number }>()).toMatchObject({
      currentValueCents: 0,
      unpricedCards: 2,
    });
  });
});
