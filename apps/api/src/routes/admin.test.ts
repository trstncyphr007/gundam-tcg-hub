import { createAuth } from '@gth/auth';
import { asUser, createDb, seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';
import { TEST_PASSKEY } from '../test/auth-fixtures.js';

const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let app: FastifyInstance;
let admin: string;
let adminId: string;
let creator: string;
let reporterId: string;
let variantId: string;
const sentLinks: { email: string; url: string }[] = [];

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `198.18.0.${String(ipCounter % 250)}`;
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

async function decide(
  cookie: string,
  kind: 'reports' | 'flags',
  id: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/v1/admin/${kind}/${id}/decision`,
    headers: { cookie },
    payload,
  });
}

/** A user report, as a person would file it: unapproved, and counting for nothing. */
async function pendingReport(priceCents = 1500): Promise<string> {
  const rows = await tdb.db.execute<{ id: string }>(`
    insert into app.price_observations
      (card_variant_id, source, condition, price_cents, reporter_id, evidence_ref)
    values ('${variantId}', 'user_report', 'nm', ${String(priceCents)}, '${reporterId}',
            'https://evidence.invalid/receipt')
    returning id
  `);
  return String(rows[0]?.id);
}

/** A first-party live sale that sat far outside the spread: approved, and held back. */
async function flaggedSale(priceCents = 90_000): Promise<string> {
  const rows = await tdb.db.execute<{ id: string }>(`
    insert into app.price_observations
      (card_variant_id, source, condition, price_cents, approved_at, flagged_at, evidence_ref)
    values ('${variantId}', 'live_sale', 'nm', ${String(priceCents)}, now(), now(),
            'https://vod.invalid/1?t=90')
    returning id
  `);
  return String(rows[0]?.id);
}

/** Age every session belonging to `userId`, as though they signed in `hours` ago. */
async function ageSessions(userId: string, hours: number): Promise<void> {
  await tdb.db.execute(
    `update app.sessions set created_at = now() - interval '${String(hours)} hours'
      where user_id = '${userId}'`,
  );
}

/**
 * Mark `userId`'s sessions as opened with a passkey, or not.
 *
 * Standing in for a WebAuthn ceremony, which needs an authenticator this suite does not have.
 * The ceremony itself, and the server recording `passkey` for it, are proven end to end in
 * the browser suite; what this file tests is what the console does with that fact.
 */
async function setAuthMethod(userId: string, method: 'passkey' | 'magic_link'): Promise<void> {
  await tdb.db.execute(
    `update app.sessions set auth_method = '${method}' where user_id = '${userId}'`,
  );
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
    passkey: TEST_PASSKEY,
    sendMagicLink: ({ email, url }) => {
      sentLinks.push({ email, url });
      return Promise.resolve();
    },
  });

  app = await buildApp(config, {
    db: tdb.db,
    writeDb: webPool.db,
    auth,
    moderationDb: workerPool.db,
  });

  admin = await signIn('mod-admin@example.com');
  creator = await signIn('mod-creator@example.com');
  await signIn('mod-reporter@example.com');

  // Admin is granted by an operator with database access, never through the app (SR-X.9).
  await tdb.db.execute(`update app.users set role = 'admin' where email = 'mod-admin@example.com'`);
  await tdb.db.execute(
    `update app.users set role = 'creator' where email = 'mod-creator@example.com'`,
  );

  const ids = await tdb.db.execute<{ id: string; email: string }>(
    `select id, email from app.users where email in
       ('mod-admin@example.com', 'mod-reporter@example.com')`,
  );
  adminId = String(ids.find((r) => r.email === 'mod-admin@example.com')?.id);
  reporterId = String(ids.find((r) => r.email === 'mod-reporter@example.com')?.id);
});

afterAll(async () => {
  await app.close();
  await webPool.close();
  await workerPool.close();
  await tdb.close();
});

beforeEach(async () => {
  await tdb.db.execute(`delete from app.price_observations`);
  // Every test starts from an admin freshly signed in with a passkey; individual tests age
  // the session or downgrade how it was opened.
  await ageSessions(adminId, 0);
  await setAuthMethod(adminId, 'passkey');
});

describe('who may use the console (SR-1.10)', () => {
  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/moderation' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses an account that is not an admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/moderation',
      headers: { cookie: creator },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('forbidden');
  });

  it('refuses an admin whose session came from an email link, however recent (SR-1.10)', async () => {
    await setAuthMethod(adminId, 'magic_link');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/moderation',
      headers: { cookie: admin },
    });
    // Signed in minutes ago — and still one factor: control of an inbox. The answer is
    // "use your passkey", not "sign in again", which would loop through the same inbox.
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('passkey_required');
  });

  it('treats a session with no recorded method as not a passkey', async () => {
    await tdb.db.execute(`update app.sessions set auth_method = null where user_id = '${adminId}'`);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/moderation',
      headers: { cookie: admin },
    });
    // Sessions from before this column existed must never be read as the one that grants.
    expect(res.json<{ error: string }>().error).toBe('passkey_required');
  });

  it('refuses an admin whose sign-in is older than twelve hours', async () => {
    await ageSessions(adminId, 13);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/moderation',
      headers: { cookie: admin },
    });
    // The session is valid — it would still open every other page on the site. It is just
    // not evidence that the account owner is the one holding it today.
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('step_up_required');
  });

  it('tells a stale admin how to fix it, distinctly from a flat refusal', async () => {
    await ageSessions(adminId, 13);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/moderation',
      headers: { cookie: admin },
    });
    const body = res.json<{ error: string; maxAgeSeconds: number }>();
    expect(body.maxAgeSeconds).toBe(12 * 60 * 60);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('accepts an admin who signed in within the window', async () => {
    await ageSessions(adminId, 11);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/moderation',
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
  });

  it('holds the ping to the same rule, so the UI never says yes to a stale session', async () => {
    await ageSessions(adminId, 13);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/ping',
      headers: { cookie: admin },
    });
    expect(res.json<{ error: string }>().error).toBe('step_up_required');
  });

  it('applies the rule to decisions as well as to reading', async () => {
    const id = await pendingReport();
    await ageSessions(adminId, 13);
    const res = await decide(admin, 'reports', id, { decision: 'approve', reason: 'receipt ok' });
    expect(res.statusCode).toBe(403);

    // And nothing happened: a refused decision must not have half-applied.
    const [row] = await tdb.db.execute<{ approved_at: Date | null }>(
      `select approved_at from app.price_observations where id = '${id}'`,
    );
    expect(row?.approved_at).toBeNull();
  });
});

describe('the queue', () => {
  it('lists pending reports and held sales, separately', async () => {
    await pendingReport();
    await flaggedSale();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/moderation',
      headers: { cookie: admin },
    });
    const body = res.json<{ reports: unknown[]; flagged: { evidenceRef: string }[] }>();
    expect(body.reports).toHaveLength(1);
    expect(body.flagged).toHaveLength(1);
    // The VOD link travels with a held sale: the fastest way to tell a typo from a real sale.
    expect(body.flagged[0]?.evidenceRef).toBe('https://vod.invalid/1?t=90');
  });

  it('says nothing about who filed a report', async () => {
    await pendingReport();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/moderation',
      headers: { cookie: admin },
    });
    // Judge the price and its evidence, not the person. What matters about them — how many
    // they have waiting — is carried as a number.
    expect(res.body).not.toContain('mod-reporter@example.com');
    expect(res.body).not.toContain(reporterId);
    expect(res.json<{ reports: { reporterPending: number }[] }>().reports[0]?.reporterPending).toBe(
      1,
    );
  });

  it('is never cached', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/moderation',
      headers: { cookie: admin },
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('deciding a user report (SR-3.5)', () => {
  it('approves it, so it starts to count', async () => {
    const id = await pendingReport();
    const res = await decide(admin, 'reports', id, {
      decision: 'approve',
      reason: 'Receipt matches the listing',
    });
    expect(res.statusCode, res.body).toBe(200);

    const [row] = await tdb.db.execute<{ approved_at: Date | null }>(
      `select approved_at from app.price_observations where id = '${id}'`,
    );
    expect(row?.approved_at).not.toBeNull();
  });

  it('rejects it, and keeps the row', async () => {
    const id = await pendingReport();
    await decide(admin, 'reports', id, { decision: 'reject', reason: 'No evidence of a sale' });

    const [row] = await tdb.db.execute<{ rejected_at: Date | null }>(
      `select rejected_at from app.price_observations where id = '${id}'`,
    );
    expect(row?.rejected_at).not.toBeNull();
  });

  it('answers 409 to a second decision, rather than overwriting the first', async () => {
    const id = await pendingReport();
    await decide(admin, 'reports', id, { decision: 'approve', reason: 'fine' });
    // Another admin, a moment later, disagreeing. The first decision stands and the second
    // is told so, instead of silently flipping a price that may already be published.
    const second = await decide(admin, 'reports', id, { decision: 'reject', reason: 'nope' });
    expect(second.statusCode).toBe(409);
  });

  it('requires a reason (SR-5.9)', async () => {
    const id = await pendingReport();
    for (const reason of ['', '  ', 'ok']) {
      const res = await decide(admin, 'reports', id, { decision: 'approve', reason });
      expect(res.statusCode, `reason ${JSON.stringify(reason)}`).toBe(400);
    }
  });

  it('writes who decided and why to the audit log', async () => {
    const id = await pendingReport();
    await decide(admin, 'reports', id, { decision: 'approve', reason: '  Receipt   matches ' });

    const [entry] = await tdb.db.execute<{ actor_id: string; action: string; diff: unknown }>(
      `select actor_id, action, diff from app.audit_log
        where target_id = '${id}' order by at desc limit 1`,
    );
    expect(entry?.actor_id).toBe(adminId);
    expect(entry?.action).toBe('moderation.report.approve');
    // Stored normalised, so the log reads the way the admin meant it.
    expect(entry?.diff).toMatchObject({ decision: 'approve', reason: 'Receipt matches' });
  });

  it('answers 404 for an id that is not a uuid, and 409 for one that is not pending', async () => {
    expect(
      (await decide(admin, 'reports', 'nope', { decision: 'approve', reason: 'x'.repeat(5) }))
        .statusCode,
    ).toBe(404);
    const missing = await decide(admin, 'reports', '00000000-0000-0000-0000-000000000000', {
      decision: 'approve',
      reason: 'looks right',
    });
    expect(missing.statusCode).toBe(409);
  });

  it('cannot approve a held first-party sale through the report route', async () => {
    // The two queues are different questions. Approving a *report* must not be a way to
    // wave a flagged live sale into the index without clearing the flag.
    const id = await flaggedSale();
    const res = await decide(admin, 'reports', id, { decision: 'approve', reason: 'looks fine' });
    expect(res.statusCode).toBe(409);

    const [row] = await tdb.db.execute<{ flagged_at: Date | null }>(
      `select flagged_at from app.price_observations where id = '${id}'`,
    );
    expect(row?.flagged_at).not.toBeNull();
  });
});

describe('deciding a held sale (SR-4.4)', () => {
  it('clears it, so it starts to count', async () => {
    const id = await flaggedSale();
    const res = await decide(admin, 'flags', id, {
      decision: 'clear',
      reason: 'Watched the VOD, it sold for that',
    });
    expect(res.statusCode, res.body).toBe(200);

    const [row] = await tdb.db.execute<{
      flagged_at: Date | null;
      approved_at: Date | null;
    }>(`select flagged_at, approved_at from app.price_observations where id = '${id}'`);
    expect(row?.flagged_at).toBeNull();
    expect(row?.approved_at).not.toBeNull();
  });

  it('rejects it, and keeps the row', async () => {
    const id = await flaggedSale();
    await decide(admin, 'flags', id, { decision: 'reject', reason: 'Typo: an extra zero' });

    const [row] = await tdb.db.execute<{
      flagged_at: Date | null;
      rejected_at: Date | null;
      approved_at: Date | null;
    }>(
      `select flagged_at, rejected_at, approved_at from app.price_observations where id = '${id}'`,
    );
    expect(row?.rejected_at).not.toBeNull();
    expect(row?.approved_at).toBeNull();
    expect(row?.flagged_at).toBeNull();
  });

  it('answers 409 when it has already been decided', async () => {
    const id = await flaggedSale();
    await decide(admin, 'flags', id, { decision: 'clear', reason: 'checked' });
    expect(
      (await decide(admin, 'flags', id, { decision: 'reject', reason: 'second look' })).statusCode,
    ).toBe(409);
  });
});

describe('the operations dashboard (FR-1.12)', () => {
  const get = (cookie?: string) =>
    app.inject({
      method: 'GET',
      url: '/v1/admin/operations',
      ...(cookie ? { headers: { cookie } } : {}),
    });

  it('is behind the same gates as the console', async () => {
    expect((await get()).statusCode).toBe(401);

    const notAdmin = await get(creator);
    expect(notAdmin.statusCode).toBe(403);
    expect(notAdmin.json<{ error: string }>().error).toBe('forbidden');

    await setAuthMethod(adminId, 'magic_link');
    const emailAdmin = await get(admin);
    expect(emailAdmin.statusCode).toBe(403);
    expect(emailAdmin.json<{ error: string }>().error).toBe('passkey_required');
  });

  it('gives a passkey admin the summary, uncached, naming nobody', async () => {
    const res = await get(admin);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual([
      'deliveries',
      'generatedAt',
      'restocks',
      'retailers',
      'staleListings',
    ]);
    // Aggregates only — and the web pool can read all of it (no row security on these).
    expect(res.body).not.toMatch(/@example\./);
    expect(res.body).not.toContain(adminId);
  });
});

describe('the web role still decides nothing (migration 0027)', () => {
  it('cannot mark a price as counting, even for an admin’s own user id', async () => {
    const id = await pendingReport();
    // What a compromised request path would try: the web pool, a declared admin identity,
    // and a direct UPDATE. The privilege is simply not there.
    let caught: unknown;
    try {
      await asUser(webPool.db, adminId, (tx) =>
        tx.execute(`update app.price_observations set approved_at = now() where id = '${id}'`),
      );
    } catch (error) {
      caught = error;
    }
    const messages: string[] = [];
    for (let e: unknown = caught; e instanceof Error; e = e.cause) messages.push(e.message);
    expect(messages.join(' | ')).toMatch(/permission denied/i);
  });

  it('cannot change a price through the moderation grant either', async () => {
    const id = await pendingReport(1500);
    // The worker may decide whether a row counts. It may not decide what the row says.
    let caught: unknown;
    try {
      await workerPool.db.execute(
        `update app.price_observations set price_cents = 1 where id = '${id}'`,
      );
    } catch (error) {
      caught = error;
    }
    const messages: string[] = [];
    for (let e: unknown = caught; e instanceof Error; e = e.cause) messages.push(e.message);
    expect(messages.join(' | ')).toMatch(/permission denied/i);
  });
});
