import { hashToken } from '@gth/security';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { seedSample } from '../seed/sample.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import {
  BreakStateError,
  createBreak,
  findBreakByOverlayToken,
  getBreakForCreator,
  getOverlayState,
  getPublicBreak,
  listBreaks,
  listPulls,
  logPull,
  rotateOverlayToken,
  setBreakStatus,
} from './breaks.js';
import { asUser } from './watches.js';

const PEPPER = 'test-pepper-at-least-32-characters-long';
const CREATOR = 'creator-1';
const OTHER = 'creator-2';

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let productId: string;

/** postgres.js wraps failures, so the permission text lives on `cause`. */
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

async function newBreak(creator = CREATOR, token = 'tok-' + creator): Promise<string> {
  const row = await createBreak(tdb.db, creator, {
    title: 'Freedom Ascension box break',
    sealedProductId: productId,
    costCents: 9999,
    overlayTokenHash: hashToken(token, PEPPER),
  });
  return row.id;
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });

  const rows = await tdb.db.execute<{ id: string }>(`select id from app.sealed_products limit 1`);
  productId = String(rows[0]?.id);

  await tdb.db.execute(
    `insert into app.users (id, name, email, role) values
       ('${CREATOR}', 'Creator One', 'c1@example.com', 'creator'),
       ('${OTHER}', 'Creator Two', 'c2@example.com', 'creator')
     on conflict do nothing`,
  );
});

afterAll(async () => {
  await webPool.close();
  await tdb.close();
});

describe('break lifecycle (FR-2.2)', () => {
  it('starts as a draft and only moves forward', async () => {
    const id = await newBreak();
    expect((await getBreakForCreator(tdb.db, CREATOR, id))?.status).toBe('draft');

    await setBreakStatus(tdb.db, CREATOR, id, 'live');
    expect((await getBreakForCreator(tdb.db, CREATOR, id))?.status).toBe('live');

    await setBreakStatus(tdb.db, CREATOR, id, 'ended');
    expect((await getBreakForCreator(tdb.db, CREATOR, id))?.status).toBe('ended');

    // Ended is final: a finished log cannot be reopened and added to.
    await expect(setBreakStatus(tdb.db, CREATOR, id, 'live')).rejects.toThrow(BreakStateError);
  });

  it('refuses to log a pull into a break that is not live', async () => {
    const id = await newBreak(CREATOR, 'tok-draft');
    await expect(
      logPull(tdb.db, CREATOR, id, { label: 'Sample Unit Alpha', valueCentsAtPull: 500 }),
    ).rejects.toThrow(BreakStateError);
  });

  it('numbers pulls in order, without gaps', async () => {
    const id = await newBreak(CREATOR, 'tok-seq');
    await setBreakStatus(tdb.db, CREATOR, id, 'live');
    for (const label of ['Alpha', 'Beta', 'Gamma']) {
      await logPull(tdb.db, CREATOR, id, { label, valueCentsAtPull: 100 });
    }
    const pulls = await listPulls(tdb.db, id);
    expect(pulls.map((p) => p.seq)).toEqual([1, 2, 3]);
    expect(pulls.map((p) => p.label)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('keeps the value recorded at the time of the pull', async () => {
    const id = await newBreak(CREATOR, 'tok-value');
    await setBreakStatus(tdb.db, CREATOR, id, 'live');
    await logPull(tdb.db, CREATOR, id, { label: 'Chase', valueCentsAtPull: 12_500 });
    const [pull] = await listPulls(tdb.db, id);
    expect(pull?.valueCentsAtPull).toBe(12_500);
  });
});

describe('ownership (T4, SR-X.8)', () => {
  it("one creator cannot see, start or log into another creator's break", async () => {
    const mine = await newBreak(CREATOR, 'tok-mine');

    expect(await getBreakForCreator(tdb.db, OTHER, mine)).toBeNull();
    expect((await listBreaks(tdb.db, OTHER)).map((b) => b.id)).not.toContain(mine);
    await expect(setBreakStatus(tdb.db, OTHER, mine, 'live')).rejects.toThrow(BreakStateError);
    await expect(
      logPull(tdb.db, OTHER, mine, { label: 'stolen', valueCentsAtPull: 1 }),
    ).rejects.toThrow(BreakStateError);
  });

  it('row-level security blocks a forged creator_id outright', async () => {
    // Acting as OTHER, try to write a row that claims to belong to CREATOR.
    await expectDbError(
      asUser(tdb.db, OTHER, (tx) =>
        tx.execute(
          `insert into app.breaks (creator_id, title, overlay_token_hash)
           values ('${CREATOR}', 'forged', 'deadbeef')`,
        ),
      ),
      /row-level security/i,
    );
  });
});

describe('the public view (FR-2.4 stream-safe)', () => {
  it('hides a draft break from the public entirely', async () => {
    const id = await newBreak(CREATOR, 'tok-hidden');
    expect(await getPublicBreak(tdb.db, id)).toBeNull();
  });

  it('shows a started break, its pulls and the running total', async () => {
    const id = await newBreak(CREATOR, 'tok-public');
    await setBreakStatus(tdb.db, CREATOR, id, 'live');
    await logPull(tdb.db, CREATOR, id, { label: 'Alpha', valueCentsAtPull: 1500 });
    await logPull(tdb.db, CREATOR, id, { label: 'Beta', valueCentsAtPull: 2500 });

    const view = await getPublicBreak(tdb.db, id);
    expect(view?.title).toBe('Freedom Ascension box break');
    expect(view?.productName).toBe('Sample Set One Booster Box');
    expect(view?.totalCents).toBe(4000);
    expect(view?.pulls).toHaveLength(2);
  });

  it('never exposes who the creator is', async () => {
    const id = await newBreak(CREATOR, 'tok-anon');
    await setBreakStatus(tdb.db, CREATOR, id, 'live');
    const view = await getPublicBreak(tdb.db, id);
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain(CREATOR);
    expect(serialised).not.toContain('c1@example.com');
    expect(serialised).not.toContain('Creator One');
  });
});

describe('overlay tokens (SR-2.1, AC-2.2)', () => {
  it('resolves a valid token to its break', async () => {
    const id = await newBreak(CREATOR, 'tok-overlay');
    const found = await findBreakByOverlayToken(tdb.db, hashToken('tok-overlay', PEPPER));
    expect(found?.id).toBe(id);
  });

  it('never resolves a wrong token', async () => {
    await newBreak(CREATOR, 'tok-real');
    expect(await findBreakByOverlayToken(tdb.db, hashToken('tok-guessed', PEPPER))).toBeNull();
  });

  it('stores only the hash, never the token', async () => {
    await newBreak(CREATOR, 'tok-secret-value');
    const rows = await tdb.db.execute<{ overlay_token_hash: string }>(
      `select overlay_token_hash from app.breaks`,
    );
    for (const row of rows) {
      expect(row.overlay_token_hash).not.toContain('tok-secret-value');
    }
  });

  it('kills the old token on rotation, immediately', async () => {
    const id = await newBreak(CREATOR, 'tok-old');
    expect(await findBreakByOverlayToken(tdb.db, hashToken('tok-old', PEPPER))).not.toBeNull();

    await rotateOverlayToken(tdb.db, CREATOR, id, hashToken('tok-new', PEPPER));

    expect(await findBreakByOverlayToken(tdb.db, hashToken('tok-old', PEPPER))).toBeNull();
    expect((await findBreakByOverlayToken(tdb.db, hashToken('tok-new', PEPPER)))?.id).toBe(id);
    expect((await getBreakForCreator(tdb.db, CREATOR, id))?.overlayTokenVersion).toBe(2);
  });

  it('will not let another creator rotate my token', async () => {
    const id = await newBreak(CREATOR, 'tok-protected');
    await expect(
      rotateOverlayToken(tdb.db, OTHER, id, hashToken('hijack', PEPPER)),
    ).rejects.toThrow(BreakStateError);
    expect((await findBreakByOverlayToken(tdb.db, hashToken('tok-protected', PEPPER)))?.id).toBe(
      id,
    );
  });

  it('works on a draft, so the overlay can be wired into OBS before going live', async () => {
    const id = await newBreak(CREATOR, 'tok-predraft');
    const state = await getOverlayState(tdb.db, hashToken('tok-predraft', PEPPER));
    expect(state?.id).toBe(id);
    expect(state?.pulls).toEqual([]);
  });

  it('shows the token-holder the live running total', async () => {
    const id = await newBreak(CREATOR, 'tok-state');
    await setBreakStatus(tdb.db, CREATOR, id, 'live');
    await logPull(tdb.db, CREATOR, id, { label: 'Alpha', valueCentsAtPull: 1000 });
    await logPull(tdb.db, CREATOR, id, { label: 'Beta', valueCentsAtPull: 2000 });

    const state = await getOverlayState(tdb.db, hashToken('tok-state', PEPPER));
    expect(state?.totalCents).toBe(3000);
    expect(state?.pulls.map((p) => p.label)).toEqual(['Alpha', 'Beta']);
  });

  it('a token grants access to its own break and no other', async () => {
    const mine = await newBreak(CREATOR, 'tok-scope-a');
    await newBreak(OTHER, 'tok-scope-b');
    const state = await getOverlayState(tdb.db, hashToken('tok-scope-a', PEPPER));
    expect(state?.id).toBe(mine);
  });

  it('the database itself refuses a draft to a caller with no token', async () => {
    // Not just the query: strip the token and row-level security hides the row.
    const id = await newBreak(CREATOR, 'tok-rls-proof');
    const rows = await tdb.db.execute<{ n: number }>(
      `select count(*)::int as n from app.breaks where id = '${id}'`,
    );
    expect(rows[0]?.n).toBe(0);
  });
});

describe('append-only pull logs (SR-4.1 groundwork)', () => {
  it('the web role cannot edit or delete a logged pull', async () => {
    const id = await newBreak(CREATOR, 'tok-append');
    await setBreakStatus(tdb.db, CREATOR, id, 'live');
    await logPull(tdb.db, CREATOR, id, { label: 'Chase', valueCentsAtPull: 50_000 });

    await expectDbError(
      webPool.db.execute(`update app.break_pulls set value_cents_at_pull = 1`),
      /permission denied/i,
    );
    await expectDbError(webPool.db.execute(`delete from app.break_pulls`), /permission denied/i);
  });

  it('the worker role has no access to breaks at all', async () => {
    const workerPool = createDb({ url: tdb.urlFor('worker'), max: 1 });
    try {
      await expectDbError(workerPool.db.execute(`select * from app.breaks`), /permission denied/i);
      await expectDbError(
        workerPool.db.execute(`select * from app.break_pulls`),
        /permission denied/i,
      );
    } finally {
      await workerPool.close();
    }
  });
});
