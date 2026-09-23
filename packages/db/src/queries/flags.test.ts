import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import { FLAGS, createFlagReader, listFlags, setFlag } from './flags.js';

/**
 * Kill switches (plan §22, ADR-039), against the real grants.
 */
let tdb: TestDatabase;
let workerPool: ReturnType<typeof createDb>;
let webPool: ReturnType<typeof createDb>;
let worker: TestDatabase['db'];
let web: TestDatabase['db'];

const ADMIN = 'flags-admin';

async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected the query to fail').toBeDefined();
  const messages: string[] = [];
  for (let e: unknown = caught; e instanceof Error; e = e.cause) messages.push(e.message);
  expect(messages.join(' | ')).toMatch(pattern);
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 2 });
  webPool = createDb({ url: tdb.urlFor('web'), max: 2 });
  worker = workerPool.db;
  web = webPool.db;
}, 180_000);

afterAll(async () => {
  await workerPool.close();
  await webPool.close();
  await tdb.close();
});

describe('what a switch is by default', () => {
  it('lists every known switch as on, with nothing stored', async () => {
    const flags = await listFlags(web);
    expect(flags.map((f) => f.key)).toEqual([
      'alerts.enabled',
      'api.public.enabled',
      'scanner.ingest.enabled',
    ]);
    expect(flags.every((f) => f.enabled)).toBe(true);
    // Absent means on, so normal operation stores nothing at all.
    const rows = await tdb.db.execute<{ n: number }>(
      'select count(*)::int as n from app.feature_flags',
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

describe('flipping one', () => {
  it('records why, and who, and keeps the row when it goes back on', async () => {
    await setFlag(worker, FLAGS.alertsEnabled, false, ADMIN, 'suspected loop');
    const off = (await listFlags(web)).find((f) => f.key === FLAGS.alertsEnabled);
    expect(off).toMatchObject({ enabled: false, reason: 'suspected loop', updatedBy: ADMIN });

    await setFlag(worker, FLAGS.alertsEnabled, true, ADMIN, 'loop fixed');
    const on = (await listFlags(web)).find((f) => f.key === FLAGS.alertsEnabled);
    expect(on).toMatchObject({ enabled: true, reason: 'loop fixed' });
    // The history stays: "the API was off for two hours" is not erasable by turning it back on.
    const rows = await tdb.db.execute<{ n: number }>(
      'select count(*)::int as n from app.feature_flags',
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('is refused to the roles that only read it', async () => {
    await expectDbError(
      web.execute(
        `insert into app.feature_flags (key, enabled, reason) values ('api.public.enabled', false, 'x')`,
      ),
      /permission denied/i,
    );
    await expectDbError(worker.execute(`delete from app.feature_flags`), /permission denied/i);
  });
});

describe('the reader in front of it', () => {
  it('answers from cache, then notices within its window', async () => {
    let clock = 1_000_000;
    const reader = createFlagReader(web, { ttlMs: 10_000, now: () => clock });

    expect(await reader.isEnabled(FLAGS.publicApiEnabled)).toBe(true);
    await setFlag(worker, FLAGS.publicApiEnabled, false, ADMIN, 'incident');

    // Inside the window the old answer stands — that is the trade being made.
    expect(await reader.isEnabled(FLAGS.publicApiEnabled)).toBe(true);
    clock += 10_001;
    expect(await reader.isEnabled(FLAGS.publicApiEnabled)).toBe(false);
    // And an unrelated switch is unaffected.
    expect(await reader.isEnabled(FLAGS.alertsEnabled)).toBe(true);
  });

  it('keeps the site up when the database will not answer', async () => {
    const broken = createDb({ url: tdb.urlFor('web').replace('/gth', '/nonexistent'), max: 1 });
    try {
      const reader = createFlagReader(broken.db, { ttlMs: 0 });
      // Failing open is the deliberate choice: a database wobble must not switch the site off
      // by itself, and the switches exist for a human to pull.
      expect(await reader.isEnabled(FLAGS.publicApiEnabled)).toBe(true);
    } finally {
      await broken.close();
    }
  });

  it('reads once for a burst of callers', async () => {
    let reads = 0;
    const counting = {
      execute: async (...args: unknown[]) => {
        reads += 1;
        return (web as unknown as { execute: (...a: unknown[]) => Promise<unknown> }).execute(
          ...args,
        );
      },
    } as unknown as TestDatabase['db'];

    const reader = createFlagReader(counting, { ttlMs: 10_000 });
    await Promise.all(Array.from({ length: 25 }, () => reader.isEnabled(FLAGS.alertsEnabled)));
    // Twenty-five requests arriving together must not become twenty-five queries.
    expect(reads).toBe(1);
  });
});
