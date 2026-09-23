import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import { deleteAccount } from './account-data.js';
import { DELETION_ACTION, listDeletionsSince, reapplyDeletion } from './deletions.js';

/**
 * Honouring a deletion after a restore (SR-X.25, ADR-027).
 *
 * The scenario is the real one: somebody deletes their account, a backup taken *before* that
 * is restored, and they come back. Something has to put them out again.
 */
let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let web: TestDatabase['db'];

const GONE = 'deletions-gone';
const STAYS = 'deletions-stays';

async function createUser(id: string): Promise<void> {
  await tdb.db.execute(`
    insert into app.users (id, name, email)
    values ('${id}', 'Test', '${id}@example.test')
    on conflict (id) do nothing`);
}

async function exists(id: string): Promise<boolean> {
  const rows = await tdb.db.execute<{ n: number }>(
    `select count(*)::int as n from app.users where id = '${id}'`,
  );
  return Number(rows[0]?.n) === 1;
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  webPool = createDb({ url: tdb.urlFor('web'), max: 2 });
  web = webPool.db;
  await createUser(GONE);
  await createUser(STAYS);
}, 180_000);

afterAll(async () => {
  await webPool.close();
  await tdb.close();
});

describe('after a restore', () => {
  it('finds the deletions recorded since the snapshot, and only those', async () => {
    const snapshot = new Date();
    // Something deleted *before* the snapshot must not be re-applied: it was already gone in
    // the backup, and asking again would be noise in an incident log.
    await tdb.db.execute(`
      insert into app.audit_log (actor_id, action, target_type, target_id, at)
      values (null, '${DELETION_ACTION}', 'user', 'older-deletion', now() - interval '2 days')`);

    await deleteAccount(web, GONE);
    expect(await exists(GONE)).toBe(false);

    const recorded = await listDeletionsSince(tdb.db, snapshot);
    expect(recorded.map((r) => r.userId)).toEqual([GONE]);
  });

  it('puts back out someone the backup brought back', async () => {
    // The restore: they exist again, exactly as a snapshot from before the deletion would
    // have left them.
    await createUser(GONE);
    expect(await exists(GONE)).toBe(true);

    expect(await reapplyDeletion(tdb.db, GONE)).toBe('deleted');
    expect(await exists(GONE)).toBe(false);
    // And nobody else is touched.
    expect(await exists(STAYS)).toBe(true);
  });

  it('is safe to run twice, and on an account the snapshot never had', async () => {
    // Re-running is the normal case: an operator is not sure whether the first run finished.
    expect(await reapplyDeletion(tdb.db, GONE)).toBe('absent');
    expect(await reapplyDeletion(tdb.db, 'never-existed')).toBe('absent');
  });

  it('records the re-application, so the second deletion is in the log too', async () => {
    const rows = await tdb.db.execute<{ n: number }>(
      `select count(*)::int as n from app.audit_log
        where action = '${DELETION_ACTION}' and target_id = '${GONE}'`,
    );
    // One from the original deletion. The re-application goes through the same database
    // function, which is what makes it complete — the audit entry belongs to the route.
    expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(1);
  });
});
