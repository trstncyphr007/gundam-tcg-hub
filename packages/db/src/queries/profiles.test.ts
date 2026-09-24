import { randomBytes } from 'node:crypto';
import { buildKeyRing } from '@gth/security';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { seedSample } from '../seed/sample.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import { createBreak, logPull, setBreakStatus, setPacksOpened } from './breaks.js';
import { commitBreak, revealBreak, setClientSeed } from './fairness.js';
import {
  ProfileError,
  deleteMyProfile,
  getBreakerProfile,
  getMyProfile,
  listPublishedProfiles,
  upsertProfile,
} from './profiles.js';
import { asUser } from './watches.js';

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let readonlyPool: ReturnType<typeof createDb>;
let superPool: ReturnType<typeof createDb>;
let web: TestDatabase['db'];
let worker: TestDatabase['db'];
/**
 * The role the public API actually serves profile pages on. Every "can a stranger see this"
 * assertion below runs here rather than on the web pool with a different user id — a
 * stranger has no session at all, and that is a different thing from being someone else.
 */
let anonymous: TestDatabase['db'];
let superuser: TestDatabase['db'];

const CREATOR = 'profile-creator';
const OTHER = 'profile-other';
const keyRing = buildKeyRing(JSON.stringify({ k1: randomBytes(32).toString('base64') }), 'k1');

let productId = '';
let variantsByRarity = new Map<string, string>();

let counter = 0;
async function newBreak(options: {
  owner?: string;
  status?: 'draft' | 'live' | 'ended';
  packs?: number | null;
  product?: boolean;
}): Promise<string> {
  counter += 1;
  const owner = options.owner ?? CREATOR;
  const created = await createBreak(web, owner, {
    title: `Break ${String(counter)}`,
    overlayTokenHash: `profile-hash-${String(counter)}-${String(Date.now())}`,
    ...(options.product === false ? {} : { sealedProductId: productId }),
  });
  const status = options.status ?? 'ended';
  if (status !== 'draft') await setBreakStatus(web, owner, created.id, 'live');
  return created.id;
}

/** Log `count` pulls of one rarity, then move the break to its final state. */
async function logRarity(breakId: string, rarity: string, count: number): Promise<void> {
  const variantId = variantsByRarity.get(rarity);
  if (!variantId) throw new Error(`no seeded variant for rarity ${rarity}`);
  for (let i = 0; i < count; i += 1) {
    await logPull(web, CREATOR, breakId, { cardVariantId: variantId, valueCentsAtPull: 100 });
  }
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);

  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  web = webPool.db;
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 2 });
  worker = workerPool.db;
  readonlyPool = createDb({ url: tdb.urlFor('readonly'), max: 2 });
  anonymous = readonlyPool.db;
  superPool = createDb({
    url: `postgres://gth_admin:test_admin_pw@${tdb.container.getHost()}:${String(
      tdb.container.getMappedPort(5432),
    )}/gth`,
    max: 2,
  });
  superuser = superPool.db;

  await tdb.db.execute(
    `insert into app.users (id, name, email, role) values
       ('${CREATOR}', 'Creator', 'profile-creator@example.com', 'creator'),
       ('${OTHER}', 'Other', 'profile-other@example.com', 'creator')
     on conflict do nothing`,
  );

  const products = await tdb.db.execute<{ id: string }>(
    `select id from app.sealed_products limit 1`,
  );
  productId = String(products[0]?.id);

  const variants = await tdb.db.execute<{ rarity: string; id: string }>(
    `select c.rarity, v.id
       from app.card_variants v
       join app.cards c on c.id = v.card_id
      where v.finish = 'normal'`,
  );
  variantsByRarity = new Map(variants.map((v) => [v.rarity, v.id]));
});

afterAll(async () => {
  await webPool.close();
  await workerPool.close();
  await readonlyPool.close();
  await superPool.close();
  await tdb.close();
});

beforeEach(async () => {
  for (const user of [CREATOR, OTHER]) {
    await asUser(tdb.db, user, (tx) => tx.execute(`delete from app.breaks`));
    await asUser(tdb.db, user, (tx) => tx.execute(`delete from app.creator_profiles`));
  }
  await tdb.db.execute(`delete from app.pack_odds`);
});

describe('claiming a profile (FR-4.3)', () => {
  it('starts unpublished, and an unpublished profile is invisible to a stranger', async () => {
    await upsertProfile(web, CREATOR, {
      handle: 'trstn',
      displayName: 'GUNDAM with TRSTN',
      published: false,
    });

    // The owner sees it.
    expect((await getMyProfile(web, CREATOR))?.handle).toBe('trstn');
    // Nobody else does, and "unpublished" and "no such handle" are the same answer.
    expect(await getBreakerProfile(anonymous, 'trstn')).toBeNull();
    // By handle, not by count: the sample seed publishes a placeholder profile of its own, so
    // "the list is empty" would be an assertion about the fixture rather than about this.
    expect((await listPublishedProfiles(anonymous)).map((p) => p.handle)).not.toContain('trstn');
  });

  it('appears once published', async () => {
    await upsertProfile(web, CREATOR, {
      handle: 'trstn',
      displayName: 'GUNDAM with TRSTN',
      bio: 'Breaks on Fridays.',
      published: true,
    });

    const profile = await getBreakerProfile(anonymous, 'trstn');
    expect(profile?.displayName).toBe('GUNDAM with TRSTN');
    expect((await listPublishedProfiles(anonymous)).map((p) => p.handle)).toContain('trstn');
  });

  it('publishes nothing about the account behind it (SR-3.8)', async () => {
    await upsertProfile(web, CREATOR, {
      handle: 'trstn',
      displayName: 'GUNDAM with TRSTN',
      published: true,
    });
    const serialised = JSON.stringify(await getBreakerProfile(anonymous, 'trstn'));

    // The display name is the only name on the page. Not the account name, not the email,
    // and not the user id — which is a join key to everything else this person owns.
    expect(serialised).not.toContain('profile-creator@example.com');
    expect(serialised).not.toContain(CREATOR);
    expect(serialised).not.toContain('Creator');
  });

  it('is found case-insensitively, because a URL is not a password', async () => {
    await upsertProfile(web, CREATOR, {
      handle: 'TRSTN',
      displayName: 'GUNDAM with TRSTN',
      published: true,
    });
    expect((await getBreakerProfile(anonymous, 'TrStN'))?.handle).toBe('trstn');
  });

  it('refuses a handle another creator already holds', async () => {
    await upsertProfile(web, CREATOR, { handle: 'trstn', displayName: 'One', published: true });
    await expect(
      upsertProfile(web, OTHER, { handle: 'trstn', displayName: 'Two', published: true }),
    ).rejects.toBeInstanceOf(ProfileError);
  });

  it('refuses handles that would read as official or shadow a route', async () => {
    for (const handle of ['admin', 'official', 'methodology']) {
      await expect(
        upsertProfile(web, CREATOR, { handle, displayName: 'Nope', published: true }),
      ).rejects.toBeInstanceOf(ProfileError);
    }
  });

  it('replaces rather than duplicates: one account, one profile', async () => {
    await upsertProfile(web, CREATOR, { handle: 'first', displayName: 'One', published: true });
    await upsertProfile(web, CREATOR, { handle: 'second', displayName: 'Two', published: true });

    expect(await getBreakerProfile(anonymous, 'first')).toBeNull();
    expect((await getBreakerProfile(anonymous, 'second'))?.displayName).toBe('Two');
    const rows = await tdb.db.execute<{ n: number }>(
      `select count(*)::int as n from app.creator_profiles where user_id = '${CREATOR}'`,
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('unpublishes without deleting, so the handle stays held', async () => {
    await upsertProfile(web, CREATOR, { handle: 'trstn', displayName: 'One', published: true });
    await upsertProfile(web, CREATOR, { handle: 'trstn', displayName: 'One', published: false });

    expect(await getBreakerProfile(anonymous, 'trstn')).toBeNull();
    // Still theirs: someone else cannot take the handle while it is merely hidden.
    await expect(
      upsertProfile(web, OTHER, { handle: 'trstn', displayName: 'Two', published: true }),
    ).rejects.toBeInstanceOf(ProfileError);
  });

  it('frees the handle on delete', async () => {
    await upsertProfile(web, CREATOR, { handle: 'trstn', displayName: 'One', published: true });
    expect(await deleteMyProfile(web, CREATOR)).toBe(true);
    await expect(
      upsertProfile(web, OTHER, { handle: 'trstn', displayName: 'Two', published: true }),
    ).resolves.toMatchObject({ handle: 'trstn' });
  });

  it('will not let one creator edit another’s profile (T4)', async () => {
    await upsertProfile(web, CREATOR, { handle: 'trstn', displayName: 'Mine', published: true });
    // OTHER writing the same handle is a separate row attempt, which the unique index stops;
    // the row-level policy is what stops them reaching the existing one at all.
    expect(await deleteMyProfile(web, OTHER)).toBe(false);
    expect((await getMyProfile(web, CREATOR))?.displayName).toBe('Mine');
  });
});

describe('breaker totals (FR-4.3)', () => {
  beforeEach(async () => {
    await upsertProfile(web, CREATOR, {
      handle: 'trstn',
      displayName: 'GUNDAM with TRSTN',
      published: true,
    });
  });

  it('counts breaks, pulls and packs', async () => {
    const one = await newBreak({ status: 'live' });
    await logRarity(one, 'C', 3);
    await setPacksOpened(web, CREATOR, one, 24);
    await setBreakStatus(web, CREATOR, one, 'ended');

    const profile = await getBreakerProfile(anonymous, 'trstn');
    expect(profile?.totals.breaks).toBe(1);
    expect(profile?.totals.endedBreaks).toBe(1);
    expect(profile?.totals.pulls).toBe(3);
    expect(profile?.totals.totalValueCents).toBe(300);
    expect(profile?.totals.packsOpened).toBe(24);
  });

  it('never counts a draft, which is not part of anyone’s record yet', async () => {
    await newBreak({ status: 'draft' });
    const profile = await getBreakerProfile(anonymous, 'trstn');
    expect(profile?.totals.breaks).toBe(0);
  });

  it('says how many ended breaks recorded no pack count', async () => {
    const counted = await newBreak({ status: 'live' });
    await setPacksOpened(web, CREATOR, counted, 24);
    await setBreakStatus(web, CREATOR, counted, 'ended');
    const uncounted = await newBreak({ status: 'live' });
    await setBreakStatus(web, CREATOR, uncounted, 'ended');

    const profile = await getBreakerProfile(anonymous, 'trstn');
    // The sample is not silently shrunk: the page can say what it left out.
    expect(profile?.totals.breaksWithoutPackCount).toBe(1);
    expect(profile?.totals.packsOpened).toBe(24);
  });

  it('counts nobody else’s breaks', async () => {
    const mine = await newBreak({ status: 'live' });
    await logRarity(mine, 'C', 1);
    await setBreakStatus(web, CREATOR, mine, 'ended');
    const theirs = await newBreak({ owner: OTHER, status: 'live' });
    await setBreakStatus(web, OTHER, theirs, 'ended');

    const profile = await getBreakerProfile(anonymous, 'trstn');
    expect(profile?.totals.breaks).toBe(1);
  });
});

describe('hit rates against published odds (FR-4.3)', () => {
  async function publishOdds(rarity: string, numerator: number, denominator: number) {
    await tdb.db.execute(
      `insert into app.pack_odds (sealed_product_id, rarity, numerator, denominator, source_url)
       values ('${productId}', '${rarity}', ${String(numerator)}, ${String(denominator)},
               'https://example.invalid/odds')`,
    );
  }

  beforeEach(async () => {
    await upsertProfile(web, CREATOR, {
      handle: 'trstn',
      displayName: 'GUNDAM with TRSTN',
      published: true,
    });
  });

  it('reports insufficient rather than accusing anyone on a small sample', async () => {
    await publishOdds('SR', 1, 12);
    const id = await newBreak({ status: 'live' });
    await logRarity(id, 'SR', 0);
    await setPacksOpened(web, CREATOR, id, 24);
    await setBreakStatus(web, CREATOR, id, 'ended');

    const report = (await getBreakerProfile(anonymous, 'trstn'))?.oddsReports[0];
    expect(report?.packs).toBe(24);
    // 24 packs at 1-in-12 expects two hits. Zero is unlucky and proves nothing.
    expect(report?.rarities.find((r) => r.rarity === 'SR')?.verdict).toBe('insufficient');
  });

  it('shows a published rarity that was never pulled', async () => {
    await publishOdds('SR', 1, 12);
    const id = await newBreak({ status: 'live' });
    await logRarity(id, 'C', 5);
    await setPacksOpened(web, CREATOR, id, 24);
    await setBreakStatus(web, CREATOR, id, 'ended');

    const report = (await getBreakerProfile(anonymous, 'trstn'))?.oddsReports[0];
    const sr = report?.rarities.find((r) => r.rarity === 'SR');
    // Zero hits against published odds is evidence, and dropping the row would hide the one
    // case a sceptical reader came for.
    expect(sr).toBeDefined();
    expect(sr?.hits).toBe(0);
  });

  it('cites where the odds came from', async () => {
    await publishOdds('SR', 1, 12);
    const id = await newBreak({ status: 'live' });
    await setPacksOpened(web, CREATOR, id, 24);
    await setBreakStatus(web, CREATOR, id, 'ended');

    const report = (await getBreakerProfile(anonymous, 'trstn'))?.oddsReports[0];
    expect(report?.sources).toContainEqual(
      expect.objectContaining({ rarity: 'SR', sourceUrl: 'https://example.invalid/odds' }),
    );
  });

  it('excludes a break with no pack count from the comparison entirely', async () => {
    await publishOdds('SR', 1, 12);
    const counted = await newBreak({ status: 'live' });
    await logRarity(counted, 'SR', 2);
    await setPacksOpened(web, CREATOR, counted, 24);
    await setBreakStatus(web, CREATOR, counted, 'ended');

    const uncounted = await newBreak({ status: 'live' });
    await logRarity(uncounted, 'SR', 40);
    await setBreakStatus(web, CREATOR, uncounted, 'ended');

    const report = (await getBreakerProfile(anonymous, 'trstn'))?.oddsReports[0];
    // A hit with no denominator behind it cannot be allowed to move a published rate.
    expect(report?.packs).toBe(24);
    expect(report?.rarities.find((r) => r.rarity === 'SR')?.hits).toBe(2);
  });

  it('excludes a live break, which is a sample still being drawn', async () => {
    await publishOdds('C', 1, 2);
    const live = await newBreak({ status: 'live' });
    await setPacksOpened(web, CREATOR, live, 100);
    await logRarity(live, 'C', 60);

    expect((await getBreakerProfile(anonymous, 'trstn'))?.oddsReports).toHaveLength(0);
  });

  it('counts pulls that name no catalogued card separately', async () => {
    const id = await newBreak({ status: 'live' });
    await logPull(web, CREATOR, id, { label: 'Something not in the catalog yet' });
    await logRarity(id, 'C', 1);
    await setPacksOpened(web, CREATOR, id, 24);
    await setBreakStatus(web, CREATOR, id, 'ended');

    const report = (await getBreakerProfile(anonymous, 'trstn'))?.oddsReports[0];
    expect(report?.unidentifiedPulls).toBe(1);
  });

  it('tallies rarities across all breaks for the plain count', async () => {
    const id = await newBreak({ status: 'live' });
    await logRarity(id, 'C', 4);
    await logRarity(id, 'SR', 1);
    await setBreakStatus(web, CREATOR, id, 'ended');

    const counts = (await getBreakerProfile(anonymous, 'trstn'))?.rarityCounts;
    expect(counts).toEqual([
      { rarity: 'C', pulls: 4 },
      { rarity: 'SR', pulls: 1 },
    ]);
  });
});

describe('the verified randomisation badge (FR-4.3)', () => {
  beforeEach(async () => {
    await upsertProfile(web, CREATOR, {
      handle: 'trstn',
      displayName: 'GUNDAM with TRSTN',
      published: true,
    });
  });

  async function committedBreak(): Promise<string> {
    counter += 1;
    const created = await createBreak(web, CREATOR, {
      title: `Committed ${String(counter)}`,
      sealedProductId: productId,
      overlayTokenHash: `badge-hash-${String(counter)}-${String(Date.now())}`,
    });
    await commitBreak(web, CREATOR, created.id, { slotCount: 8, keyRing });
    await setBreakStatus(web, CREATOR, created.id, 'live');
    await logRarity(created.id, 'C', 2);
    await setBreakStatus(web, CREATOR, created.id, 'ended');
    await setClientSeed(web, CREATOR, created.id, 'chat said 42');
    return created.id;
  }

  it('is not awarded for a break that was never committed to', async () => {
    const id = await newBreak({ status: 'live' });
    await logRarity(id, 'C', 2);
    await setBreakStatus(web, CREATOR, id, 'ended');

    const fairness = (await getBreakerProfile(anonymous, 'trstn'))?.fairness;
    expect(fairness?.badge).toBe('none');
    expect(fairness?.chainsValid).toBe(1);
  });

  it('is not awarded until the seed is actually revealed', async () => {
    await committedBreak();
    const fairness = (await getBreakerProfile(anonymous, 'trstn'))?.fairness;
    // Committed but unrevealed proves nothing yet: the seed is still secret, so nobody can
    // check that the commitment matched it.
    expect(fairness?.committed).toBe(1);
    expect(fairness?.revealed).toBe(0);
    expect(fairness?.badge).toBe('none');
  });

  it('is awarded once a commitment is revealed and the chain re-derives', async () => {
    const id = await committedBreak();
    await revealBreak(web, worker, CREATOR, id, keyRing);

    const fairness = (await getBreakerProfile(anonymous, 'trstn'))?.fairness;
    expect(fairness?.revealed).toBe(1);
    expect(fairness?.chainsValid).toBe(1);
    expect(fairness?.chainsBroken).toBe(0);
    expect(fairness?.badge).toBe('verified');
  });

  it('turns to broken when a pull log is edited behind the application’s back (AC-4.2)', async () => {
    const id = await committedBreak();
    await revealBreak(web, worker, CREATOR, id, keyRing);
    // Not through the web role, which by its own grants cannot UPDATE this table. This is
    // somebody at a psql prompt — which is the threat the chain exists for.
    await superuser.execute(
      `update app.break_pulls set value_cents_at_pull = 999999 where break_id = '${id}' and seq = 1`,
    );

    const fairness = (await getBreakerProfile(anonymous, 'trstn'))?.fairness;
    expect(fairness?.chainsBroken).toBe(1);
    // A badge that can only ever be awarded is decoration. This one is evidence.
    expect(fairness?.badge).toBe('broken');
  });

  it('reports how many logs it actually re-checked', async () => {
    const id = await committedBreak();
    await revealBreak(web, worker, CREATOR, id, keyRing);
    const empty = await newBreak({ status: 'live' });
    await setBreakStatus(web, CREATOR, empty, 'ended');

    const fairness = (await getBreakerProfile(anonymous, 'trstn'))?.fairness;
    expect(fairness?.endedBreaks).toBe(2);
    // The empty break has no chain to check, so it is not counted as one that passed.
    expect(fairness?.chainsChecked).toBe(1);
  });
});
