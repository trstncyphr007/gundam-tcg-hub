import { createDb, createApiKey, seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { serialiseError } from './log-error.js';

/**
 * A failed query must not publish what it was carrying (SR-X.20, SR-X.23, T15).
 *
 * The error handler logs `{ err: error }` on every 5xx, and pino's default serialiser copies
 * an error's own properties. A driver error is not a plain error: Drizzle attaches the failing
 * **statement** and its **bound parameters**, and repeats them in the message.
 *
 * Most statements bind nothing interesting. Some bind the material this whole system is built
 * to protect — an API key's hash, an encrypted break seed, and, through Better Auth, session
 * tokens and magic-link tokens. Any statement that fails while carrying one of those wrote it
 * to the log in full.
 *
 * This is the same shape as the magic-link URL: a channel nobody had asked what travels
 * through it.
 */
const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'info' });
const SECRET = 'SUPERSECRETKEYHASHVALUE';

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 2 });
});

afterAll(async () => {
  await webPool.close();
  await tdb.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what a failed query puts in the log', () => {
  it('never writes the statement it was running, or what it bound to it', async () => {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    const app = await buildApp(config, { db: tdb.db });
    try {
      // A real driver failure carrying a real secret: the second insert collides on the
      // prefix index, and the statement it fails on has the key hash bound to it.
      await createApiKey(tdb.db, {
        name: 'first',
        prefix: 'dupepfx1',
        keyHash: SECRET,
        scopes: ['catalog:read'],
      });
      await expect(
        createApiKey(tdb.db, {
          name: 'second',
          prefix: 'dupepfx1',
          keyHash: SECRET,
          scopes: ['catalog:read'],
        }),
      ).rejects.toThrow();

      // Now the same failure through a request, which is what actually reaches the logger.
      app.get('/boom', async () => {
        await createApiKey(tdb.db, {
          name: 'third',
          prefix: 'dupepfx1',
          keyHash: SECRET,
          scopes: ['catalog:read'],
        });
        return { ok: true };
      });
      await app.ready();
      const response = await app.inject({ method: 'GET', url: '/boom' });
      expect(response.statusCode).toBe(500);
    } finally {
      await app.close();
    }

    const log = written.join('');
    expect(log, 'the log must not contain the bound secret').not.toContain(SECRET);
    expect(log, 'the log must not contain the failing statement').not.toContain(
      'insert into "app"."api_keys"',
    );
    // What is worth keeping: that it failed, and enough to recognise the kind of failure.
    expect(log).toContain('request failed');
    // Safe is not the only requirement. A log that says only "something failed" gets ignored,
    // and then a real failure is ignored with it — so the diagnosis has to survive.
    expect(log).toContain('23505');
    expect(log).toContain('api_keys_prefix_key');
  });
});

describe('serialiseError', () => {
  it('keeps the diagnosis and drops the payload', () => {
    // Shaped exactly like Drizzle's: a wrapper whose message embeds the statement and the
    // parameters, with the driver's own error as its cause.
    const driver = Object.assign(
      new Error('duplicate key value violates unique constraint "api_keys_prefix_key"'),
      {
        code: '23505',
        constraint_name: 'api_keys_prefix_key',
        table_name: 'api_keys',
        detail: 'Key (prefix)=(dupepfx1) already exists.',
      },
    );
    driver.name = 'PostgresError';
    const wrapper = Object.assign(
      new Error(
        'Failed query: insert into "app"."api_keys" (...) values ($1, $2)\n' +
          'params: name,SUPERSECRETKEYHASHVALUE: duplicate key value violates unique constraint',
      ),
      { cause: driver, query: 'insert into "app"."api_keys" ...', params: ['name', SECRET] },
    );

    const logged = serialiseError(wrapper);
    const text = JSON.stringify(logged);

    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('insert into');
    // Postgres quotes the offending value back in `detail`, which is the friendly thing to do
    // and the wrong thing to keep.
    expect(text).not.toContain('dupepfx1');

    expect(logged).toMatchObject({
      type: 'PostgresError',
      code: '23505',
      constraint: 'api_keys_prefix_key',
      table: 'api_keys',
    });
    expect(logged.message).toContain('duplicate key value violates unique constraint');
  });

  it('keeps stack frames but not the message lines above them', () => {
    const error = new Error('boom: params: SECRETVALUE');
    const logged = serialiseError(error);
    expect(logged.stack).not.toContain('SECRETVALUE');
    expect(logged.stack).toMatch(/^\s+at /);
  });

  it('cuts a message at params, wherever it came from', () => {
    expect(serialiseError(new Error('Failed query: x params: SECRETVALUE')).message).not.toContain(
      'SECRETVALUE',
    );
  });

  it('survives something that is not an error at all', () => {
    expect(serialiseError('just a string')).toMatchObject({ type: 'NonError' });
    expect(serialiseError(undefined).type).toBe('NonError');
  });
});
