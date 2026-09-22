import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { retentionJob } from '../jobs.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import { runRetention } from './retention.js';
import { asUser } from './watches.js';

/**
 * The nightly sweep (migration 0035): what it deletes, what it refuses to touch, and the
 * footprint it leaves behind.
 *
 * It runs on the **worker** throughout, because the interesting part is not the SQL — it is
 * that a role which cannot delete an audit entry, a session or a device row can still run
 * exactly this deletion and no other.
 */
let tdb: TestDatabase;
let workerPool: ReturnType<typeof createDb>;
let worker: TestDatabase['db'];

const USER = 'retention-user';
const daysAgo = (d: number): string => `now() - interval '${String(d)} days'`;

async function count(table: string, where = 'true'): Promise<number> {
  const rows = await tdb.db.execute<{ n: string }>(
    `select count(*)::int as n from app.${table} where ${where}`,
  );
  return Number(rows[0]?.n ?? -1);
}

/** Devices are row-secured for the owner too, so even counting them is done as the owner. */
async function countDevices(where: string): Promise<number> {
  return asUser(tdb.db, USER, async (tx) => {
    const rows = await tx.execute<{ n: string }>(
      `select count(*)::int as n from app.sign_in_devices where ${where}`,
    );
    return Number(rows[0]?.n ?? -1);
  });
}

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

/** A session, a verification, a device and two audit entries — half of each past its period. */
async function seedRetentionFixtures(): Promise<void> {
  await tdb.db.execute(`
    insert into app.users (id, name, email)
    values ('${USER}', 'Retention', 'retention@example.test')
    on conflict (id) do nothing`);

  await tdb.db.execute(`
    insert into app.sessions (id, user_id, token, expires_at, ip_address, created_at)
    values ('sess-dead', '${USER}', 'tok-dead', ${daysAgo(3)}, 'iph1:2026-08-20:jA7Kq2Lm9Zx4Vb1Nc0Pd_e', ${daysAgo(33)}),
           ('sess-justlapsed', '${USER}', 'tok-just', now() - interval '2 hours', null, ${daysAgo(30)}),
           ('sess-live', '${USER}', 'tok-live', now() + interval '20 days', null, now())`);

  await tdb.db.execute(`
    insert into app.verifications (id, identifier, value, expires_at)
    values ('ver-dead', 'someone@example.test', 'hashed-token', ${daysAgo(2)}),
           ('ver-live', 'someone@example.test', 'hashed-token-2', now() + interval '10 minutes')`);

  // Devices force row-level security, for the owner too: recorded as the person they belong to.
  await asUser(tdb.db, USER, async (tx) => {
    await tx.execute(`
      insert into app.sign_in_devices (user_id, device, first_seen_at, last_seen_at)
      values ('${USER}', 'Chrome on Windows', ${daysAgo(500)}, ${daysAgo(400)}),
             ('${USER}', 'Firefox on Linux', ${daysAgo(500)}, ${daysAgo(2)})`);
  });

  await tdb.db.execute(`
    insert into app.audit_log (actor_id, action, target_type, at)
    values ('${USER}', 'session.created', 'session', ${daysAgo(400)}),
           ('${USER}', 'session.created', 'session', ${daysAgo(366)}),
           ('${USER}', 'passkey.added', 'passkey', ${daysAgo(300)})`);
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 1 });
  worker = workerPool.db;
  await seedRetentionFixtures();
}, 180_000);

afterAll(async () => {
  await workerPool.close();
  await tdb.close();
});

describe('the nightly retention sweep', () => {
  it('deletes what is past its period and nothing that is still in use', async () => {
    const lines = await runRetention(worker);
    const byName = new Map(lines.map((line) => [line.what, line.deleted]));

    expect(byName.get('expired_sessions')).toBe(1);
    expect(byName.get('expired_verifications')).toBe(1);
    expect(byName.get('stale_devices')).toBe(1);
    expect(byName.get('audit_entries')).toBe(2);

    // A session that lapsed two hours ago stays: the day of slack keeps the sweep from
    // racing a browser that is mid-refresh.
    expect(await count('sessions', "id = 'sess-justlapsed'")).toBe(1);
    expect(await count('sessions', "id = 'sess-live'")).toBe(1);
    expect(await count('sessions', "id = 'sess-dead'")).toBe(0);
    expect(await count('verifications', "id = 'ver-live'")).toBe(1);
    expect(await countDevices("device = 'Firefox on Linux'")).toBe(1);
    expect(await countDevices("device = 'Chrome on Windows'")).toBe(0);
    // Inside the year, so still there — the log is pruned, not emptied.
    expect(await count('audit_log', "action = 'passkey.added'")).toBe(1);
  });

  it('records its own pruning in the log it pruned', async () => {
    const rows = await tdb.db.execute<{ diff: { deleted: number; before: string } }>(
      "select diff from app.audit_log where action = 'audit_log.pruned'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.diff.deleted).toBe(2);
    // History that can be shortened silently is history that can be shortened.
    expect(Date.parse(String(rows[0]?.diff.before))).toBeLessThan(Date.now());
  });

  it('is quiet on a second run, and leaves no second footprint', async () => {
    const lines = await runRetention(worker);
    expect(lines.every((line) => line.deleted === 0)).toBe(true);
    expect(await count('audit_log', "action = 'audit_log.pruned'")).toBe(1);
  });

  it('is the only way the worker can delete any of it', async () => {
    // If any of these succeeded, the function would be a convenience rather than a control.
    await expectDbError(
      worker.execute('delete from app.audit_log'),
      /permission denied|denied for table audit_log/i,
    );
    await expectDbError(
      worker.execute('delete from app.sessions'),
      /permission denied|denied for table sessions/i,
    );
    await expectDbError(
      worker.execute('delete from app.sign_in_devices'),
      /permission denied|denied for table sign_in_devices/i,
    );
    // And it cannot be told to reach further back than the period allows: no argument exists.
    await expectDbError(
      worker.execute("select app.run_retention(now() - interval '1 second')"),
      /does not exist|function app\.run_retention/i,
    );
  });

  it('is what the nightly job runs, on the worker role', async () => {
    // `retentionJob` is the body shared by `pnpm db:retention` and the production image's
    // `dist/job-retention.js`. Worth asserting here because the command a developer runs and
    // the command the server runs have to be the same code — they were not, and the server's
    // did not exist at all until the jobs shipped inside the image.
    const lines = await retentionJob(worker);
    expect(lines[0]).toMatch(/^erased \d+ buyer handle\(s\) older than 90 days$/);
    expect(lines.slice(1)).toEqual([
      'deleted 0 expired_sessions',
      'deleted 0 expired_verifications',
      'deleted 0 stale_devices',
      'deleted 0 audit_entries',
    ]);
  });

  it('will not delete a device that is still recent, even for the owner', async () => {
    // The floor is a policy on the table, so it holds for the definer function, for a
    // migration run by hand, and for anything else that ever gets DELETE on this table.
    // Deleting a recent device row is how a "new device" email would be suppressed (ADR-026).
    await asUser(tdb.db, USER, async (tx) => {
      await tx.execute("delete from app.sign_in_devices where device = 'Firefox on Linux'");
    });
    expect(await countDevices("device = 'Firefox on Linux'")).toBe(1);
  });
});
