import { randomBytes } from 'node:crypto';
import { BuyerHandleError } from '@gth/core';
import { buildKeyRing } from '@gth/security';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { seedSample } from '../seed/sample.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import {
  LiveSaleStateError,
  deleteLiveSale,
  ingestLiveSales,
  listFlaggedObservations,
  listLiveSales,
  logLiveSale,
  purgeExpiredBuyerHandles,
  reviewFlaggedObservation,
} from './live-sales.js';
import { rollUpDay } from './pricing.js';
import { asUser } from './watches.js';

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let web: TestDatabase['db'];
/** Ingestion and the retention sweep run here, on the role that cannot read a buyer handle. */
let worker: TestDatabase['db'];

const SELLER = 'live-seller';
const OTHER = 'live-other';
const keyRing = buildKeyRing(JSON.stringify({ k1: randomBytes(32).toString('base64') }), 'k1');

let variantId = '';

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

/** Publish an index point so there is a baseline for the outlier check to work against. */
async function publishIndex(medianCents: number, p25: number, p75: number): Promise<void> {
  await tdb.db.execute(`
    insert into app.price_index_daily
      (card_variant_id, condition, day, median_cents, p25_cents, p75_cents,
       low_cents, high_cents, observation_count, currency)
    values ('${variantId}', 'nm', current_date, ${String(medianCents)}, ${String(p25)},
            ${String(p75)}, ${String(p25)}, ${String(p75)}, 5, 'USD')
    on conflict (card_variant_id, condition, day, currency) do update
      set median_cents = excluded.median_cents,
          p25_cents = excluded.p25_cents,
          p75_cents = excluded.p75_cents,
          low_cents = excluded.low_cents,
          high_cents = excluded.high_cents
  `);
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);

  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  web = webPool.db;
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 2 });
  worker = workerPool.db;

  await tdb.db.execute(
    `insert into app.users (id, name, email, role) values
       ('${SELLER}', 'Seller', 'live-seller@example.com', 'seller'),
       ('${OTHER}', 'Other', 'live-other@example.com', 'seller')
     on conflict do nothing`,
  );

  const variants = await tdb.db.execute<{ id: string }>(
    `select v.id from app.card_variants v
       join app.cards c on c.id = v.card_id
      where v.finish = 'normal' order by c.number limit 1`,
  );
  variantId = String(variants[0]?.id);
});

afterAll(async () => {
  await webPool.close();
  await workerPool.close();
  await tdb.close();
});

beforeEach(async () => {
  // Observations first. An ingested entry cannot be deleted while it is linked (the policy
  // says a published number keeps its source), and deleting the observation is what unlinks
  // it — so the other order leaves rows behind that the next test ingests all over again.
  await tdb.db.execute(`delete from app.price_observations`);
  await tdb.db.execute(`delete from app.price_index_daily`);
  for (const user of [SELLER, OTHER]) {
    await asUser(tdb.db, user, (tx) => tx.execute(`delete from app.live_sales`));
  }
});

describe('logging a live sale (FR-4.1)', () => {
  it('records the sale and gives it back to its seller', async () => {
    await logLiveSale(
      web,
      SELLER,
      { cardVariantId: variantId, priceCents: 1500, buyerHandle: '@alice' },
      keyRing,
    );

    const [entry] = await listLiveSales(web, SELLER, keyRing);
    expect(entry?.priceCents).toBe(1500);
    expect(entry?.buyerHandle).toBe('alice');
    expect(entry?.published).toBe(false);
  });

  it('logs a card the catalog has never heard of, so nobody is blocked mid-stream', async () => {
    await logLiveSale(
      web,
      SELLER,
      { label: 'Promo nobody has entered yet', priceCents: 900 },
      null,
    );
    const [entry] = await listLiveSales(web, SELLER, keyRing);
    expect(entry?.label).toBe('Promo nobody has entered yet');
  });

  it('refuses an entry that identifies nothing at all', async () => {
    await expectDbError(
      logLiveSale(web, SELLER, { priceCents: 100 }, null),
      /live_sales_identified/,
    );
  });

  it('treats a blank buyer handle as no handle, not an empty one', async () => {
    await logLiveSale(
      web,
      SELLER,
      { cardVariantId: variantId, priceCents: 500, buyerHandle: '  ' },
      keyRing,
    );
    const [entry] = await listLiveSales(web, SELLER, keyRing);
    expect(entry?.buyerHandle).toBeNull();
  });

  it('rejects a handle carrying control characters', async () => {
    await expect(
      logLiveSale(
        web,
        SELLER,
        { cardVariantId: variantId, priceCents: 500, buyerHandle: 'ali\u0000ce' },
        keyRing,
      ),
    ).rejects.toBeInstanceOf(BuyerHandleError);
  });

  it('refuses to store a handle when field encryption is not configured', async () => {
    // Silently dropping it would lose data the seller needs; storing it in plaintext would
    // quietly downgrade SR-4.5. Neither is ours to choose.
    await expect(
      logLiveSale(
        web,
        SELLER,
        { cardVariantId: variantId, priceCents: 500, buyerHandle: 'alice' },
        null,
      ),
    ).rejects.toBeInstanceOf(LiveSaleStateError);
  });

  it('shows one seller nothing of another’s stream (T4)', async () => {
    await logLiveSale(web, SELLER, { cardVariantId: variantId, priceCents: 1500 }, null);
    expect(await listLiveSales(web, OTHER, keyRing)).toHaveLength(0);
  });
});

describe('the buyer handle is PII (SR-4.5)', () => {
  it('is encrypted at rest, so a database backup does not contain it', async () => {
    await logLiveSale(
      web,
      SELLER,
      { cardVariantId: variantId, priceCents: 1500, buyerHandle: 'alice' },
      keyRing,
    );

    // Read as the seller: `live_sales` is FORCE'd, so even the table owner sees no rows
    // without declaring whose they are.
    const rows = await asUser(tdb.db, SELLER, (tx) =>
      tx.execute<{ buyer_handle_encrypted: string }>(
        `select buyer_handle_encrypted from app.live_sales`,
      ),
    );
    const stored = String(rows[0]?.buyer_handle_encrypted);
    expect(stored).not.toContain('alice');
    expect(stored).toMatch(/^v1:k1:/);
  });

  it('cannot be read by the role that publishes price observations', async () => {
    await logLiveSale(
      web,
      SELLER,
      { cardVariantId: variantId, priceCents: 1500, buyerHandle: 'alice' },
      keyRing,
    );

    // This is the control, not the comment above it. The ingestion path runs as app_worker;
    // if a future version of that query asks for the handle it fails here rather than
    // publishing somebody's name.
    await expectDbError(
      worker.execute(`select buyer_handle_encrypted from app.live_sales`),
      /permission denied/i,
    );
    // And it can still read everything it actually needs.
    const usable = await worker.execute(`select id, price_cents, sold_at from app.live_sales`);
    expect(usable).toHaveLength(1);
  });

  it('is erased 90 days after the sale, by a job that cannot read it', async () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const fresh = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await logLiveSale(
      web,
      SELLER,
      { cardVariantId: variantId, priceCents: 1500, buyerHandle: 'expired', soldAt: old },
      keyRing,
    );
    await logLiveSale(
      web,
      SELLER,
      { cardVariantId: variantId, priceCents: 1500, buyerHandle: 'current', soldAt: fresh },
      keyRing,
    );

    expect(await purgeExpiredBuyerHandles(worker)).toBe(1);

    const handles = (await listLiveSales(web, SELLER, keyRing)).map((s) => s.buyerHandle);
    expect(handles).toContain('current');
    expect(handles).toContain(null);
    // Re-running erases nothing further; retention is not a loop that eats fresh data.
    expect(await purgeExpiredBuyerHandles(worker)).toBe(0);
  });

  it('never reaches the price observation it produces', async () => {
    await logLiveSale(
      web,
      SELLER,
      {
        cardVariantId: variantId,
        priceCents: 1500,
        buyerHandle: 'alice',
        streamRef: 'https://vod.invalid/1',
      },
      keyRing,
    );
    await ingestLiveSales(worker);

    const observations = await tdb.db.execute(`select * from app.price_observations`);
    expect(JSON.stringify(observations)).not.toContain('alice');
    // The seller id does not travel either: what is published is a price, not a person.
    expect(JSON.stringify(observations)).not.toContain(SELLER);
  });
});

describe('a session cannot assert a first-party price (SR-3.5, threat T7)', () => {
  it('refuses a live_sale observation written straight from the web role', async () => {
    // The reason live sales are a separate table at all. If this ever starts passing, a
    // compromised web process can claim it watched a sale that never happened.
    await expectDbError(
      asUser(web, SELLER, (tx) =>
        tx.execute(`
          insert into app.price_observations
            (card_variant_id, source, condition, price_cents, approved_at)
          values ('${variantId}', 'live_sale', 'nm', 999999, now())
        `),
      ),
      /row-level security|permission denied/i,
    );
  });
});

describe('ingestion into the index (FR-4.1)', () => {
  it('publishes an approved live_sale observation and links it back', async () => {
    await logLiveSale(
      web,
      SELLER,
      { cardVariantId: variantId, priceCents: 1500, streamRef: 'https://vod.invalid/42' },
      null,
    );

    const result = await ingestLiveSales(worker);
    expect(result).toMatchObject({ ingested: 1, flagged: 0, unpriceable: 0 });

    const [observation] = await tdb.db.execute<{
      source: string;
      approved_at: Date | null;
      evidence_ref: string | null;
    }>(`select source, approved_at, evidence_ref from app.price_observations`);
    expect(observation?.source).toBe('live_sale');
    // Our own log, so approved on arrival — we watched it happen.
    expect(observation?.approved_at).not.toBeNull();
    // The VOD link travels with it, which is what makes it checkable (FR-4.4).
    expect(observation?.evidence_ref).toBe('https://vod.invalid/42');

    const [entry] = await listLiveSales(web, SELLER, keyRing);
    expect(entry?.published).toBe(true);
  });

  it('is idempotent, so re-running cannot double-weight a sale', async () => {
    await logLiveSale(web, SELLER, { cardVariantId: variantId, priceCents: 1500 }, null);
    await ingestLiveSales(worker);
    const second = await ingestLiveSales(worker);

    expect(second.ingested).toBe(0);
    const rows = await tdb.db.execute<{ n: number }>(
      `select count(*)::int as n from app.price_observations`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('counts an entry with no catalogued card as unpriceable rather than retrying forever', async () => {
    await logLiveSale(web, SELLER, { label: 'Something uncatalogued', priceCents: 400 }, null);
    expect(await ingestLiveSales(worker)).toMatchObject({ ingested: 0, unpriceable: 1 });
  });
});

describe('outlier flagging (SR-4.4)', () => {
  it('flags a price far outside the published spread, and keeps it out of the index', async () => {
    await publishIndex(1200, 1000, 1400);
    await logLiveSale(web, SELLER, { cardVariantId: variantId, priceCents: 90_000 }, null);

    expect(await ingestLiveSales(worker)).toMatchObject({ ingested: 1, flagged: 1 });

    const queue = await listFlaggedObservations(tdb.db);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.priceCents).toBe(90_000);
    // The reviewer can see what it was measured against.
    expect(queue[0]?.medianCents).toBe(1200);

    const [entry] = await listLiveSales(web, SELLER, keyRing);
    expect(entry?.flagged).toBe(true);
  });

  it('does not flag an ordinary price', async () => {
    await publishIndex(1200, 1000, 1400);
    await logLiveSale(web, SELLER, { cardVariantId: variantId, priceCents: 1600 }, null);

    expect(await ingestLiveSales(worker)).toMatchObject({ ingested: 1, flagged: 0 });
    expect(await listFlaggedObservations(tdb.db)).toHaveLength(0);
  });

  it('flags nothing when there is no baseline to be outside of', async () => {
    // A first sale for a card cannot be an outlier. Flagging it would mean holding back the
    // only evidence we have, forever, for want of evidence.
    await logLiveSale(web, SELLER, { cardVariantId: variantId, priceCents: 90_000 }, null);
    expect(await ingestLiveSales(worker)).toMatchObject({ ingested: 1, flagged: 0 });
  });

  it('ignores a baseline older than the freshness window', async () => {
    await tdb.db.execute(`
      insert into app.price_index_daily
        (card_variant_id, condition, day, median_cents, p25_cents, p75_cents,
         low_cents, high_cents, observation_count, currency)
      values ('${variantId}', 'nm', current_date - 200, 1200, 1000, 1400, 1000, 1400, 5, 'USD')
    `);
    await logLiveSale(web, SELLER, { cardVariantId: variantId, priceCents: 90_000 }, null);
    // Prices move. Judging tonight's sale against a number from six months ago would
    // manufacture review work out of ordinary drift.
    expect(await ingestLiveSales(worker)).toMatchObject({ flagged: 0 });
  });

  it('keeps a flagged observation out of the rollup until a human clears it', async () => {
    await publishIndex(1200, 1000, 1400);
    const now = new Date();
    for (const cents of [1200, 1250, 1300]) {
      await logLiveSale(
        web,
        SELLER,
        { cardVariantId: variantId, priceCents: cents, soldAt: now },
        null,
      );
    }
    await logLiveSale(
      web,
      SELLER,
      { cardVariantId: variantId, priceCents: 90_000, soldAt: now },
      null,
    );
    await ingestLiveSales(worker);

    await rollUpDay(tdb.db, now);
    const [before] = await tdb.db.execute<{ high_cents: number; observation_count: number }>(
      `select high_cents, observation_count from app.price_index_daily
        where card_variant_id = '${variantId}' and day = current_date`,
    );
    // Three sales counted, and the odd one absent from the published range entirely.
    expect(Number(before?.observation_count)).toBe(3);
    expect(Number(before?.high_cents)).toBe(1300);

    const [flaggedRow] = await listFlaggedObservations(tdb.db);
    expect(await reviewFlaggedObservation(tdb.db, String(flaggedRow?.id), 'clear')).toBe(true);

    await rollUpDay(tdb.db, now);
    const [after] = await tdb.db.execute<{ high_cents: number; observation_count: number }>(
      `select high_cents, observation_count from app.price_index_daily
        where card_variant_id = '${variantId}' and day = current_date`,
    );
    expect(Number(after?.observation_count)).toBe(4);
    expect(Number(after?.high_cents)).toBe(90_000);
  });

  it('a rejected observation never counts, and is not deleted either', async () => {
    await publishIndex(1200, 1000, 1400);
    await logLiveSale(web, SELLER, { cardVariantId: variantId, priceCents: 90_000 }, null);
    await ingestLiveSales(worker);

    const [flaggedRow] = await listFlaggedObservations(tdb.db);
    expect(await reviewFlaggedObservation(tdb.db, String(flaggedRow?.id), 'reject')).toBe(true);

    // Kept: deleting the evidence that we received a bad number is worse than keeping it.
    const rows = await tdb.db.execute<{ n: number }>(
      `select count(*)::int as n from app.price_observations where rejected_at is not null`,
    );
    expect(Number(rows[0]?.n)).toBe(1);
    expect(await listFlaggedObservations(tdb.db)).toHaveLength(0);
  });
});

describe('corrections', () => {
  it('deletes a mistyped entry before it has reached the index', async () => {
    await logLiveSale(web, SELLER, { cardVariantId: variantId, priceCents: 150_000 }, null);
    const [entry] = await listLiveSales(web, SELLER, keyRing);
    expect(await deleteLiveSale(web, SELLER, String(entry?.id))).toBe(true);
    expect(await listLiveSales(web, SELLER, keyRing)).toHaveLength(0);
  });

  it('will not delete one that has, because the published number needs its source', async () => {
    await logLiveSale(web, SELLER, { cardVariantId: variantId, priceCents: 1500 }, null);
    await ingestLiveSales(worker);
    const [entry] = await listLiveSales(web, SELLER, keyRing);
    expect(await deleteLiveSale(web, SELLER, String(entry?.id))).toBe(false);
  });

  it('will not delete another seller’s entry', async () => {
    await logLiveSale(web, SELLER, { cardVariantId: variantId, priceCents: 1500 }, null);
    const [entry] = await listLiveSales(web, SELLER, keyRing);
    expect(await deleteLiveSale(web, OTHER, String(entry?.id))).toBe(false);
  });
});
