import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { seedSample } from '../seed/sample.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import {
  BreakStateError,
  clearPullEvidence,
  createBreak,
  getPublicBreak,
  listPullsForCreator,
  logPull,
  setBreakStatus,
  setBreakVodUrl,
  setPullEvidence,
} from './breaks.js';
import { checkChain } from './fairness.js';
import { asUser } from './watches.js';

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let readonlyPool: ReturnType<typeof createDb>;
let web: TestDatabase['db'];
/** The role the public break page runs on: no declared user, published breaks only. */
let anonymous: TestDatabase['db'];

const CREATOR = 'vod-creator';
const OTHER = 'vod-other';
const VOD = 'https://www.youtube.com/watch?v=abc';

let counter = 0;
async function endedBreakWithPulls(count: number, owner = CREATOR): Promise<string> {
  counter += 1;
  const created = await createBreak(web, owner, {
    title: `VOD break ${String(counter)}`,
    overlayTokenHash: `vod-hash-${String(counter)}-${String(Date.now())}`,
  });
  await setBreakStatus(web, owner, created.id, 'live');
  for (let i = 0; i < count; i += 1) {
    await logPull(web, owner, created.id, {
      label: `Card ${String(i + 1)}`,
      valueCentsAtPull: 100,
    });
  }
  await setBreakStatus(web, owner, created.id, 'ended');
  return created.id;
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);

  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  web = webPool.db;
  readonlyPool = createDb({ url: tdb.urlFor('readonly'), max: 2 });
  anonymous = readonlyPool.db;

  await tdb.db.execute(
    `insert into app.users (id, name, email, role) values
       ('${CREATOR}', 'Creator', 'vod-creator@example.com', 'creator'),
       ('${OTHER}', 'Other', 'vod-other@example.com', 'creator')
     on conflict do nothing`,
  );
});

afterAll(async () => {
  await webPool.close();
  await readonlyPool.close();
  await tdb.close();
});

beforeEach(async () => {
  for (const user of [CREATOR, OTHER]) {
    await asUser(tdb.db, user, (tx) => tx.execute(`delete from app.breaks`));
  }
});

describe('VOD timestamps (FR-4.4)', () => {
  it('turns an offset into a deep link on the public page', async () => {
    const breakId = await endedBreakWithPulls(2);
    await setBreakVodUrl(web, CREATOR, breakId, VOD);
    const [first] = await listPullsForCreator(web, CREATOR, breakId);
    await setPullEvidence(web, CREATOR, String(first?.id), { offsetSeconds: 3723 });

    const view = await getPublicBreak(anonymous, breakId);
    expect(view?.pulls[0]?.vodUrl).toBe('https://www.youtube.com/watch?v=abc&t=3723');
    expect(view?.pulls[0]?.vodOffsetSeconds).toBe(3723);
    // The second pull has no timestamp, and says so rather than borrowing the first's.
    expect(view?.pulls[1]?.vodUrl).toBeNull();
  });

  it('gives no link until the break has a VOD, however many offsets are set', async () => {
    const breakId = await endedBreakWithPulls(1);
    const [first] = await listPullsForCreator(web, CREATOR, breakId);
    await setPullEvidence(web, CREATOR, String(first?.id), { offsetSeconds: 60 });

    const view = await getPublicBreak(anonymous, breakId);
    expect(view?.pulls[0]?.vodUrl).toBeNull();
  });

  it('uses a per-pull override, for a break split across two VODs', async () => {
    const breakId = await endedBreakWithPulls(2);
    await setBreakVodUrl(web, CREATOR, breakId, VOD);
    const pulls = await listPullsForCreator(web, CREATOR, breakId);
    await setPullEvidence(web, CREATOR, String(pulls[0]?.id), { offsetSeconds: 10 });
    await setPullEvidence(web, CREATOR, String(pulls[1]?.id), {
      offsetSeconds: 20,
      vodUrl: 'https://www.twitch.tv/videos/2',
    });

    const view = await getPublicBreak(anonymous, breakId);
    expect(view?.pulls[0]?.vodUrl).toBe('https://www.youtube.com/watch?v=abc&t=10');
    // And Twitch gets Twitch's format, or it drops the viewer at the start of the VOD.
    expect(view?.pulls[1]?.vodUrl).toBe('https://www.twitch.tv/videos/2?t=0h00m20s');
  });

  it('replaces a timestamp rather than adding a second one', async () => {
    const breakId = await endedBreakWithPulls(1);
    await setBreakVodUrl(web, CREATOR, breakId, VOD);
    const [first] = await listPullsForCreator(web, CREATOR, breakId);
    await setPullEvidence(web, CREATOR, String(first?.id), { offsetSeconds: 10 });
    await setPullEvidence(web, CREATOR, String(first?.id), { offsetSeconds: 20 });

    const view = await getPublicBreak(anonymous, breakId);
    expect(view?.pulls).toHaveLength(1);
    expect(view?.pulls[0]?.vodOffsetSeconds).toBe(20);
  });

  it('clears a timestamp, which is how a creator says they have no right one', async () => {
    const breakId = await endedBreakWithPulls(1);
    await setBreakVodUrl(web, CREATOR, breakId, VOD);
    const [first] = await listPullsForCreator(web, CREATOR, breakId);
    await setPullEvidence(web, CREATOR, String(first?.id), { offsetSeconds: 10 });

    expect(await clearPullEvidence(web, CREATOR, String(first?.id))).toBe(true);
    expect((await getPublicBreak(anonymous, breakId))?.pulls[0]?.vodUrl).toBeNull();
    expect(await clearPullEvidence(web, CREATOR, String(first?.id))).toBe(false);
  });

  it('clearing the break’s VOD removes every link at once', async () => {
    const breakId = await endedBreakWithPulls(1);
    await setBreakVodUrl(web, CREATOR, breakId, VOD);
    const [first] = await listPullsForCreator(web, CREATOR, breakId);
    await setPullEvidence(web, CREATOR, String(first?.id), { offsetSeconds: 10 });

    await setBreakVodUrl(web, CREATOR, breakId, null);
    expect((await getPublicBreak(anonymous, breakId))?.pulls[0]?.vodUrl).toBeNull();
    // The offsets survive: the creator may be re-uploading, not retracting.
    expect((await listPullsForCreator(web, CREATOR, breakId))[0]?.offsetSeconds).toBe(10);
  });

  it('rejects a link that is not https', async () => {
    const breakId = await endedBreakWithPulls(1);
    await expect(
      setBreakVodUrl(web, CREATOR, breakId, 'http://www.youtube.com/watch?v=abc'),
    ).rejects.toBeInstanceOf(BreakStateError);
  });

  it('rejects an offset outside the bounds', async () => {
    const breakId = await endedBreakWithPulls(1);
    const [first] = await listPullsForCreator(web, CREATOR, breakId);
    for (const offsetSeconds of [-1, 86_401, 1.5]) {
      await expect(
        setPullEvidence(web, CREATOR, String(first?.id), { offsetSeconds }),
      ).rejects.toBeInstanceOf(BreakStateError);
    }
  });
});

describe('a timestamp cannot touch the log (SR-4.1, FR-4.4)', () => {
  it('leaves the hash chain intact', async () => {
    const breakId = await endedBreakWithPulls(3);
    const before = await checkChain(tdb.db, breakId);
    expect(before.state).toBe('valid');

    await setBreakVodUrl(web, CREATOR, breakId, VOD);
    const pulls = await listPullsForCreator(web, CREATOR, breakId);
    for (const pull of pulls) {
      await setPullEvidence(web, CREATOR, pull.id, { offsetSeconds: pull.seq * 60 });
    }

    // The chain commits to six fields and a VOD link is not among them. Adding one to the
    // hashed set would have invalidated every chain ever written — which is the reason this
    // lives in its own table.
    const after = await checkChain(tdb.db, breakId);
    expect(after.state).toBe('valid');
    expect(after.head).toBe(before.head);
  });

  it('is absent from the rows a viewer re-hashes', async () => {
    const breakId = await endedBreakWithPulls(1);
    await setBreakVodUrl(web, CREATOR, breakId, VOD);
    const [first] = await listPullsForCreator(web, CREATOR, breakId);
    await setPullEvidence(web, CREATOR, String(first?.id), { offsetSeconds: 10 });

    const view = await getPublicBreak(anonymous, breakId);
    // The display row carries the link; the verifiable row must not, or a browser would
    // hash something the server never did.
    expect(view?.pulls[0]?.vodUrl).not.toBeNull();
    expect(JSON.stringify(view?.verification.rows)).not.toContain('youtube');
  });
});

describe('ownership (threat T4)', () => {
  it('will not let one creator timestamp another’s pull', async () => {
    const breakId = await endedBreakWithPulls(1);
    const [first] = await listPullsForCreator(web, CREATOR, breakId);

    // The policy refuses the insert, which surfaces as "not found" — the same answer as a
    // pull that does not exist, so no id is ever confirmed.
    await expect(
      setPullEvidence(web, OTHER, String(first?.id), { offsetSeconds: 10 }),
    ).rejects.toBeInstanceOf(BreakStateError);
    expect(await clearPullEvidence(web, OTHER, String(first?.id))).toBe(false);
  });

  it('will not let one creator set another’s VOD link', async () => {
    const breakId = await endedBreakWithPulls(1);
    await expect(setBreakVodUrl(web, OTHER, breakId, VOD)).rejects.toBeInstanceOf(BreakStateError);
  });

  it('shows a creator no pulls from a break that is not theirs', async () => {
    const breakId = await endedBreakWithPulls(2);
    expect(await listPullsForCreator(web, OTHER, breakId)).toHaveLength(0);
  });

  it('hides a draft break’s timestamps from the public role', async () => {
    counter += 1;
    const draft = await createBreak(web, CREATOR, {
      title: `Draft ${String(counter)}`,
      overlayTokenHash: `vod-draft-${String(counter)}-${String(Date.now())}`,
    });
    // A draft has no pulls yet, but the policy is what matters: evidence is visible exactly
    // when its pull is, so there is one rule about who may see a break.
    expect(await getPublicBreak(anonymous, draft.id)).toBeNull();
  });
});
