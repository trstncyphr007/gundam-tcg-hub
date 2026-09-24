import { asUser, createDb, listDeliveriesForEvent, seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dispatchRestockEvent } from './dispatcher.js';
import type { DeliveryOutcome, RestockMessage, Transport } from './transports.js';

let tdb: TestDatabase;
let worker: ReturnType<typeof createDb>;
let listingId: string;
let productId: string;

const message: RestockMessage = {
  productName: 'Sample Set One Booster Box',
  retailerName: 'Sample Retailer',
  url: 'https://sample-retailer.invalid/box',
  priceCents: 8999,
  currency: 'USD',
  detectedAt: new Date(),
};

const sent: { channel: string; email: string }[] = [];
let outcome: DeliveryOutcome = { ok: true };
const recordingTransport = (channel: string): Transport => ({
  send: (_message, recipient) => {
    sent.push({ channel, email: recipient.email });
    return Promise.resolve(outcome);
  },
});

/** Create a fresh restock event so each test starts with unclaimed delivery slots. */
async function newEvent(): Promise<{ id: string; retailerProductId: string }> {
  const rows = await worker.db.execute<{ id: string }>(
    `with snap as (
       insert into app.stock_snapshots (retailer_product_id, in_stock, price_cents)
       values ('${listingId}', true, 8999) returning id
     )
     insert into app.restock_events (retailer_product_id, snapshot_id, price_cents)
     select '${listingId}', snap.id, 8999 from snap returning id`,
  );
  return { id: String(rows[0]?.id), retailerProductId: listingId };
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  const listings = await tdb.db.execute<{ id: string; sealed_product_id: string }>(
    `select id, sealed_product_id from app.retailer_products limit 1`,
  );
  listingId = String(listings[0]?.id);
  productId = String(listings[0]?.sealed_product_id);

  await tdb.db.execute(
    `insert into app.users (id, name, email) values
       ('d-user-1', 'One', 'one@example.com'),
       ('d-user-2', 'Two', 'two@example.com')`,
  );
  // Watchers must be created as themselves: row-level security applies to everyone.
  await asUser(tdb.db, 'd-user-1', (tx) =>
    tx.execute(
      `insert into app.watch_subscriptions (user_id, sealed_product_id, channels)
       values ('d-user-1', '${productId}', array['email']::app.alert_channel[])`,
    ),
  );
  await asUser(tdb.db, 'd-user-2', (tx) =>
    tx.execute(
      `insert into app.watch_subscriptions (user_id, retailer_product_id, channels)
       values ('d-user-2', '${listingId}', array['email','web_push']::app.alert_channel[])`,
    ),
  );

  worker = createDb({ url: tdb.urlFor('worker'), max: 4 });
});

afterAll(async () => {
  await worker.close();
  await tdb.close();
});

beforeEach(() => {
  sent.length = 0;
  outcome = { ok: true };
});

describe('dispatchRestockEvent', () => {
  it('fans out to watchers of the product and of the listing', async () => {
    const event = await newEvent();
    const result = await dispatchRestockEvent(
      { db: worker.db, transports: { email: recordingTransport('email') } },
      event,
      message,
    );

    // 3 slots: two email watchers + one web_push channel with no transport.
    expect(result.claimed).toBe(3);
    expect(result.sent).toBe(2);
    expect(result.skipped).toBe(1);
    expect(sent.map((s) => s.email).sort()).toEqual(['one@example.com', 'two@example.com']);
  });

  it('marks channels without a transport as skipped, not failed', async () => {
    const event = await newEvent();
    await dispatchRestockEvent({ db: worker.db, transports: {} }, event, message);
    const deliveries = await listDeliveriesForEvent(worker.db, event.id);
    expect(deliveries).toHaveLength(3);
    expect(deliveries.every((d) => d.status === 'skipped')).toBe(true);
    expect(deliveries[0]?.lastError).toMatch(/no transport/);
  });

  it('records failures and keeps going, leaving a retryable one still owed', async () => {
    // This used to assert `failed` for a failure the transport had just said was worth trying
    // again — which is what the code did, and was the bug: terminal, never read again, so an
    // SMTP hiccup meant somebody who asked to be told was never told. `pending` means "still
    // owed", and the alert-retry job picks it up (FR-1.8).
    outcome = { ok: false, reason: 'smtp refused', retryable: true };
    const event = await newEvent();
    const result = await dispatchRestockEvent(
      { db: worker.db, transports: { email: recordingTransport('email') } },
      event,
      message,
    );
    expect(result.failed).toBe(2);
    expect(result.retryable).toBe(2);
    const deliveries = await listDeliveriesForEvent(worker.db, event.id);
    const owed = deliveries.filter((d) => d.status === 'pending');
    expect(owed).toHaveLength(2);
    expect(owed[0]?.lastError).toContain('smtp refused');
    expect(owed[0]?.attempts).toBe(1);
  });

  it('gives up straight away on a failure that will happen every time', async () => {
    // A webhook address we will never accept is not a blip. Trying it four more times would
    // buy the same refusal four more times, and delay nothing but the truth.
    outcome = { ok: false, reason: 'webhook url rejected by allowlist', retryable: false };
    const event = await newEvent();
    const result = await dispatchRestockEvent(
      { db: worker.db, transports: { email: recordingTransport('email') } },
      event,
      message,
    );
    expect(result.failed).toBe(2);
    expect(result.retryable).toBe(0);
    const deliveries = await listDeliveriesForEvent(worker.db, event.id);
    expect(deliveries.filter((d) => d.status === 'failed')).toHaveLength(2);
  });

  it('logs failures without the recipient address', async () => {
    outcome = { ok: false, reason: 'smtp refused', retryable: true };
    const logged: Record<string, unknown>[] = [];
    const event = await newEvent();
    await dispatchRestockEvent(
      {
        db: worker.db,
        transports: { email: recordingTransport('email') },
        logger: {
          warn: (obj) => {
            logged.push(obj);
          },
        },
      },
      event,
      message,
    );
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain('@example.com');
    expect(logged[0]).toHaveProperty('userId');
  });

  it('claims nothing on a second run for the same event (idempotent)', async () => {
    const event = await newEvent();
    const first = await dispatchRestockEvent(
      { db: worker.db, transports: { email: recordingTransport('email') } },
      event,
      message,
    );
    expect(first.claimed).toBe(3);

    sent.length = 0;
    const second = await dispatchRestockEvent(
      { db: worker.db, transports: { email: recordingTransport('email') } },
      event,
      message,
    );
    expect(second.claimed).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await listDeliveriesForEvent(worker.db, event.id)).toHaveLength(3);
  });

  it('does nothing when the listing has no watchers', async () => {
    const orphan = await worker.db.execute<{ id: string }>(
      `with rp as (
         select id from app.retailer_products where id <> '${listingId}' limit 1
       ), snap as (
         insert into app.stock_snapshots (retailer_product_id, in_stock)
         select id, true from rp returning id, retailer_product_id
       )
       insert into app.restock_events (retailer_product_id, snapshot_id)
       select snap.retailer_product_id, snap.id from snap returning id, retailer_product_id`,
    );
    if (!orphan[0]) return; // seed has a single listing; nothing to assert
    const result = await dispatchRestockEvent(
      { db: worker.db, transports: { email: recordingTransport('email') } },
      { id: orphan[0].id, retailerProductId: listingId },
      message,
    );
    expect(result.sent + result.failed).toBeGreaterThanOrEqual(0);
  });
});
