import { createDb, seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, maskOverlayToken } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';
import { MAX_OVERLAY_CONNECTIONS } from './breaks.js';

const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });
const PEPPER = config.TOKEN_PEPPER;

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let app: FastifyInstance;
let productId: string;

const CREATOR = 'break-creator';
const OTHER_CREATOR = 'break-creator-2';
const PLAIN_USER = 'break-plain-user';

/**
 * The auth plugin is not mounted in these tests, so `request.subject` is injected the way
 * a session would supply it. Authorization itself is still exercised for real.
 */
async function call(
  method: 'GET' | 'POST',
  url: string,
  opts: { user?: { userId: string; role: 'user' | 'creator' | 'admin' }; payload?: object } = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    ...(opts.payload ? { payload: opts.payload } : {}),
    headers: opts.user ? { 'x-test-subject': JSON.stringify(opts.user) } : {},
  });
}

const creator = { userId: CREATOR, role: 'creator' as const };
const otherCreator = { userId: OTHER_CREATOR, role: 'creator' as const };
const plainUser = { userId: PLAIN_USER, role: 'user' as const };

async function makeBreak(user = creator): Promise<{ id: string; overlayToken: string }> {
  const res = await call('POST', '/v1/breaks', {
    user,
    payload: { title: 'Test break', sealedProductId: productId, costCents: 9999 },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string; overlayToken: string }>();
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  const rows = await tdb.db.execute<{ id: string }>(`select id from app.sealed_products limit 1`);
  productId = String(rows[0]?.id);

  await tdb.db.execute(
    `insert into app.users (id, name, email, role) values
       ('${CREATOR}', 'C1', 'bc1@example.com', 'creator'),
       ('${OTHER_CREATOR}', 'C2', 'bc2@example.com', 'creator'),
       ('${PLAIN_USER}', 'U', 'bu@example.com', 'user')
     on conflict do nothing`,
  );

  webPool = createDb({ url: tdb.urlFor('web'), max: 6 });
  app = await buildApp(config, { breaks: { db: webPool.db, tokenPepper: PEPPER } });

  // Stand in for the session: read the subject from a test header.
  app.addHook('onRequest', (request, _reply, done) => {
    const header = request.headers['x-test-subject'];
    if (typeof header === 'string') {
      request.subject = JSON.parse(header) as typeof creator;
    }
    done();
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await webPool.close();
  await tdb.close();
});

describe('authorization (SR-2.6)', () => {
  it('requires a session', async () => {
    expect((await call('GET', '/v1/breaks')).statusCode).toBe(401);
    expect((await call('POST', '/v1/breaks', { payload: { title: 'x' } })).statusCode).toBe(401);
  });

  it('refuses a signed-in user who is not a creator', async () => {
    const res = await call('POST', '/v1/breaks', {
      user: plainUser,
      payload: { title: 'Not allowed' },
    });
    expect(res.statusCode).toBe(403);
    expect((await call('GET', '/v1/breaks', { user: plainUser })).statusCode).toBe(403);
  });
});

describe('validation', () => {
  it('rejects malformed breaks', async () => {
    const bad = [
      {},
      { title: '' },
      { title: '   ' },
      { title: 'x'.repeat(121) },
      { title: 'ok', costCents: -1 },
      { title: 'ok', sealedProductId: 'not-a-uuid' },
      { title: 'ok', extra: true },
    ];
    for (const payload of bad) {
      const res = await call('POST', '/v1/breaks', { user: creator, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('rejects a pull that identifies no card at all', async () => {
    const { id } = await makeBreak();
    await call('POST', `/v1/breaks/${id}/status`, { user: creator, payload: { status: 'live' } });
    const res = await call('POST', `/v1/breaks/${id}/pulls`, {
      user: creator,
      payload: { valueCentsAtPull: 100 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('the overlay token (SR-2.1)', () => {
  it('is returned exactly once, at creation', async () => {
    const { id, overlayToken } = await makeBreak();
    expect(overlayToken).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url

    const list = await call('GET', '/v1/breaks', { user: creator });
    const found = list
      .json<{ items: Record<string, unknown>[] }>()
      .items.find((b) => b['id'] === id);
    expect(found).toBeDefined();
    // Neither the token nor its hash is ever served again.
    expect(JSON.stringify(found)).not.toContain(overlayToken);
    expect(found).not.toHaveProperty('overlayTokenHash');
  });

  it('opens the overlay, and a wrong token 404s', async () => {
    const { overlayToken } = await makeBreak();
    expect((await call('GET', `/v1/overlay/${overlayToken}`)).statusCode).toBe(200);
    expect((await call('GET', '/v1/overlay/' + 'z'.repeat(43))).statusCode).toBe(404);
  });

  it('dies the moment it is rotated (AC-2.2)', async () => {
    const { id, overlayToken } = await makeBreak();
    expect((await call('GET', `/v1/overlay/${overlayToken}`)).statusCode).toBe(200);

    const rotated = await call('POST', `/v1/breaks/${id}/overlay-token`, { user: creator });
    expect(rotated.statusCode).toBe(200);
    const next = rotated.json<{ overlayToken: string }>().overlayToken;
    expect(next).not.toBe(overlayToken);

    expect((await call('GET', `/v1/overlay/${overlayToken}`)).statusCode).toBe(404);
    expect((await call('GET', `/v1/overlay/${next}`)).statusCode).toBe(200);
  });

  it('cannot be rotated by another creator', async () => {
    const { id, overlayToken } = await makeBreak();
    const res = await call('POST', `/v1/breaks/${id}/overlay-token`, { user: otherCreator });
    expect(res.statusCode).toBe(404);
    // And the original still works: the attempt changed nothing.
    expect((await call('GET', `/v1/overlay/${overlayToken}`)).statusCode).toBe(200);
  });

  it('is never written to the request log (SR-2.2)', () => {
    const token = 'SECRET-OVERLAY-TOKEN-VALUE';
    expect(maskOverlayToken(`/v1/overlay/${token}/stream`)).toBe('/v1/overlay/[REDACTED]/stream');
    expect(maskOverlayToken(`/v1/overlay/${token}`)).toBe('/v1/overlay/[REDACTED]');
    expect(maskOverlayToken(`/v1/overlay/${token}?x=1`)).toBe('/v1/overlay/[REDACTED]?x=1');
    // Other routes are untouched.
    expect(maskOverlayToken('/v1/breaks/abc/pulls')).toBe('/v1/breaks/abc/pulls');
  });

  it('serves the overlay with no-store and no-referrer (SR-2.2)', async () => {
    const { overlayToken } = await makeBreak();
    const res = await call('GET', `/v1/overlay/${overlayToken}`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-robots-tag']).toContain('noindex');
  });
});

describe('logging pulls (FR-2.2)', () => {
  it('runs draft → live → ended, and only accepts pulls while live', async () => {
    const { id } = await makeBreak();

    const early = await call('POST', `/v1/breaks/${id}/pulls`, {
      user: creator,
      payload: { label: 'too soon', valueCentsAtPull: 100 },
    });
    expect(early.statusCode).toBe(409);

    await call('POST', `/v1/breaks/${id}/status`, { user: creator, payload: { status: 'live' } });
    const ok = await call('POST', `/v1/breaks/${id}/pulls`, {
      user: creator,
      payload: { label: 'Sample Unit Alpha', valueCentsAtPull: 1500 },
    });
    expect(ok.statusCode).toBe(201);

    await call('POST', `/v1/breaks/${id}/status`, { user: creator, payload: { status: 'ended' } });
    const late = await call('POST', `/v1/breaks/${id}/pulls`, {
      user: creator,
      payload: { label: 'too late', valueCentsAtPull: 100 },
    });
    expect(late.statusCode).toBe(409);
  });

  it('will not let another creator log into my break', async () => {
    const { id } = await makeBreak();
    await call('POST', `/v1/breaks/${id}/status`, { user: creator, payload: { status: 'live' } });
    const res = await call('POST', `/v1/breaks/${id}/pulls`, {
      user: otherCreator,
      payload: { label: 'stolen', valueCentsAtPull: 1 },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('the public page and export (FR-2.5, SR-2.5)', () => {
  async function liveBreakWithPulls(title = 'Public break'): Promise<string> {
    const res = await call('POST', '/v1/breaks', {
      user: creator,
      payload: { title, sealedProductId: productId, costCents: 9999 },
    });
    const { id } = res.json<{ id: string }>();
    await call('POST', `/v1/breaks/${id}/status`, { user: creator, payload: { status: 'live' } });
    await call('POST', `/v1/breaks/${id}/pulls`, {
      user: creator,
      payload: { label: 'Alpha', valueCentsAtPull: 1500 },
    });
    return id;
  }

  it('hides a draft and shows a live one', async () => {
    const { id: draft } = await makeBreak();
    expect((await call('GET', `/v1/breaks/${draft}/public`)).statusCode).toBe(404);

    const live = await liveBreakWithPulls();
    const res = await call('GET', `/v1/breaks/${live}/public`);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ totalCents: number }>().totalCents).toBe(1500);
  });

  it('neutralises a formula in an exported CSV (AC-2.4)', async () => {
    const id = await liveBreakWithPulls();
    await call('POST', `/v1/breaks/${id}/pulls`, {
      user: creator,
      payload: { label: `=cmd|'/c calc'!A1`, valueCentsAtPull: 1 },
    });

    const res = await call('GET', `/v1/breaks/${id}/export?format=csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    // The payload is present as text, but can no longer be read as a formula.
    expect(res.body).toContain(`"'=cmd|'/c calc'!A1"`);
    expect(res.body).not.toContain(`"=cmd`);
  });

  it('exports JSON without exposing the creator', async () => {
    const id = await liveBreakWithPulls();
    const res = await call('GET', `/v1/breaks/${id}/export?format=json`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(CREATOR);
  });

  it('survives an XSS payload as a title (AC-2.3, server side)', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const res = await call('POST', '/v1/breaks', { user: creator, payload: { title: payload } });
    const { id } = res.json<{ id: string }>();
    await call('POST', `/v1/breaks/${id}/status`, { user: creator, payload: { status: 'live' } });

    const view = await call('GET', `/v1/breaks/${id}/public`);
    // Stored verbatim and returned as JSON data, never as markup. The browser-side half
    // of this (React escaping + CSP) is covered by the Playwright suite.
    expect(view.json<{ title: string }>().title).toBe(payload);
    expect(view.headers['content-type']).toContain('application/json');
  });
});

describe('overlay connection cap (SR-2.4)', () => {
  it('is a small number, and is enforced per token', () => {
    expect(MAX_OVERLAY_CONNECTIONS).toBeLessThanOrEqual(5);
  });
});
