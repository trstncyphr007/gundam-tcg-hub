import { ORDER_STATUSES } from '@gth/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { seedSample } from '../seed/sample.js';
import { expectDbError } from '../test/expect.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import { asUser } from './watches.js';

/**
 * What the database refuses on its own (Phase 5, §14, SR-5.7).
 *
 * `@gth/core`'s state machine says only Stripe may mark an order paid. That is a rule in
 * TypeScript, and TypeScript is not what stands between a compromised web process and
 * somebody's money — so the same rule is written again as a row-level policy, and these tests
 * are about the second copy.
 *
 * Every assertion here is made by *doing the thing* on the role that would do it in
 * production, rather than by reading the policy back. A policy that exists and does not apply
 * looks exactly like one that does.
 */
let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let readonlyPool: ReturnType<typeof createDb>;
let web: TestDatabase['db'];
let worker: TestDatabase['db'];
/** No session at all, which is a different thing from being somebody else. */
let anonymous: TestDatabase['db'];

const BUYER = 'market-buyer';
const SELLER = 'market-seller';
const STRANGER = 'market-stranger';

let variantId = '';

/** A listing owned by SELLER, in whatever state the test needs. */
async function newListing(status: 'draft' | 'active' = 'active'): Promise<string> {
  const rows = await asUser(web, SELLER, (tx) =>
    tx.execute<{ id: string }>(`
      insert into app.listings (seller_id, card_variant_id, condition, price_cents, status)
      values ('${SELLER}', '${variantId}', 'nm', 2500, '${status}')
      returning id
    `),
  );
  return String(rows[0]?.id);
}

/**
 * An order BUYER placed with SELLER, already paid.
 *
 * Written on the worker, because that is the only role that can put an order into `paid` —
 * which is the whole point of this file, and makes the fixture itself a small proof of it.
 */
async function newPaidOrder(): Promise<string> {
  const listing = await newListing();
  const rows = await worker.execute<{ id: string }>(`
    insert into app.orders
      (buyer_id, seller_id, listing_id, card_variant_id, condition, amount_cents,
       status, stripe_payment_intent_id)
    values ('${BUYER}', '${SELLER}', '${listing}', '${variantId}', 'nm', 2500,
            'paid', 'pi_${Math.random().toString(36).slice(2)}')
    returning id
  `);
  return String(rows[0]?.id);
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 2 });
  readonlyPool = createDb({ url: tdb.urlFor('readonly'), max: 2 });
  web = webPool.db;
  worker = workerPool.db;
  anonymous = readonlyPool.db;

  for (const id of [BUYER, SELLER, STRANGER]) {
    await tdb.db.execute(
      `insert into app.users (id, name, email) values ('${id}', '${id}', '${id}@example.invalid')`,
    );
  }
  const variants = await tdb.db.execute<{ id: string }>(`select id from app.card_variants limit 1`);
  variantId = String(variants[0]?.id);
}, 180_000);

afterAll(async () => {
  await webPool.close();
  await workerPool.close();
  await readonlyPool.close();
  await tdb.close();
});

beforeEach(async () => {
  // TRUNCATE, because DELETE cannot do this and should not be able to.
  //
  // These tables FORCE row-level security, which applies to the schema owner too, so a
  // migrator DELETE matches nothing and returns quietly — that is how the first run of this
  // file reported eleven listings where it expected one. And no role has DELETE on `orders`
  // or `order_events` at all: an order is a financial record that ends in a terminal status,
  // not in nothing, and its history is evidence.
  //
  // TRUNCATE is the owner's privilege and is not subject to policies, which makes it the
  // right tool for resetting a fixture and the wrong one for anything the application does.
  await tdb.db.execute(`truncate app.orders, app.listings, app.webhook_events cascade`);
});

describe('who may say an order was paid', () => {
  it('refuses a session, whichever party it belongs to', async () => {
    // The headline. A buyer or a seller marking an order paid would be asserting a payment
    // that may never have happened, and no amount of correct route code is a defence if the
    // database will accept it.
    const order = await newPaidOrder();
    await worker.execute(`update app.orders set status = 'created' where id = '${order}'`);

    for (const who of [BUYER, SELLER]) {
      await expectDbError(
        asUser(web, who, (tx) =>
          tx.execute(`update app.orders set status = 'paid' where id = '${order}'`),
        ),
        /row-level security/i,
      );
    }
  });

  it('refuses the other three a session must not cause either', async () => {
    // `refunded` is money moving back. `delivered` and `completed` release the payout, and
    // the seller is the one who benefits from both.
    const order = await newPaidOrder();
    await worker.execute(
      `update app.orders set status = 'shipped', tracking_carrier = 'royal-mail',
              tracking_number = 'AB123' where id = '${order}'`,
    );

    for (const status of ['refunded', 'delivered', 'completed']) {
      await expectDbError(
        asUser(web, SELLER, (tx) =>
          tx.execute(`update app.orders set status = '${status}' where id = '${order}'`),
        ),
        /row-level security/i,
      );
    }
  });

  it('lets the seller say they posted it, which is the one they did do', async () => {
    const order = await newPaidOrder();
    await asUser(web, SELLER, (tx) =>
      tx.execute(`
        update app.orders
           set status = 'shipped', tracking_carrier = 'royal-mail', tracking_number = 'AB123'
         where id = '${order}'
      `),
    );
    const [row] = await worker.execute<{ status: string }>(
      `select status from app.orders where id = '${order}'`,
    );
    expect(row?.status).toBe('shipped');
  });

  it('lets the worker, because that is where a verified webhook runs', async () => {
    const order = await newPaidOrder();
    await worker.execute(`update app.orders set status = 'refunded' where id = '${order}'`);
    const [row] = await worker.execute<{ status: string }>(
      `select status from app.orders where id = '${order}'`,
    );
    expect(row?.status).toBe('refunded');
  });
});

describe('who may see an order', () => {
  it('shows it to both parties and to nobody else', async () => {
    const order = await newPaidOrder();
    const visibleTo = async (who: string): Promise<number> => {
      const rows = await asUser(web, who, (tx) =>
        tx.execute<{ id: string }>(`select id from app.orders where id = '${order}'`),
      );
      return rows.length;
    };

    expect(await visibleTo(BUYER)).toBe(1);
    expect(await visibleTo(SELLER)).toBe(1);
    expect(await visibleTo(STRANGER)).toBe(0);
  });

  it('shows it to no one without a session', async () => {
    await newPaidOrder();
    // The public API's role. An order is nobody's business but the two people in it.
    await expectDbError(anonymous.execute(`select id from app.orders`), /permission/i);
  });
});

describe('the rules the tables keep by themselves', () => {
  it('will not let anybody buy their own card', async () => {
    // Wash trading is how a marketplace's numbers stop meaning anything.
    const listing = await newListing();
    await expectDbError(
      worker.execute(`
        insert into app.orders
          (buyer_id, seller_id, listing_id, card_variant_id, condition, amount_cents)
        values ('${SELLER}', '${SELLER}', '${listing}', '${variantId}', 'nm', 2500)
      `),
      /orders_not_self_dealing/,
    );
  });

  it('will not record a payment that has no payment behind it', async () => {
    const listing = await newListing();
    await expectDbError(
      worker.execute(`
        insert into app.orders
          (buyer_id, seller_id, listing_id, card_variant_id, condition, amount_cents, status)
        values ('${BUYER}', '${SELLER}', '${listing}', '${variantId}', 'nm', 2500, 'paid')
      `),
      /orders_paid_has_payment/,
    );
  });

  it('will not call an order shipped with nothing to track', async () => {
    const order = await newPaidOrder();
    await expectDbError(
      worker.execute(`update app.orders set status = 'shipped' where id = '${order}'`),
      /orders_shipped_has_tracking/,
    );
  });

  it('will not let our fee exceed what was charged', async () => {
    const listing = await newListing();
    await expectDbError(
      worker.execute(`
        insert into app.orders
          (buyer_id, seller_id, listing_id, card_variant_id, condition, amount_cents, fee_cents)
        values ('${BUYER}', '${SELLER}', '${listing}', '${variantId}', 'nm', 2500, 3000)
      `),
      /orders_fee_within_amount/,
    );
  });
});

describe('listings', () => {
  it('shows a draft to its owner and to nobody else', async () => {
    await newListing('draft');
    const seenBy = async (who: string): Promise<number> =>
      (await asUser(web, who, (tx) => tx.execute<{ id: string }>(`select id from app.listings`)))
        .length;

    expect(await seenBy(SELLER)).toBe(1);
    expect(await seenBy(STRANGER)).toBe(0);
    expect((await anonymous.execute<{ id: string }>(`select id from app.listings`)).length).toBe(0);
  });

  it('shows an active one to everybody, session or not', async () => {
    await newListing('active');
    expect(
      (
        await asUser(web, STRANGER, (tx) =>
          tx.execute<{ id: string }>(`select id from app.listings`),
        )
      ).length,
    ).toBe(1);
    expect((await anonymous.execute<{ id: string }>(`select id from app.listings`)).length).toBe(1);
  });

  it('will not let a seller hand their listing to somebody else', async () => {
    // WITH CHECK, not just USING: without it the row you are allowed to change could be
    // changed into one you are not allowed to have.
    const listing = await newListing();
    await expectDbError(
      asUser(web, SELLER, (tx) =>
        tx.execute(`update app.listings set seller_id = '${STRANGER}' where id = '${listing}'`),
      ),
      /row-level security/i,
    );
  });

  it('will not let a stranger edit one at all', async () => {
    const listing = await newListing();
    const changed = await asUser(web, STRANGER, (tx) =>
      tx.execute(`update app.listings set price_cents = 1 where id = '${listing}'`),
    );
    // Nothing matched, because the row is not visible to update. A silent no-op is the
    // correct answer here — it tells the caller nothing about what exists.
    expect(changed.length).toBe(0);
    const [row] = await worker.execute<{ price_cents: number }>(
      `select price_cents from app.listings where id = '${listing}'`,
    );
    expect(row?.price_cents).toBe(2500);
  });
});

describe('the history of an order', () => {
  it('cannot be edited or deleted by anyone', async () => {
    // The record two parties reach for when they disagree. A history the application can
    // rewrite is not evidence.
    const order = await newPaidOrder();
    await worker.execute(`
      insert into app.order_events (order_id, from_status, to_status, actor)
      values ('${order}', 'created', 'paid', 'stripe')
    `);

    for (const db of [web, worker]) {
      await expectDbError(
        db.execute(`update app.order_events set to_status = 'completed'`),
        /permission denied/i,
      );
      await expectDbError(db.execute(`delete from app.order_events`), /permission denied/i);
    }
  });

  it('is visible to the parties and not to a stranger', async () => {
    const order = await newPaidOrder();
    await worker.execute(`
      insert into app.order_events (order_id, from_status, to_status, actor)
      values ('${order}', 'created', 'paid', 'stripe')
    `);

    const seenBy = async (who: string): Promise<number> =>
      (
        await asUser(web, who, (tx) =>
          tx.execute<{ id: string }>(`select id from app.order_events`),
        )
      ).length;

    expect(await seenBy(BUYER)).toBe(1);
    expect(await seenBy(STRANGER)).toBe(0);
  });
});

describe('webhooks', () => {
  it('cannot record the same event twice', async () => {
    // The whole idempotency mechanism (SR-5.2): insert first, and a conflict means it has
    // been seen. A retry processed twice is an order shipped twice.
    await worker.execute(`
      insert into app.webhook_events (provider, event_id, type)
      values ('stripe', 'evt_123', 'checkout.session.completed')
    `);
    await expectDbError(
      worker.execute(`
        insert into app.webhook_events (provider, event_id, type)
        values ('stripe', 'evt_123', 'checkout.session.completed')
      `),
      /webhook_events_provider_event_key/,
    );
  });

  it('is not something a session can read or write', async () => {
    await expectDbError(web.execute(`select id from app.webhook_events`), /permission/i);
  });
});

describe('the enum and the state machine', () => {
  it('agree about which statuses exist', async () => {
    // Two copies of the same list, in two languages. The last time this project had a number
    // in two places with a comment claiming they matched, they had not matched for weeks.
    const rows = await tdb.db.execute<{ label: string }>(`
      select e.enumlabel as label
        from pg_enum e
        join pg_type t on t.oid = e.enumtypid
        join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'app' and t.typname = 'order_status'
       order by e.enumsortorder
    `);
    expect(rows.map((r) => r.label)).toEqual([...ORDER_STATUSES]);
  });
});
