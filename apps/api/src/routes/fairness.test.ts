import { randomBytes } from 'node:crypto';
import { createDb, seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import { buildKeyRing } from '@gth/security';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';

/**
 * The commit–reveal endpoints over HTTP (FR-4.2, SR-4.2, AC-4.1).
 *
 * The algorithm and the database rules have their own tests in `@gth/db`, and the happy path
 * is driven through a real browser by `break-verifier.spec.ts`. What had never run is the
 * layer between: the guard that decides who may call these at all, the mapping of a refusal
 * onto a status code, and the shape of what comes back.
 *
 * That layer is worth its own tests for one reason above the others — **the response bodies
 * and the audit log must never carry the server seed**. Everything else here can be wrong and
 * be fixed. A seed written somewhere durable before the reveal cannot be taken back, and it
 * retroactively destroys the only claim this feature makes.
 */
const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });
const keyRing = buildKeyRing(JSON.stringify({ k1: randomBytes(32).toString('base64') }), 'k1');

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let app: FastifyInstance;
let productId: string;

const CREATOR = 'fair-creator';
const OTHER = 'fair-other-creator';
const PLAIN = 'fair-plain-user';

const creator = { userId: CREATOR, role: 'creator' as const };
const other = { userId: OTHER, role: 'creator' as const };
const plain = { userId: PLAIN, role: 'user' as const };

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

async function makeBreak(user = creator): Promise<string> {
  const res = await call('POST', '/v1/breaks', {
    user,
    payload: { title: 'Fairness break', sealedProductId: productId, costCents: 9999 },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

/** A break committed and seeded, ready to be started. */
async function committed(): Promise<string> {
  const id = await makeBreak();
  expect(
    (await call('POST', `/v1/breaks/${id}/commit`, { user: creator, payload: { slotCount: 8 } }))
      .statusCode,
  ).toBe(201);
  expect(
    (
      await call('POST', `/v1/breaks/${id}/client-seed`, {
        user: creator,
        payload: { clientSeed: 'chat said 4815162342' },
      })
    ).statusCode,
  ).toBe(200);
  return id;
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  const rows = await tdb.db.execute<{ id: string }>(`select id from app.sealed_products limit 1`);
  productId = String(rows[0]?.id);

  await tdb.db.execute(
    `insert into app.users (id, name, email, role) values
       ('${CREATOR}', 'F1', 'ff1@example.com', 'creator'),
       ('${OTHER}', 'F2', 'ff2@example.com', 'creator'),
       ('${PLAIN}', 'F3', 'ff3@example.com', 'user')
     on conflict do nothing`,
  );

  webPool = createDb({ url: tdb.urlFor('web'), max: 6 });
  // The reveal reads the encrypted seed, which only the worker role may do (migration 0030).
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 2 });
  app = await buildApp(config, {
    breaks: {
      db: webPool.db,
      tokenPepper: config.TOKEN_PEPPER,
      keyRing,
      secretsDb: workerPool.db,
    },
  });
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
  await workerPool.close();
  await webPool.close();
  await tdb.close();
});

describe('who may touch a commitment', () => {
  it('refuses all three without a session', async () => {
    const id = await makeBreak();
    expect(
      (await call('POST', `/v1/breaks/${id}/commit`, { payload: { slotCount: 4 } })).statusCode,
    ).toBe(401);
    expect(
      (await call('POST', `/v1/breaks/${id}/client-seed`, { payload: { clientSeed: 'x' } }))
        .statusCode,
    ).toBe(401);
    expect((await call('POST', `/v1/breaks/${id}/reveal`)).statusCode).toBe(401);
  });

  it('refuses a signed-in user who is not a creator', async () => {
    const id = await makeBreak();
    for (const [url, payload] of [
      [`/v1/breaks/${id}/commit`, { slotCount: 4 }],
      [`/v1/breaks/${id}/client-seed`, { clientSeed: 'x' }],
      [`/v1/breaks/${id}/reveal`, undefined],
    ] as const) {
      const res = await call('POST', url, { user: plain, ...(payload ? { payload } : {}) });
      expect(res.statusCode, url).toBe(403);
    }
  });

  it("will not commit to, seed or reveal someone else's break", async () => {
    // A creator role is not a licence over every break; ownership is checked per row.
    const id = await makeBreak(creator);
    expect(
      (await call('POST', `/v1/breaks/${id}/commit`, { user: other, payload: { slotCount: 4 } }))
        .statusCode,
    ).toBe(409);
    expect((await call('POST', `/v1/breaks/${id}/reveal`, { user: other })).statusCode).toBe(409);

    // And the break is untouched: the rightful owner can still commit.
    expect(
      (await call('POST', `/v1/breaks/${id}/commit`, { user: creator, payload: { slotCount: 4 } }))
        .statusCode,
    ).toBe(201);
  });

  it('answers 404 for an id that is not one', async () => {
    const res = await call('POST', '/v1/breaks/not-a-uuid/commit', {
      user: creator,
      payload: { slotCount: 4 },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('what the body may say', () => {
  it('refuses a slot count outside the range, or none at all', async () => {
    const id = await makeBreak();
    for (const payload of [{ slotCount: 1 }, { slotCount: 1001 }, { slotCount: 2.5 }, {}]) {
      const res = await call('POST', `/v1/breaks/${id}/commit`, { user: creator, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('invalid_request');
    }
  });

  it('refuses a field it does not recognise', async () => {
    // `.strict()`, so a typo is a refusal rather than a silently ignored intention.
    const id = await makeBreak();
    const res = await call('POST', `/v1/breaks/${id}/commit`, {
      user: creator,
      payload: { slotCount: 8, serverSeed: 'let me choose it' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses an empty or oversized audience seed', async () => {
    const id = await makeBreak();
    await call('POST', `/v1/breaks/${id}/commit`, { user: creator, payload: { slotCount: 4 } });
    for (const clientSeed of ['', '   ', 'x'.repeat(201)]) {
      const res = await call('POST', `/v1/breaks/${id}/client-seed`, {
        user: creator,
        payload: { clientSeed },
      });
      expect(res.statusCode, JSON.stringify(clientSeed)).toBe(400);
    }
  });
});

describe('the order the security depends on', () => {
  it('maps every refusal onto 409 with a reason, not a 500', async () => {
    const id = await committed();

    // Twice.
    const twice = await call('POST', `/v1/breaks/${id}/commit`, {
      user: creator,
      payload: { slotCount: 8 },
    });
    expect(twice.statusCode).toBe(409);
    expect(twice.json<{ error: string }>().error).toBe('commit_failed');

    // The audience seed is locked once given, so nobody can shop for a better one.
    const reseed = await call('POST', `/v1/breaks/${id}/client-seed`, {
      user: creator,
      payload: { clientSeed: 'a better one' },
    });
    expect(reseed.statusCode).toBe(409);
    expect(reseed.json<{ error: string }>().error).toBe('client_seed_failed');

    // And the seed stays back until the break is over.
    const early = await call('POST', `/v1/breaks/${id}/reveal`, { user: creator });
    expect(early.statusCode).toBe(409);
    expect(early.json<{ error: string; reason: string }>().error).toBe('reveal_failed');
    expect(early.json<{ reason: string }>().reason).toMatch(/after the break ends/);
  });
});

describe('what comes back, and what is written down', () => {
  it('never carries the server seed before the reveal — not in a body, not in the log', async () => {
    const id = await makeBreak();
    const commit = await call('POST', `/v1/breaks/${id}/commit`, {
      user: creator,
      payload: { slotCount: 8 },
    });
    expect(commit.statusCode).toBe(201);
    const published = commit.json<{ commitment: string; revealedSeed: string | null }>();
    expect(published.commitment).toMatch(/^[0-9a-f]{64}$/);

    // An allow-list of keys, not a deny-list of the ones we happen to fear today. A column
    // added to the commitment's public set later has to be named here before it can be
    // served, which is the only version of this check that keeps working.
    expect(Object.keys(published).sort()).toEqual([
      'algorithmVersion',
      'clientSeed',
      'commitment',
      'committedAt',
      'revealedAt',
      'revealedSeed',
      'slotCount',
    ]);
    expect(published.revealedSeed).toBeNull();
    // And nothing shaped like our ciphertext envelope (`v1:<kid>:…`) anywhere in the body.
    expect(commit.body).not.toMatch(/v\d+:[A-Za-z0-9_-]+:/);

    // The audit log is the durable record, and the one nobody re-reads. It holds what was
    // promised in public, and must never quietly grow the secret beside it.
    const [logged] = await tdb.db.execute<{ diff: Record<string, unknown> }>(
      `select diff from app.audit_log
        where action = 'break.committed' and target_id = '${id}'`,
    );
    expect(logged?.diff).toEqual({ commitment: published.commitment, slotCount: 8 });
  });

  it('sets no-store on every one of them', async () => {
    // A commitment cached by a proxy is a commitment somebody else can serve a stale copy of,
    // and the audience seed changes what the next answer should be.
    const id = await makeBreak();
    const commit = await call('POST', `/v1/breaks/${id}/commit`, {
      user: creator,
      payload: { slotCount: 4 },
    });
    expect(commit.headers['cache-control']).toBe('no-store');

    const seeded = await call('POST', `/v1/breaks/${id}/client-seed`, {
      user: creator,
      payload: { clientSeed: 'chat picked it' },
    });
    expect(seeded.headers['cache-control']).toBe('no-store');
  });
});

describe('ids that name nothing', () => {
  it('answers 404 for a product that is not there, rather than 500', async () => {
    // The same shape as the watches and collections cases: a well-formed id for a row that
    // has gone. A creator page open while the catalogue changes is ordinary traffic, and a
    // foreign key's own error must not reach the caller as `internal_error` (AC-3.4).
    const res = await call('POST', '/v1/breaks', {
      user: creator,
      payload: {
        title: 'Break on a ghost',
        sealedProductId: '00000000-0000-4000-8000-000000000000',
        costCents: 100,
      },
    });
    expect(res.statusCode, res.body).toBe(404);
  });
});

describe('when field encryption is not configured', () => {
  it('has no fairness routes at all, rather than half of them', async () => {
    // Deliberate (BreakDeps): a deployment that cannot protect a seed must not offer to keep
    // one. The failure is a route that is not there, which is loud, rather than a commitment
    // stored in the clear, which is silent.
    const bare = await buildApp(config, {
      breaks: { db: webPool.db, tokenPepper: config.TOKEN_PEPPER },
    });
    try {
      await bare.ready();
      const id = await makeBreak();
      for (const path of ['commit', 'client-seed', 'reveal']) {
        const res = await bare.inject({
          method: 'POST',
          url: `/v1/breaks/${id}/${path}`,
          payload: { slotCount: 4, clientSeed: 'x' },
        });
        expect(res.statusCode, path).toBe(404);
      }
    } finally {
      await bare.close();
    }
  });
});
