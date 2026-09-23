import { createAuth } from '@gth/auth';
import { FLAGS, type FlagReader, createDb, createFlagReader, seedSample, setFlag } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';
import { TEST_PASSKEY } from '../test/auth-fixtures.js';

/**
 * The kill switches, from the outside (plan §22, ADR-039).
 *
 * The question this file exists to answer is not "does the switch work" — it is "can the
 * person who pulled it still get back in and undo it".
 */
const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let app: FastifyInstance;
let flags: FlagReader;

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 2 });
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 2 });
  // No cache in the test: a flip is meant to be visible at once here, and the ten-second
  // window is covered by the reader's own tests.
  flags = createFlagReader(webPool.db, { ttlMs: 0 });
  const auth = createAuth(webPool.db, {
    baseURL: 'http://127.0.0.1:4000',
    secret: 'test-secret-at-least-32-characters-long',
    trustedOrigins: ['http://127.0.0.1:4000', 'http://127.0.0.1:3000'],
    production: false,
    trustProxyHeaders: false,
    passkey: TEST_PASSKEY,
    sendMagicLink: () => Promise.resolve(),
  });
  app = await buildApp(config, {
    db: tdb.db,
    writeDb: webPool.db,
    // The console is only mounted with auth and a pool for its decisions, and this file is
    // about the console staying reachable — so both have to be here.
    moderationDb: workerPool.db,
    auth,
    flags,
  });
}, 180_000);

afterAll(async () => {
  await app.close();
  await webPool.close();
  await workerPool.close();
  await tdb.close();
});

beforeEach(async () => {
  await setFlag(workerPool.db, FLAGS.publicApiEnabled, true, 'test', 'reset');
});

describe('the public API switch', () => {
  it('serves normally while it is on', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/games' });
    expect(res.statusCode).toBe(200);
  });

  it('answers 503 with a Retry-After once it is off', async () => {
    await setFlag(workerPool.db, FLAGS.publicApiEnabled, false, 'admin', 'incident');
    const res = await app.inject({ method: 'GET', url: '/v1/games' });

    // 503, not 404 or 403: the service exists and is coming back, and caches and clients
    // treat that differently from "gone" or "not for you".
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('300');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.json()).toMatchObject({ error: 'temporarily_disabled' });
  });

  it('leaves the way back in open', async () => {
    await setFlag(workerPool.db, FLAGS.publicApiEnabled, false, 'admin', 'incident');

    // A switch that locks the operator out of the room with the switch in it is a trap, not
    // a control. Signing in must still work, and the console must still answer — with its own
    // refusal (401 here, because this request carries no session), never a 503.
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { email: 'admin@example.test', callbackURL: '/' },
    });
    expect(signIn.statusCode).not.toBe(503);

    const admin = await app.inject({ method: 'GET', url: '/v1/admin/flags' });
    expect(admin.statusCode).toBe(401);

    // And the health check stays up: going dark would have the orchestrator restart a
    // container that is being held closed on purpose.
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
  });

  it('comes back the moment it is switched on', async () => {
    await setFlag(workerPool.db, FLAGS.publicApiEnabled, false, 'admin', 'incident');
    expect((await app.inject({ method: 'GET', url: '/v1/games' })).statusCode).toBe(503);

    await setFlag(workerPool.db, FLAGS.publicApiEnabled, true, 'admin', 'all clear');
    expect((await app.inject({ method: 'GET', url: '/v1/games' })).statusCode).toBe(200);
  });
});
