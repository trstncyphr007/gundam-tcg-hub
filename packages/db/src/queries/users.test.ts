import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import { getSelfProfile, updateDisplayName, writeAuditLog } from './users.js';

let tdb: TestDatabase;
const USER_ID = 'test-user-1';

beforeAll(async () => {
  tdb = await startTestDatabase();
  await tdb.db.execute(
    `insert into app.users (id, name, email) values ('${USER_ID}', 'Pilot', 'pilot@example.com')`,
  );
});

afterAll(async () => {
  await tdb.close();
});

describe('getSelfProfile', () => {
  it('returns the account for its owner', async () => {
    const profile = await getSelfProfile(tdb.db, USER_ID);
    expect(profile).toMatchObject({ id: USER_ID, email: 'pilot@example.com', role: 'user' });
  });

  it('returns null for an unknown id', async () => {
    await expect(getSelfProfile(tdb.db, 'nobody')).resolves.toBeNull();
  });
});

describe('updateDisplayName', () => {
  it('sets and clears the display name', async () => {
    expect(await updateDisplayName(tdb.db, USER_ID, 'TRSTN')).toMatchObject({
      displayName: 'TRSTN',
    });
    expect(await updateDisplayName(tdb.db, USER_ID, null)).toMatchObject({ displayName: null });
  });

  it('returns null when no row matches, and changes nothing', async () => {
    await expect(updateDisplayName(tdb.db, 'nobody', 'Hacker')).resolves.toBeNull();
    const profile = await getSelfProfile(tdb.db, USER_ID);
    expect(profile?.displayName).toBeNull();
  });

  it('never changes the role', async () => {
    await updateDisplayName(tdb.db, USER_ID, 'Still Ordinary');
    expect((await getSelfProfile(tdb.db, USER_ID))?.role).toBe('user');
  });
});

describe('writeAuditLog', () => {
  it('appends entries with and without optional fields', async () => {
    await writeAuditLog(tdb.db, { action: 'test.minimal', targetType: 'test' });
    await writeAuditLog(tdb.db, {
      actorId: null,
      action: 'test.full',
      targetType: 'user',
      targetId: USER_ID,
      ipHash: 'hash-of-ip',
      uaHash: 'hash-of-ua',
    });

    const rows = await tdb.db.execute<{ action: string; target_id: string | null }>(
      `select action, target_id from app.audit_log where action like 'test.%' order by action`,
    );
    expect(rows.map((r) => r.action)).toEqual(['test.full', 'test.minimal']);
    expect(rows[0]?.target_id).toBe(USER_ID);
  });
});
