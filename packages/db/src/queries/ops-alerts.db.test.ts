import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { watchdogJob } from '../jobs.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import { claimAlert } from './ops-alerts.js';

/**
 * Saying a thing once (SR-X.22, migration 0038).
 *
 * The watchdog runs every quarter of an hour; without this, "the scanner has stopped
 * reporting" would arrive ninety-six times a day and be ignored by the second morning.
 */
let tdb: TestDatabase;
let workerPool: ReturnType<typeof createDb>;
let worker: TestDatabase['db'];

const finding = { key: 'test.alert', repeatAfterS: 3600, text: 'something happened' };

beforeAll(async () => {
  tdb = await startTestDatabase();
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 2 });
  worker = workerPool.db;
}, 180_000);

afterAll(async () => {
  await workerPool.close();
  await tdb.close();
});

describe('claiming the right to speak', () => {
  it('grants it the first time and withholds it inside the interval', async () => {
    expect(await claimAlert(worker, finding)).toBe(true);
    expect(await claimAlert(worker, finding)).toBe(false);
    expect(await claimAlert(worker, finding)).toBe(false);
  });

  it('grants it again once the interval has passed', async () => {
    // Move the remembered time back rather than waiting an hour.
    await tdb.db.execute(
      `update app.ops_alert_state set last_sent_at = now() - interval '2 hours' where key = 'test.alert'`,
    );
    expect(await claimAlert(worker, finding)).toBe(true);
  });

  it('gives it to exactly one of two runs that overlap', async () => {
    await tdb.db.execute(
      `update app.ops_alert_state set last_sent_at = now() - interval '2 hours' where key = 'test.alert'`,
    );
    // Two claims at once is the real case: a timer that fired while the previous run was
    // still going. Exactly one may speak.
    const [a, b] = await Promise.all([claimAlert(worker, finding), claimAlert(worker, finding)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('keeps separate keys separate', async () => {
    expect(await claimAlert(worker, { ...finding, key: 'other.alert' })).toBe(true);
  });

  it('cannot be rewritten by the role that claims it', async () => {
    // The worker reaches the table only through the function: it may take its turn, and
    // cannot quietly reset somebody else's quiet period.
    let caught: unknown;
    try {
      await worker.execute(
        `update app.ops_alert_state set last_sent_at = now() - interval '1 day'`,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught, 'the worker should not be able to rewrite alert history').toBeDefined();
  });
});

describe('the watchdog job', () => {
  it('reports what it would have said when no webhook is configured', async () => {
    // A host that is not wired up yet should say so in its journal rather than look healthy.
    const lines = await watchdogJob(worker, null);
    expect(lines.some((l) => l.startsWith('WOULD ALERT'))).toBe(true);
    expect(lines.join('\n')).toContain('All clear');
  });

  it('says each thing once, and sends what it claimed', async () => {
    const sent: string[] = [];
    const notify = (text: string): Promise<{ ok: true }> => {
      sent.push(text);
      return Promise.resolve({ ok: true });
    };
    // The heartbeat was claimed by the run above, so this one has nothing new to say.
    const second = await watchdogJob(worker, notify);
    expect(sent).toHaveLength(0);
    expect(second.every((l) => l.startsWith('held back'))).toBe(true);

    await tdb.db.execute(`update app.ops_alert_state set last_sent_at = now() - interval '2 days'`);
    const third = await watchdogJob(worker, notify);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('[info]');
    expect(third.some((l) => l.startsWith('alerted:'))).toBe(true);
  });
});
