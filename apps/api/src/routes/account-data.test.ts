import { IP_HASH_PATTERN, type SecurityNotice, createAuth } from '@gth/auth';
import { createDb, seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';
import { TEST_PASSKEY } from '../test/auth-fixtures.js';

/**
 * Taking your data away, and deleting it (SR-X.25, ADR-027).
 */
const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });
const ORIGIN = 'http://127.0.0.1:3000';

/** Markers that must never appear in an export: a buyer's handle and a key's hash. */
const BUYER_CIPHERTEXT = 'v1:k1:BUYER-HANDLE-CIPHERTEXT';
const KEY_HASH = 'KEY-HASH-THAT-MUST-NOT-LEAVE';

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let app: FastifyInstance;
const sentLinks: { email: string; url: string }[] = [];
const notices: SecurityNotice[] = [];
let productId: string;
let variantId: string;

let counter = 0;
function next(): number {
  counter += 1;
  return counter;
}

async function signIn(email: string): Promise<string> {
  const ip = `198.18.9.${String(next() % 250)}`;
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

async function userIdOf(email: string): Promise<string> {
  const rows = await tdb.db.execute<{ id: string }>(
    `select id from app.users where email = '${email}'`,
  );
  return String(rows[0]?.id);
}

/** Run statements on the web pool as `userId` — the same path, grants and policies as a request. */
async function asUser(userId: string, statements: string[]): Promise<void> {
  await webPool.db.transaction(async (tx) => {
    await tx.execute(`select set_config('app.user_id', '${userId}', true)`);
    for (const s of statements) await tx.execute(s);
  });
}

/** Count a user's rows in a FORCE'd table, as that user (an undeclared count sees nothing). */
async function countAs(userId: string, sql: string): Promise<number> {
  return tdb.db.transaction(async (tx) => {
    await tx.execute(`select set_config('app.user_id', '${userId}', true)`);
    const rows = await tx.execute<{ n: number }>(sql);
    return Number(rows[0]?.n);
  });
}

/** Give an account something in every table that holds a person's data. */
async function populate(userId: string, tag: string): Promise<void> {
  await asUser(userId, [
    `insert into app.watch_subscriptions (user_id, sealed_product_id, channels)
       values ('${userId}', '${productId}', '{email}')`,
    `insert into app.collections (id, owner_id, name)
       values ('00000000-0000-4000-8000-${String(next()).padStart(12, '0')}', '${userId}', 'Binder ${tag}')`,
    `insert into app.collection_items (collection_id, card_variant_id, quantity, acquired_price_cents, notes)
       select id, '${variantId}', 2, 1250, 'from a friend' from app.collections
        where owner_id = '${userId}'`,
    // Live: row security only accepts pulls into a break that is running.
    `insert into app.breaks (creator_id, title, overlay_token_hash, status, started_at)
       values ('${userId}', 'Break ${tag}', 'overlay-hash-${tag}', 'live', now())`,
    `insert into app.break_pulls (break_id, label, value_cents_at_pull, seq)
       select id, 'Pull ${tag}', 2500, 1 from app.breaks where creator_id = '${userId}'`,
    `insert into app.creator_profiles (user_id, handle, display_name)
       values ('${userId}', 'handle-${tag}', 'Display ${tag}')`,
    `insert into app.live_sales (seller_id, label, price_cents, buyer_handle_encrypted, has_buyer_handle)
       values ('${userId}', 'Sale ${tag}', 4200, '${BUYER_CIPHERTEXT}', true)`,
    `insert into app.price_observations (card_variant_id, source, price_cents, reporter_id, evidence_ref)
       values ('${variantId}', 'user_report', 777, '${userId}', 'https://example.test/receipt-${tag}')`,
    `insert into app.api_keys (owner_id, name, prefix, key_hash, scopes)
       values ('${userId}', 'Key ${tag}', 'pfx${tag}', '${KEY_HASH}', '{catalog:read}')`,
  ]);
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });

  const [product] = await tdb.db.execute<{ id: string }>(
    `select id from app.sealed_products order by name limit 1`,
  );
  productId = String(product?.id);
  const [variant] = await tdb.db.execute<{ id: string }>(
    `select v.id from app.card_variants v join app.cards c on c.id = v.card_id
      order by c.number limit 1`,
  );
  variantId = String(variant?.id);

  const auth = createAuth(webPool.db, {
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
  app = await buildApp(config, {
    db: tdb.db,
    writeDb: webPool.db,
    auth,
    notify: (notice) => {
      notices.push(notice);
      return Promise.resolve();
    },
  });
});

afterAll(async () => {
  await app.close();
  await webPool.close();
  await tdb.close();
});

beforeEach(() => {
  notices.length = 0;
});

async function ageSessions(userId: string, minutes: number): Promise<void> {
  await tdb.db.execute(
    `update app.sessions set created_at = now() - interval '${String(minutes)} minutes'
      where user_id = '${userId}'`,
  );
}

describe('downloading your data', () => {
  it('needs a session, and a recent one', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/account/export' })).statusCode).toBe(401);

    const email = `export-stale-${String(next())}@example.com`;
    const cookie = await signIn(email);
    await ageSessions(await userIdOf(email), 11);
    const res = await app.inject({ method: 'GET', url: '/v1/account/export', headers: { cookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'step_up_required' });
    expect(notices).toEqual([]);
  });

  it('gives back everything the account holds, as a download', async () => {
    const email = `export-${String(next())}@example.com`;
    const cookie = await signIn(email);
    const userId = await userIdOf(email);
    await populate(userId, 'mine');

    const res = await app.inject({ method: 'GET', url: '/v1/account/export', headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="gundam-tcg-hub-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );

    const data = res.json<Record<string, unknown> & Record<string, Record<string, unknown>[]>>();
    expect(data['format']).toBe('gundam-tcg-hub-export');
    expect(data['account']).toMatchObject({ email });
    expect(data['watches']).toHaveLength(1);
    expect(data['collections']?.[0]).toMatchObject({ name: 'Binder mine' });
    expect(data['collections']?.[0]?.['items']).toEqual([
      expect.objectContaining({ quantity: 2, acquiredPriceCents: 1250, notes: 'from a friend' }),
    ]);
    // A card by name, not a bare id.
    expect(JSON.stringify(data['collections'])).toContain('"cardName":"');
    expect(data['breaks']?.[0]).toMatchObject({ title: 'Break mine' });
    expect(data['breaks']?.[0]?.['pulls']).toEqual([
      expect.objectContaining({ label: 'Pull mine', valueCentsAtPull: 2500, seq: 1 }),
    ]);
    expect(data['creatorProfile']).toMatchObject({ handle: 'handle-mine' });
    expect(data['liveSales']).toEqual([
      expect.objectContaining({ label: 'Sale mine', priceCents: 4200, hadBuyerHandle: true }),
    ]);
    expect(data['priceReports']).toEqual([expect.objectContaining({ priceCents: 777 })]);
    expect(data['apiKeys']).toEqual([
      expect.objectContaining({ name: 'Key mine', prefix: 'pfxmine' }),
    ]);
    // Their own session history, with what we hold about where it came from — which is a
    // same-day hash, labelled as one, never the address (ADR-028).
    expect(String(data['sessions']?.[0]?.['ipHash'])).toMatch(IP_HASH_PATTERN);
    expect(res.body).not.toMatch(/198\.18\.9\.\d+/);
    expect(data['withheld']).toEqual(expect.arrayContaining([expect.stringContaining('buyer')]));
  });

  it('carries nothing that opens anything, and nobody else’s personal data', async () => {
    const email = `export-secrets-${String(next())}@example.com`;
    const cookie = await signIn(email);
    const userId = await userIdOf(email);
    await populate(userId, 'secret');
    const tokens = await tdb.db.execute<{ token: string }>(
      `select token from app.sessions where user_id = '${userId}'`,
    );

    const body = (
      await app.inject({ method: 'GET', url: '/v1/account/export', headers: { cookie } })
    ).body;
    for (const { token } of tokens) expect(body).not.toContain(token);
    expect(body).not.toContain(BUYER_CIPHERTEXT);
    expect(body).not.toContain(KEY_HASH);
    expect(body).not.toContain('overlay-hash-secret');
    expect(body).not.toMatch(/"(token|keyHash|overlayTokenHash|serverSeedEncrypted)"/);
  });

  it("never includes another account's rows", async () => {
    const theirEmail = `export-theirs-${String(next())}@example.com`;
    await signIn(theirEmail);
    await populate(await userIdOf(theirEmail), 'theirs');

    const email = `export-own-${String(next())}@example.com`;
    const cookie = await signIn(email);
    const body = (
      await app.inject({ method: 'GET', url: '/v1/account/export', headers: { cookie } })
    ).body;
    expect(body).not.toContain('theirs');
    expect(body).not.toContain(theirEmail);
  });

  it('tells the owner, and records it', async () => {
    const email = `export-notice-${String(next())}@example.com`;
    const cookie = await signIn(email);
    const userId = await userIdOf(email);
    await app.inject({ method: 'GET', url: '/v1/account/export', headers: { cookie } });

    expect(notices).toEqual([{ email, event: 'data_exported' }]);
    const [row] = await tdb.db.execute<{ n: number }>(
      `select count(*)::int as n from app.audit_log
        where action = 'account.exported' and actor_id = '${userId}'`,
    );
    expect(row?.n).toBe(1);
  });
});

describe('who may delete a person (migration 0033)', () => {
  async function asWeb(declared: string | null, statement: string): Promise<string | null> {
    try {
      await webPool.db.transaction(async (tx) => {
        if (declared) await tx.execute(`select set_config('app.user_id', '${declared}', true)`);
        await tx.execute(statement);
      });
      return null;
    } catch (e) {
      const messages: string[] = [];
      for (let c: unknown = e; c instanceof Error; c = c.cause) messages.push(c.message);
      return messages.join(' | ');
    }
  }

  it('the web role cannot delete a user row directly', async () => {
    const email = `grant-direct-${String(next())}@example.com`;
    await signIn(email);
    const userId = await userIdOf(email);
    expect(await asWeb(userId, `delete from app.users where id = '${userId}'`)).toMatch(
      /permission denied/i,
    );
    expect(await userIdOf(email)).toBe(userId);
  });

  it('the function refuses unless the transaction declared that same account', async () => {
    const victimEmail = `grant-victim-${String(next())}@example.com`;
    await signIn(victimEmail);
    const victim = await userIdOf(victimEmail);
    const attackerEmail = `grant-attacker-${String(next())}@example.com`;
    await signIn(attackerEmail);
    const attacker = await userIdOf(attackerEmail);

    expect(await asWeb(null, `select app.delete_account('${victim}')`)).toMatch(/must declare/);
    expect(await asWeb(attacker, `select app.delete_account('${victim}')`)).toMatch(/must declare/);
    expect(await userIdOf(victimEmail)).toBe(victim);
  });

  it('the web role still cannot delete a price report on its own', async () => {
    // Otherwise a live account could wipe its rejection history (SR-3.5).
    const email = `grant-report-${String(next())}@example.com`;
    await signIn(email);
    const userId = await userIdOf(email);
    await populate(userId, 'keepme');
    expect(
      await asWeb(
        userId,
        `delete from app.price_observations where evidence_ref = 'https://example.test/receipt-keepme'`,
      ),
    ).toMatch(/permission denied/i);
  });
});

describe('the hourly limit', () => {
  it('counts per account, so one busy account cannot use up everyone else’s', async () => {
    const busyEmail = `export-busy-${String(next())}@example.com`;
    const busy = await signIn(busyEmail);
    for (let i = 0; i < 5; i += 1) {
      await app.inject({ method: 'GET', url: '/v1/account/export', headers: { cookie: busy } });
    }
    const sixth = await app.inject({
      method: 'GET',
      url: '/v1/account/export',
      headers: { cookie: busy },
    });
    expect(sixth.statusCode).toBe(429);

    // Same address, different account: unaffected.
    const other = await signIn(`export-other-${String(next())}@example.com`);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/account/export',
      headers: { cookie: other },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('deleting your account', () => {
  async function remove(cookie: string, confirm: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/account/delete',
      headers: { cookie },
      payload: { confirm },
    });
  }

  it('needs the email address typed out, and keeps everything if it is wrong', async () => {
    const email = `delete-mismatch-${String(next())}@example.com`;
    const cookie = await signIn(email);
    const res = await remove(cookie, 'someone-else@example.com');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'confirmation_mismatch' });
    expect(await userIdOf(email)).not.toBe('undefined');
  });

  it('needs a recent sign-in', async () => {
    const email = `delete-stale-${String(next())}@example.com`;
    const cookie = await signIn(email);
    await ageSessions(await userIdOf(email), 11);
    const res = await remove(cookie, email);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'step_up_required' });
  });

  it('refuses an admin, who must be demoted by an operator first', async () => {
    const email = `delete-admin-${String(next())}@example.com`;
    const cookie = await signIn(email);
    await tdb.db.execute(`update app.users set role = 'admin' where email = '${email}'`);
    const res = await remove(cookie, email);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'admin_cannot_self_delete' });
  });

  it('needs a passkey session when the account has a passkey', async () => {
    const email = `delete-passkey-${String(next())}@example.com`;
    const cookie = await signIn(email);
    const userId = await userIdOf(email);
    await tdb.db.execute(`
      insert into app.passkeys (id, name, public_key, user_id, credential_id, counter, device_type, backed_up)
      values ('pk-${userId}', 'Key', 'public-key', '${userId}', 'cred-${userId}', 0, 'singleDevice', false)`);

    const refused = await remove(cookie, email);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'passkey_required' });

    await tdb.db.execute(
      `update app.sessions set auth_method = 'passkey' where user_id = '${userId}'`,
    );
    expect((await remove(cookie, email)).statusCode).toBe(200);
  });

  it('deletes everything that was only theirs, and signs them out', async () => {
    const email = `delete-all-${String(next())}@example.com`;
    const cookie = await signIn(email);
    const userId = await userIdOf(email);
    await populate(userId, 'gone');
    // A second, unused sign-in link, still pending — it carries the address too.
    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      headers: { origin: ORIGIN, 'x-forwarded-for': '198.18.10.1' },
      payload: { email, callbackURL: '/' },
    });
    const pendingLink = String(sentLinks.at(-1)?.url);

    const res = await remove(cookie, `  ${email.toUpperCase()} `);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ deleted: true });

    expect(
      (await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } })).statusCode,
    ).toBe(401);
    for (const [table, column] of [
      ['users', 'id'],
      ['sessions', 'user_id'],
      ['watch_subscriptions', 'user_id'],
      ['collections', 'owner_id'],
      ['breaks', 'creator_id'],
      ['creator_profiles', 'user_id'],
      ['live_sales', 'seller_id'],
      ['api_keys', 'owner_id'],
      ['sign_in_devices', 'user_id'],
    ] as const) {
      // Counted as the deleted user, so FORCE'd tables are really looked at.
      expect(
        await countAs(
          userId,
          `select count(*)::int as n from app.${table} where ${column} = '${userId}'`,
        ),
        table,
      ).toBe(0);
    }
    expect(
      await countAs(
        userId,
        `select count(*)::int as n from app.break_pulls where label = 'Pull gone'`,
      ),
    ).toBe(0);
    expect(
      await countAs(
        userId,
        `select count(*)::int as n from app.verifications where value like '%${email}%'`,
      ),
    ).toBe(0);

    // The unused link no longer works either.
    const link = new URL(pendingLink);
    const clicked = await app.inject({
      method: 'GET',
      url: link.pathname + link.search,
      headers: { 'x-forwarded-for': '198.18.10.2' },
    });
    expect(String(clicked.headers['set-cookie'] ?? '')).not.toContain('gth.session_token=');
    expect(await userIdOf(email)).toBe('undefined');
  });

  it('keeps an approved report in the public record, with nothing that points back', async () => {
    // This failed before migration 0032: the reporter check contradicted the foreign key's
    // `set null`, so deleting anyone who had ever reported a price was impossible.
    const email = `delete-report-${String(next())}@example.com`;
    const cookie = await signIn(email);
    const userId = await userIdOf(email);
    await populate(userId, 'report');
    await tdb.db.execute(
      `update app.price_observations set approved_at = now()
        where evidence_ref = 'https://example.test/receipt-report'`,
    );

    expect((await remove(cookie, email)).statusCode).toBe(200);
    const rows = await tdb.db.execute<{ reporter_id: string | null; price_cents: number }>(
      `select reporter_id, price_cents from app.price_observations
        where evidence_ref = 'https://example.test/receipt-report'`,
    );
    expect(rows).toEqual([{ reporter_id: null, price_cents: 777 }]);
  });

  it('deletes a report that never counted, pending or rejected', async () => {
    const email = `delete-pending-${String(next())}@example.com`;
    const cookie = await signIn(email);
    const userId = await userIdOf(email);
    await populate(userId, 'pending');
    await asUser(userId, [
      `insert into app.price_observations (card_variant_id, source, price_cents, reporter_id, evidence_ref)
         values ('${variantId}', 'user_report', 778, '${userId}', 'https://example.test/rejected-pending')`,
    ]);
    await tdb.db.execute(
      `update app.price_observations set rejected_at = now()
        where evidence_ref = 'https://example.test/rejected-pending'`,
    );

    expect((await remove(cookie, email)).statusCode).toBe(200);
    const [row] = await tdb.db.execute<{ n: number }>(
      `select count(*)::int as n from app.price_observations
        where evidence_ref in ('https://example.test/receipt-pending',
                               'https://example.test/rejected-pending')`,
    );
    expect(row?.n).toBe(0);
  });

  it('keeps prices observed from their breaks, unlinked from the break that is gone', async () => {
    const email = `delete-pulls-${String(next())}@example.com`;
    const cookie = await signIn(email);
    const userId = await userIdOf(email);
    await populate(userId, 'observed');
    // What the worker does for a logged pull (first-party, so written on the owner path).
    const pull = await tdb.db.transaction(async (tx) => {
      await tx.execute(`select set_config('app.user_id', '${userId}', true)`);
      return tx.execute<{ id: string }>(
        `select id from app.break_pulls where label = 'Pull observed'`,
      );
    });
    await tdb.db.execute(
      `insert into app.price_observations (card_variant_id, source, price_cents, break_pull_id, evidence_ref)
         values ('${variantId}', 'break_pull', 2500, '${String(pull[0]?.id)}', 'https://example.test/pull-observed')`,
    );

    expect((await remove(cookie, email)).statusCode).toBe(200);
    const rows = await tdb.db.execute<{ break_pull_id: string | null; price_cents: number }>(
      `select break_pull_id, price_cents from app.price_observations
        where evidence_ref = 'https://example.test/pull-observed'`,
    );
    expect(rows).toEqual([{ break_pull_id: null, price_cents: 2500 }]);
  });

  it('says goodbye to the address it had, and records the deletion without it', async () => {
    const email = `delete-notice-${String(next())}@example.com`;
    const cookie = await signIn(email);
    const userId = await userIdOf(email);
    await remove(cookie, email);

    expect(notices).toEqual([{ email, event: 'account_deleted' }]);
    const audit = await tdb.db.execute<{ action: string; diff: unknown }>(
      `select action, diff from app.audit_log
        where action = 'account.deleted' and target_id = '${userId}'`,
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(email);
  });
});
