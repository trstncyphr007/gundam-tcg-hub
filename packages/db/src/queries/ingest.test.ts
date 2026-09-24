import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { seedSample } from '../seed/sample.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import {
  abandonDelivery,
  claimDeliveries,
  claimRetryableDeliveries,
  consumeApiKeyQuota,
  createApiKey,
  findActiveApiKey,
  findFanOutTargets,
  listDeliveriesForEvent,
  markDeliveryFailed,
  markDeliverySent,
  recordStockReport,
  revokeApiKey,
  touchApiKey,
} from './ingest.js';
import { getRestockContext } from './messages.js';
import { asUser } from './watches.js';

let tdb: TestDatabase;
let worker: ReturnType<typeof createDb>;
let listingId: string;
let productId: string;

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  const rows = await tdb.db.execute<{ id: string; sealed_product_id: string }>(
    `select id, sealed_product_id from app.retailer_products limit 1`,
  );
  listingId = String(rows[0]?.id);
  productId = String(rows[0]?.sealed_product_id);
  worker = createDb({ url: tdb.urlFor('worker'), max: 3 });
});

afterAll(async () => {
  await worker.close();
  await tdb.close();
});

describe('recordStockReport (FR-1.7)', () => {
  it('never raises an event on the first sighting', async () => {
    const first = await recordStockReport(worker.db, {
      retailerProductId: listingId,
      inStock: true,
    });
    expect(first.firstSighting).toBe(true);
    expect(first.event).toBeNull();
  });

  it('raises an event only on out-of-stock → in-stock', async () => {
    await recordStockReport(worker.db, { retailerProductId: listingId, inStock: false });
    const restock = await recordStockReport(worker.db, {
      retailerProductId: listingId,
      inStock: true,
      priceCents: 8999,
    });
    expect(restock.event).not.toBeNull();
    expect(restock.event?.priceCents).toBe(8999);

    const stillIn = await recordStockReport(worker.db, {
      retailerProductId: listingId,
      inStock: true,
    });
    expect(stillIn.event).toBeNull();

    const goesOut = await recordStockReport(worker.db, {
      retailerProductId: listingId,
      inStock: false,
    });
    expect(goesOut.event).toBeNull();
  });

  it('defaults currency and stores optional fields', async () => {
    const result = await recordStockReport(worker.db, {
      retailerProductId: listingId,
      inStock: true,
      rawHash: 'abc123',
    });
    expect(result.event?.currency).toBe('USD');
    const snapshots = await worker.db.execute<{ raw_hash: string }>(
      `select raw_hash from app.stock_snapshots where id = '${result.snapshotId}'`,
    );
    expect(snapshots[0]?.raw_hash).toBe('abc123');
  });

  it('rejects an unknown listing', async () => {
    await expect(
      recordStockReport(worker.db, {
        retailerProductId: '00000000-0000-0000-0000-000000000000',
        inStock: true,
      }),
    ).rejects.toThrow();
  });
});

describe('the alerts still owed (FR-1.8)', () => {
  /**
   * Its own watcher, rather than relying on one another block happens to create first. A
   * fixture that depends on test order is a fixture that breaks when somebody reorders them.
   */
  beforeAll(async () => {
    await tdb.db.execute(
      `insert into app.users (id, name, email) values ('owed-user', 'Owed', 'owed@example.com')
       on conflict do nothing`,
    );
    await asUser(tdb.db, 'owed-user', (tx) =>
      tx.execute(
        `insert into app.watch_subscriptions (user_id, sealed_product_id, channels)
         values ('owed-user', '${productId}', array['email']::app.alert_channel[])
         on conflict do nothing`,
      ),
    );
  });

  /** A restock with one claimed delivery, left in whatever state the test needs. */
  async function owed(
    overrides: {
      status?: string;
      attempts?: number;
      ageMinutes?: number;
      eventHoursAgo?: number;
    } = {},
  ): Promise<{ eventId: string; deliveryId: string }> {
    const { status = 'pending', attempts = 1, ageMinutes = 10, eventHoursAgo = 0 } = overrides;
    await recordStockReport(worker.db, { retailerProductId: listingId, inStock: false });
    const { event } = await recordStockReport(worker.db, {
      retailerProductId: listingId,
      inStock: true,
    });
    const eventId = String(event?.id);
    const targets = await findFanOutTargets(worker.db, listingId);
    const claimed = await claimDeliveries(worker.db, eventId, targets);
    const deliveryId = String(claimed[0]?.id);

    await tdb.db.execute(
      `update app.alert_deliveries
          set status = '${status}',
              attempts = ${String(attempts)},
              created_at = now() - make_interval(mins => ${String(ageMinutes)})
        where id = '${deliveryId}'`,
    );
    await tdb.db.execute(
      `update app.restock_events
          set detected_at = now() - make_interval(hours => ${String(eventHoursAgo)})
        where id = '${eventId}'`,
    );
    return { eventId, deliveryId };
  }

  const ids = (rows: { id: string }[]): string[] => rows.map((r) => r.id);

  it('offers a delivery nobody has managed to send', async () => {
    const { deliveryId } = await owed();
    const rows = await claimRetryableDeliveries(worker.db);
    expect(ids(rows)).toContain(deliveryId);
    // Enough to rebuild the message a retry has to send.
    const row = rows.find((r) => r.id === deliveryId);
    expect(row?.retailerProductId).toBe(listingId);
    expect(row?.detectedAt).toBeInstanceOf(Date);
  });

  it('leaves alone a delivery a fan-out may still be working on', async () => {
    // The row was created seconds ago, which is what an in-flight delivery looks like. Taking
    // it here would send the same alert twice — the failure people actually notice.
    const { deliveryId } = await owed({ ageMinutes: 0 });
    const rows = await claimRetryableDeliveries(worker.db);
    expect(ids(rows)).not.toContain(deliveryId);
  });

  it('stops at the attempt cap', async () => {
    const { deliveryId } = await owed({ attempts: 5 });
    expect(ids(await claimRetryableDeliveries(worker.db))).not.toContain(deliveryId);
  });

  it('will not resurrect an alert about yesterday', async () => {
    // Telling somebody a box came back in stock yesterday is not a late alert, it is a wrong
    // one: they will go and look, and it will be gone.
    const { deliveryId } = await owed({ eventHoursAgo: 30 });
    expect(ids(await claimRetryableDeliveries(worker.db))).not.toContain(deliveryId);
  });

  it('ignores anything already settled', async () => {
    for (const status of ['sent', 'failed', 'skipped']) {
      const { deliveryId } = await owed({ status });
      expect(ids(await claimRetryableDeliveries(worker.db)), status).not.toContain(deliveryId);
    }
  });

  it('abandons one for good', async () => {
    const { deliveryId } = await owed();
    await abandonDelivery(worker.db, deliveryId, 'gave up');
    expect(ids(await claimRetryableDeliveries(worker.db))).not.toContain(deliveryId);
  });
});

describe('fan-out and deliveries (FR-1.8)', () => {
  it('finds watchers of both the listing and its product, and nothing for unknown ids', async () => {
    await tdb.db.execute(
      `insert into app.users (id, name, email) values ('i-user-1', 'One', 'one@example.com')`,
    );
    await asUser(tdb.db, 'i-user-1', (tx) =>
      tx.execute(
        `insert into app.watch_subscriptions (user_id, sealed_product_id, channels)
         values ('i-user-1', '${productId}', array['email']::app.alert_channel[])`,
      ),
    );

    const targets = await findFanOutTargets(worker.db, listingId);
    expect(targets.map((t) => t.email)).toContain('one@example.com');

    await expect(
      findFanOutTargets(worker.db, '00000000-0000-0000-0000-000000000000'),
    ).resolves.toEqual([]);
  });

  it('claims delivery slots once and records outcomes', async () => {
    await recordStockReport(worker.db, { retailerProductId: listingId, inStock: false });
    const { event } = await recordStockReport(worker.db, {
      retailerProductId: listingId,
      inStock: true,
    });
    expect(event).not.toBeNull();

    const targets = await findFanOutTargets(worker.db, listingId);
    const claimed = await claimDeliveries(worker.db, String(event?.id), targets);
    expect(claimed.length).toBeGreaterThan(0);

    // Second claim for the same event returns nothing: the unique index is the guard.
    await expect(claimDeliveries(worker.db, String(event?.id), targets)).resolves.toEqual([]);

    // The one that was actually marked, not whichever the list happens to return first: this
    // listing has more than one watcher, and `[0]` was quietly assuming it did not.
    const id = String(claimed[0]?.id);
    const mine = async (): Promise<(typeof claimed)[0] | undefined> =>
      (await listDeliveriesForEvent(worker.db, String(event?.id))).find((d) => d.id === id);

    await markDeliverySent(worker.db, id);
    expect((await mine())?.status).toBe('sent');
    expect((await mine())?.attempts).toBe(1);

    await markDeliveryFailed(worker.db, id, 'x'.repeat(400));
    const afterFail = await mine();
    expect(afterFail?.status).toBe('failed');
    // Error text is truncated so a huge upstream message cannot bloat the table.
    expect(afterFail?.lastError?.length).toBe(300);
    expect(afterFail?.attempts).toBe(2);

    await markDeliveryFailed(worker.db, id, 'unsupported', 'skipped');
    expect((await mine())?.status).toBe('skipped');
  });

  it('claims nothing when there are no targets', async () => {
    await expect(
      claimDeliveries(worker.db, '00000000-0000-0000-0000-000000000000', []),
    ).resolves.toEqual([]);
  });
});

describe('api keys (SR-3.1)', () => {
  it('creates, finds, touches and revokes', async () => {
    const created = await createApiKey(tdb.db, {
      name: 'scanner',
      prefix: 'abcd1234',
      keyHash: 'hash-value',
      scopes: ['ingest:write'],
    });
    expect(created.scopes).toEqual(['ingest:write']);

    const found = await findActiveApiKey(worker.db, 'abcd1234');
    expect(found?.id).toBe(created.id);
    expect(found?.lastUsedAt).toBeNull();

    await touchApiKey(worker.db, created.id);
    expect((await findActiveApiKey(worker.db, 'abcd1234'))?.lastUsedAt).not.toBeNull();

    expect(await revokeApiKey(tdb.db, 'abcd1234')).toBe(true);
    await expect(findActiveApiKey(worker.db, 'abcd1234')).resolves.toBeNull();
    // Revoking again is a no-op, not an error.
    expect(await revokeApiKey(tdb.db, 'abcd1234')).toBe(false);
  });

  it('returns null for an unknown prefix', async () => {
    await expect(findActiveApiKey(worker.db, 'nosuchpk')).resolves.toBeNull();
  });

  it('counts a daily quota that outlives the process, and rolls over on the UTC day', async () => {
    const key = await createApiKey(tdb.db, {
      name: 'quota',
      prefix: 'quota001',
      keyHash: 'hash-value',
      scopes: ['prices:read'],
    });

    // Counted on the worker role, which is the point of the column grant in migration 0040:
    // the tier that verifies keys may increment this and still may not re-scope or un-revoke
    // one. A missing grant would fail this line as a permission error, not a wrong number.
    expect(await consumeApiKeyQuota(worker.db, key.id)).toBe(1);
    expect(await consumeApiKeyQuota(worker.db, key.id)).toBe(2);

    // Nothing in the API is holding that 2. It is on the row, which is what makes a restart
    // uninteresting — and was the entire bug.
    const stored = await tdb.db.execute<{ quota_used: number }>(
      `select quota_used from app.api_keys where prefix = 'quota001'`,
    );
    expect(stored[0]?.quota_used).toBe(2);

    // Backdate the day and count again: the new day starts at one, with no sweeper and
    // nothing scheduled. The roll-over lives inside the same statement that counts.
    await tdb.db.execute(`update app.api_keys set quota_day = current_date - 1
                           where prefix = 'quota001'`);
    expect(await consumeApiKeyQuota(worker.db, key.id)).toBe(1);

    // A key that has gone says so, rather than throwing at the caller.
    await expect(
      consumeApiKeyQuota(worker.db, '00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeNull();
  });

  it('cannot be read by the public read-only role', async () => {
    const ro = createDb({ url: tdb.urlFor('readonly'), max: 1 });
    try {
      await expect(ro.db.execute(`select * from app.api_keys`)).rejects.toThrow();
    } finally {
      await ro.close();
    }
  });
});

describe('getRestockContext', () => {
  it('returns product, retailer and url for an alert', async () => {
    const context = await getRestockContext(worker.db, listingId);
    expect(context).toMatchObject({
      productName: 'Sample Set One Booster Box',
      retailerName: 'Sample Retailer',
    });
    expect(context?.url).toMatch(/^https:\/\//);
  });

  it('returns null for an unknown listing', async () => {
    await expect(
      getRestockContext(worker.db, '00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeNull();
  });
});
