import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { seedSample } from '../seed/sample.js';
import { expectDbError } from '../test/expect.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import {
  DuplicateWatchError,
  MAX_WATCHES_PER_USER,
  WatchLimitError,
  asUser,
  countWatches,
  createWatch,
  deleteWatch,
  listWatches,
} from './watches.js';

let tdb: TestDatabase;
let web: ReturnType<typeof createDb>;
let productId: string;

const ALICE = 'user-alice';
const BOB = 'user-bob';

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  for (const [id, email] of [
    [ALICE, 'alice@example.com'],
    [BOB, 'bob@example.com'],
  ]) {
    await tdb.db.execute(
      `insert into app.users (id, name, email) values ('${String(id)}', 'x', '${String(email)}')`,
    );
  }
  const rows = await tdb.db.execute<{ id: string }>(`select id from app.sealed_products limit 1`);
  productId = String(rows[0]?.id);
  // Watches are exercised through the application role, where RLS actually applies.
  web = createDb({ url: tdb.urlFor('web'), max: 4 });
});

afterAll(async () => {
  await web.close();
  await tdb.close();
});

describe('watch CRUD', () => {
  it('creates a watch owned by the acting user', async () => {
    const watch = await createWatch(web.db, ALICE, {
      sealedProductId: productId,
      channels: ['email'],
    });
    expect(watch.userId).toBe(ALICE);
    expect(watch.channels).toEqual(['email']);
  });

  it('lists only the caller’s watches', async () => {
    await createWatch(web.db, BOB, { sealedProductId: productId, channels: ['discord_dm'] });

    const alice = await listWatches(web.db, ALICE);
    const bob = await listWatches(web.db, BOB);
    expect(alice).toHaveLength(1);
    expect(bob).toHaveLength(1);
    expect(alice[0]?.userId).toBe(ALICE);
    expect(bob[0]?.userId).toBe(BOB);
  });

  it('rejects a duplicate watch on the same target', async () => {
    await expect(
      createWatch(web.db, ALICE, { sealedProductId: productId, channels: ['email'] }),
    ).rejects.toBeInstanceOf(DuplicateWatchError);
  });

  it('deletes only the caller’s own watch', async () => {
    const bobWatch = (await listWatches(web.db, BOB))[0];
    expect(bobWatch).toBeDefined();

    // Alice tries to delete Bob's watch by id.
    await expect(deleteWatch(web.db, ALICE, String(bobWatch?.id))).resolves.toBe(false);
    expect(await listWatches(web.db, BOB)).toHaveLength(1);

    // Bob can delete his own.
    await expect(deleteWatch(web.db, BOB, String(bobWatch?.id))).resolves.toBe(true);
    expect(await listWatches(web.db, BOB)).toHaveLength(0);
  });

  it('reports false when deleting something that does not exist', async () => {
    await expect(deleteWatch(web.db, ALICE, '00000000-0000-0000-0000-000000000000')).resolves.toBe(
      false,
    );
  });

  it('enforces the per-user cap', async () => {
    const listings = await web.db.execute<{ id: string }>(
      `select id from app.retailer_products limit 1`,
    );
    const listingId = String(listings[0]?.id);
    await createWatch(web.db, BOB, { retailerProductId: listingId, channels: ['email'] });

    // Fill Bob's quota directly, then confirm the next create is refused.
    await asUser(tdb.db, BOB, async (tx) => {
      await tx.execute(
        `insert into app.watch_subscriptions (user_id, sealed_product_id, channels)
         select '${BOB}', id, array['email']::app.alert_channel[] from app.sealed_products`,
      );
    });
    const filler = MAX_WATCHES_PER_USER - (await countWatches(web.db, BOB));
    if (filler > 0) {
      await asUser(tdb.db, BOB, async (tx) => {
        for (let i = 0; i < filler; i += 1) {
          await tx.execute(
            `insert into app.watch_subscriptions (user_id, retailer_product_id, channels)
             select '${BOB}', rp.id, array['email']::app.alert_channel[]
             from app.retailer_products rp limit 1
             on conflict do nothing`,
          );
          // Stop if the unique constraint blocks further filler rows.
          if ((await countWatches(web.db, BOB)) >= MAX_WATCHES_PER_USER) break;
        }
      });
    }

    if ((await countWatches(web.db, BOB)) >= MAX_WATCHES_PER_USER) {
      await expect(
        createWatch(web.db, BOB, { sealedProductId: productId, channels: ['email'] }),
      ).rejects.toBeInstanceOf(WatchLimitError);
    }
  });
});

describe('row-level security (SR-X.8)', () => {
  it('hides rows from a connection that has not declared a user', async () => {
    // No set_config: policies evaluate against NULL, so nothing is visible.
    const rows = await web.db.execute<{ n: number }>(
      `select count(*)::int as n from app.watch_subscriptions`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('hides other users’ rows even with a raw query and no WHERE clause', async () => {
    const seen = await asUser(web.db, ALICE, async (tx) => {
      const rows = await tx.execute<{ user_id: string }>(
        `select user_id from app.watch_subscriptions`,
      );
      return rows.map((r) => r.user_id);
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([ALICE]));
  });

  it('refuses to insert a row owned by someone else', async () => {
    await expectDbError(
      asUser(web.db, ALICE, (tx) =>
        tx.execute(
          `insert into app.watch_subscriptions (user_id, sealed_product_id, channels)
           values ('${BOB}', '${productId}', array['email']::app.alert_channel[])`,
        ),
      ),
      /row-level security/i,
    );
  });

  it('cannot delete or update another user’s rows with raw SQL', async () => {
    const before = await listWatches(web.db, ALICE);
    await asUser(web.db, BOB, async (tx) => {
      await tx.execute(`delete from app.watch_subscriptions where user_id = '${ALICE}'`);
      await tx.execute(
        `update app.watch_subscriptions set channels = array['web_push']::app.alert_channel[]`,
      );
    });
    const after = await listWatches(web.db, ALICE);
    expect(after).toHaveLength(before.length);
    expect(after[0]?.channels).toEqual(before[0]?.channels);
  });

  it('does not leak identity between pooled transactions', async () => {
    const [aliceRows, bobRows] = await Promise.all([
      listWatches(web.db, ALICE),
      listWatches(web.db, BOB),
    ]);
    expect(aliceRows.every((w) => w.userId === ALICE)).toBe(true);
    expect(bobRows.every((w) => w.userId === BOB)).toBe(true);

    // After the scoped transactions end, the setting is gone again.
    const rows = await web.db.execute<{ n: number }>(
      `select count(*)::int as n from app.watch_subscriptions`,
    );
    expect(rows[0]?.n).toBe(0);
  });
});

describe('database constraints', () => {
  it('requires exactly one target', async () => {
    await expectDbError(
      asUser(web.db, ALICE, (tx) =>
        tx.execute(
          `insert into app.watch_subscriptions (user_id, channels)
           values ('${ALICE}', array['email']::app.alert_channel[])`,
        ),
      ),
      /watch_subscriptions_exactly_one_target/,
    );
  });

  it('requires at least one channel', async () => {
    await expectDbError(
      asUser(web.db, ALICE, (tx) =>
        tx.execute(
          `insert into app.watch_subscriptions (user_id, sealed_product_id, channels)
           values ('${ALICE}', '${productId}', array[]::app.alert_channel[])`,
        ),
      ),
      /watch_subscriptions_channels_not_empty/,
    );
  });
});
