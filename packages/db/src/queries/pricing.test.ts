import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { seedSample } from '../seed/sample.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import {
  ReportLimitError,
  ingestBreakPulls,
  latestPrice,
  listPendingReports,
  moderateObservation,
  priceHistory,
  reportPrice,
  rollUpDay,
} from './pricing.js';
import { asUser } from './watches.js';

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let variantId: string;
let otherVariantId: string;

const REPORTER = 'price-reporter';
const CREATOR = 'price-creator';
const TODAY = new Date();

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

/** Insert an approved observation directly, standing in for a trusted source. */
async function seedObservation(
  cents: number,
  opts: { source?: string; condition?: string; at?: Date; variant?: string } = {},
): Promise<void> {
  const at = opts.at ?? TODAY;
  await tdb.db.execute(
    `insert into app.price_observations
       (card_variant_id, source, sale_type, condition, price_cents, observed_at, approved_at)
     values ('${opts.variant ?? variantId}', '${opts.source ?? 'live_sale'}', 'sold',
             '${opts.condition ?? 'nm'}', ${String(cents)}, '${at.toISOString()}', now())`,
  );
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 2 });

  const variants = await tdb.db.execute<{ id: string }>(
    `select id from app.card_variants order by id limit 2`,
  );
  variantId = String(variants[0]?.id);
  otherVariantId = String(variants[1]?.id);

  await tdb.db.execute(
    `insert into app.users (id, name, email, role) values
       ('${REPORTER}', 'Reporter', 'reporter@example.com', 'user'),
       ('${CREATOR}', 'Creator', 'pcreator@example.com', 'creator')
     on conflict do nothing`,
  );
});

afterAll(async () => {
  await webPool.close();
  await workerPool.close();
  await tdb.close();
});

beforeEach(async () => {
  await tdb.db.execute(`delete from app.price_index_daily`);
  await tdb.db.execute(`delete from app.price_observations`);
  // Breaks cascade to their pulls. Without this, a pull left by an earlier test is still
  // waiting to be ingested and quietly inflates the next test's sample.
  await asUser(tdb.db, CREATOR, (tx) => tx.execute(`delete from app.breaks`));
});

describe('the rollup (FR-3.2, AC-3.1)', () => {
  it('publishes nothing below the minimum observation count', async () => {
    await seedObservation(1000);
    await seedObservation(2000);

    const result = await rollUpDay(tdb.db, TODAY);
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await latestPrice(tdb.db, variantId)).toBeNull();
  });

  it('counts real observations against the floor, not the weighted expansion', async () => {
    // Two break_pull observations weigh 3 each, so the weighted list has 6 entries. That
    // must not be mistaken for six sales: two pieces of evidence is still two.
    await seedObservation(1000, { source: 'break_pull' });
    await seedObservation(2000, { source: 'break_pull' });

    const result = await rollUpDay(tdb.db, TODAY);
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('publishes once there is enough data', async () => {
    for (const cents of [1000, 2000, 3000]) await seedObservation(cents);

    expect((await rollUpDay(tdb.db, TODAY)).written).toBe(1);
    const row = await latestPrice(tdb.db, variantId);
    expect(row?.medianCents).toBe(2000);
    expect(row?.observationCount).toBe(3);
  });

  it('reports the real observation count, not the weighted one', async () => {
    // break_pull carries weight 3, so the weighted sample is 9 while the evidence is 3.
    for (const cents of [1000, 2000, 3000]) await seedObservation(cents, { source: 'live_sale' });
    await rollUpDay(tdb.db, TODAY);
    // "Backed by 3 sales" must not read as 9.
    expect((await latestPrice(tdb.db, variantId))?.observationCount).toBe(3);
  });

  it('keeps conditions apart', async () => {
    for (const cents of [1000, 1000, 1000]) await seedObservation(cents, { condition: 'nm' });
    for (const cents of [400, 400, 400]) await seedObservation(cents, { condition: 'mp' });

    expect((await rollUpDay(tdb.db, TODAY)).written).toBe(2);
    expect((await latestPrice(tdb.db, variantId, 'nm'))?.medianCents).toBe(1000);
    expect((await latestPrice(tdb.db, variantId, 'mp'))?.medianCents).toBe(400);
  });

  it('never mixes currencies into one median', async () => {
    for (const cents of [1000, 1000, 1000]) await seedObservation(cents);
    await tdb.db.execute(
      `insert into app.price_observations
         (card_variant_id, source, condition, price_cents, currency, observed_at, approved_at)
       select '${variantId}', 'live_sale', 'nm', 9000, 'CAD', now(), now()
       from generate_series(1, 3)`,
    );

    // Two rows, not one average of two currencies.
    expect((await rollUpDay(tdb.db, TODAY)).written).toBe(2);
    const rows = await tdb.db.execute<{ currency: string; median_cents: number }>(
      `select currency, median_cents from app.price_index_daily order by currency`,
    );
    expect(rows.map((r) => r.currency)).toEqual(['CAD', 'USD']);
  });

  it('is idempotent: recomputing replaces the day rather than duplicating it', async () => {
    for (const cents of [1000, 2000, 3000]) await seedObservation(cents);
    await rollUpDay(tdb.db, TODAY);
    await rollUpDay(tdb.db, TODAY);

    const rows = await tdb.db.execute<{ n: number }>(
      `select count(*)::int as n from app.price_index_daily`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('picks up an observation approved after the first run', async () => {
    for (const cents of [1000, 2000, 3000]) await seedObservation(cents);
    await rollUpDay(tdb.db, TODAY);
    expect((await latestPrice(tdb.db, variantId))?.observationCount).toBe(3);

    await seedObservation(9000);
    await rollUpDay(tdb.db, TODAY);
    expect((await latestPrice(tdb.db, variantId))?.observationCount).toBe(4);
  });

  it('ignores unapproved and flagged observations', async () => {
    for (const cents of [1000, 2000, 3000]) await seedObservation(cents);
    // An unapproved report and a flagged one, both absurd.
    await tdb.db.execute(
      `insert into app.price_observations
         (card_variant_id, source, condition, price_cents, reporter_id, observed_at)
       values ('${variantId}', 'user_report', 'nm', 900000, '${REPORTER}', now())`,
    );
    await tdb.db.execute(
      `insert into app.price_observations
         (card_variant_id, source, condition, price_cents, observed_at, approved_at, flagged_at)
       values ('${variantId}', 'live_sale', 'nm', 900000, now(), now(), now())`,
    );

    await rollUpDay(tdb.db, TODAY);
    const row = await latestPrice(tdb.db, variantId);
    expect(row?.observationCount).toBe(3);
    expect(row?.medianCents).toBe(2000);
  });

  it('builds a history a chart can draw', async () => {
    for (let daysAgo = 0; daysAgo < 3; daysAgo += 1) {
      const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
      for (const cents of [1000 + daysAgo * 100, 2000, 3000]) {
        await seedObservation(cents, { at });
      }
      await rollUpDay(tdb.db, at);
    }
    const history = await priceHistory(tdb.db, variantId, { condition: 'nm', days: 30 });
    expect(history).toHaveLength(3);
    expect(history.map((h) => h.day).sort()).toEqual(history.map((h) => h.day));
  });
});

describe('break pulls become observations (FR-3.1)', () => {
  /** `breaks` has FORCE row-level security, so even the owner declares who it is acting as. */
  async function liveBreakWithPull(cents: number): Promise<void> {
    await asUser(tdb.db, CREATOR, async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        `insert into app.breaks (creator_id, title, status, started_at, overlay_token_hash)
         values ('${CREATOR}', 'Pricing break', 'live', now(), md5(random()::text))
         returning id`,
      );
      await tx.execute(
        `insert into app.break_pulls (break_id, card_variant_id, value_cents_at_pull, seq)
         values ('${String(rows[0]?.id)}', '${variantId}', ${String(cents)}, 1)`,
      );
    });
  }

  it('ingests a pull as an approved, near-mint observation', async () => {
    await liveBreakWithPull(12_500);
    expect(await ingestBreakPulls(tdb.db)).toBe(1);

    const rows = await tdb.db.execute<{
      source: string;
      condition: string;
      price_cents: number;
      approved_at: string | null;
    }>(`select source, condition, price_cents, approved_at from app.price_observations`);
    expect(rows[0]?.source).toBe('break_pull');
    expect(rows[0]?.condition).toBe('nm'); // straight out of a pack
    expect(rows[0]?.price_cents).toBe(12_500);
    expect(rows[0]?.approved_at).not.toBeNull(); // we watched it happen
  });

  it('is idempotent, so re-running cannot inflate the sample', async () => {
    await liveBreakWithPull(500);
    expect(await ingestBreakPulls(tdb.db)).toBe(1);
    expect(await ingestBreakPulls(tdb.db)).toBe(0);

    const rows = await tdb.db.execute<{ n: number }>(
      `select count(*)::int as n from app.price_observations`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('ignores a free-text pull, because there is no card to price', async () => {
    await asUser(tdb.db, CREATOR, async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        `insert into app.breaks (creator_id, title, status, started_at, overlay_token_hash)
         values ('${CREATOR}', 'Text break', 'live', now(), md5(random()::text)) returning id`,
      );
      await tx.execute(
        `insert into app.break_pulls (break_id, label, value_cents_at_pull, seq)
         values ('${String(rows[0]?.id)}', 'Some card', 999, 1)`,
      );
    });

    expect(await ingestBreakPulls(tdb.db)).toBe(0);
  });

  it('a draft break cannot hold pulls in the first place', async () => {
    // The ingestion filters on break status, but it never has to: the Phase 2 policy
    // refuses a pull into a break that is not live, so the case cannot arise.
    // Separate transactions: the rejected insert aborts whichever one it runs in, so
    // creating the break has to be finished and committed first.
    const draftId = await asUser(tdb.db, CREATOR, async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        `insert into app.breaks (creator_id, title, overlay_token_hash)
         values ('${CREATOR}', 'Draft', md5(random()::text)) returning id`,
      );
      return String(rows[0]?.id);
    });

    await expectDbError(
      asUser(tdb.db, CREATOR, (tx) =>
        tx.execute(
          `insert into app.break_pulls (break_id, card_variant_id, value_cents_at_pull, seq)
           values ('${draftId}', '${variantId}', 4242, 1)`,
        ),
      ),
      /row-level security/i,
    );
  });
});

describe('user reports are moderated before they count (SR-3.5, T7)', () => {
  it('arrives unapproved and is ignored by the rollup', async () => {
    for (const cents of [1000, 1000, 1000]) await seedObservation(cents);
    await reportPrice(webPool.db, REPORTER, {
      cardVariantId: variantId,
      condition: 'nm',
      priceCents: 500_000,
    });

    await rollUpDay(tdb.db, TODAY);
    expect((await latestPrice(tdb.db, variantId))?.medianCents).toBe(1000);
    expect(await listPendingReports(tdb.db)).toHaveLength(1);
  });

  it('counts once a human approves it', async () => {
    for (const cents of [1000, 1000, 1000]) await seedObservation(cents);
    const report = await reportPrice(webPool.db, REPORTER, {
      cardVariantId: variantId,
      condition: 'nm',
      priceCents: 1200,
    });

    expect(await moderateObservation(tdb.db, report.id, 'approve')).toBe(true);
    await rollUpDay(tdb.db, TODAY);
    expect((await latestPrice(tdb.db, variantId))?.observationCount).toBe(4);
  });

  it('a rejected report never counts', async () => {
    for (const cents of [1000, 1000, 1000]) await seedObservation(cents);
    const report = await reportPrice(webPool.db, REPORTER, {
      cardVariantId: variantId,
      condition: 'nm',
      priceCents: 500_000,
    });
    await moderateObservation(tdb.db, report.id, 'reject');

    await rollUpDay(tdb.db, TODAY);
    expect((await latestPrice(tdb.db, variantId))?.observationCount).toBe(3);
    expect(await listPendingReports(tdb.db)).toHaveLength(0);
  });

  it('cannot be moderated twice', async () => {
    const report = await reportPrice(webPool.db, REPORTER, {
      cardVariantId: variantId,
      condition: 'nm',
      priceCents: 100,
    });
    expect(await moderateObservation(tdb.db, report.id, 'approve')).toBe(true);
    expect(await moderateObservation(tdb.db, report.id, 'reject')).toBe(false);
  });

  it('caps how many reports one account can leave pending', async () => {
    for (let i = 0; i < 20; i += 1) {
      await reportPrice(webPool.db, REPORTER, {
        cardVariantId: variantId,
        condition: 'nm',
        priceCents: 100 + i,
      });
    }
    await expect(
      reportPrice(webPool.db, REPORTER, {
        cardVariantId: variantId,
        condition: 'nm',
        priceCents: 999,
      }),
    ).rejects.toThrow(ReportLimitError);
  });
});

describe('what a session may write (RLS)', () => {
  it('cannot file a report as somebody else', async () => {
    await expectDbError(
      asUser(webPool.db, REPORTER, (tx) =>
        tx.execute(
          `insert into app.price_observations
             (card_variant_id, source, condition, price_cents, reporter_id)
           values ('${variantId}', 'user_report', 'nm', 100, '${CREATOR}')`,
        ),
      ),
      /row-level security/i,
    );
  });

  it('cannot claim a higher-trust source than a user report', async () => {
    // This is the important one: the sources we weight most are not reachable from a session.
    for (const source of ['break_pull', 'live_sale', 'ebay_api']) {
      await expectDbError(
        asUser(webPool.db, REPORTER, (tx) =>
          tx.execute(
            `insert into app.price_observations
               (card_variant_id, source, condition, price_cents, reporter_id)
             values ('${variantId}', '${source}', 'nm', 100, '${REPORTER}')`,
          ),
        ),
        /row-level security/i,
      );
    }
  });

  it('cannot self-approve a report', async () => {
    await expectDbError(
      asUser(webPool.db, REPORTER, (tx) =>
        tx.execute(
          `insert into app.price_observations
             (card_variant_id, source, condition, price_cents, reporter_id, approved_at)
           values ('${variantId}', 'user_report', 'nm', 100, '${REPORTER}', now())`,
        ),
      ),
      /row-level security/i,
    );
  });

  it('cannot edit or delete an observation, only add a new one', async () => {
    await seedObservation(1000);
    await expectDbError(
      webPool.db.execute(`update app.price_observations set price_cents = 1`),
      /permission denied/i,
    );
    await expectDbError(
      webPool.db.execute(`delete from app.price_observations`),
      /permission denied/i,
    );
  });

  it('the web tier cannot write the published index', async () => {
    await expectDbError(
      webPool.db.execute(
        `insert into app.price_index_daily
           (card_variant_id, condition, day, median_cents, p25_cents, p75_cents,
            low_cents, high_cents, observation_count)
         values ('${variantId}', 'nm', current_date, 1, 1, 1, 1, 1, 3)`,
      ),
      /permission denied/i,
    );
  });

  it('the worker records first-party sources but cannot file a user report', async () => {
    // Ingesting break pulls is the worker's job, so this must work...
    await workerPool.db.execute(
      `insert into app.price_observations (card_variant_id, source, condition, price_cents)
       values ('${variantId}', 'live_sale', 'nm', 100)`,
    );
    // ...but a report has to come from a person, with a person attached.
    await expectDbError(
      workerPool.db.execute(
        `insert into app.price_observations
           (card_variant_id, source, condition, price_cents, reporter_id)
         values ('${variantId}', 'user_report', 'nm', 100, '${REPORTER}')`,
      ),
      /row-level security/i,
    );
  });

  it('the worker cannot rewrite history, only append to it', async () => {
    await expectDbError(
      workerPool.db.execute(`update app.price_observations set price_cents = 1`),
      /permission denied/i,
    );
    await expectDbError(
      workerPool.db.execute(`delete from app.price_observations`),
      /permission denied/i,
    );
  });
});

describe('database constraints', () => {
  it('refuses a negative price', async () => {
    await expectDbError(
      tdb.db.execute(
        `insert into app.price_observations (card_variant_id, source, condition, price_cents)
         values ('${otherVariantId}', 'live_sale', 'nm', -1)`,
      ),
      /price_observations_price_non_negative/,
    );
  });

  it('refuses a user report with no reporter', async () => {
    await expectDbError(
      tdb.db.execute(
        `insert into app.price_observations (card_variant_id, source, condition, price_cents)
         values ('${otherVariantId}', 'user_report', 'nm', 100)`,
      ),
      /price_observations_reporter_required/,
    );
  });

  it('refuses a row that is both approved and rejected', async () => {
    await expectDbError(
      tdb.db.execute(
        `insert into app.price_observations
           (card_variant_id, source, condition, price_cents, approved_at, rejected_at)
         values ('${otherVariantId}', 'live_sale', 'nm', 100, now(), now())`,
      ),
      /price_observations_not_both_decisions/,
    );
  });

  it('refuses a published row below the minimum observation count', async () => {
    await expectDbError(
      tdb.db.execute(
        `insert into app.price_index_daily
           (card_variant_id, condition, day, median_cents, p25_cents, p75_cents,
            low_cents, high_cents, observation_count)
         values ('${otherVariantId}', 'nm', current_date, 100, 100, 100, 100, 100, 2)`,
      ),
      /price_index_daily_min_observations/,
    );
  });

  it('refuses a published row whose quartiles are out of order', async () => {
    await expectDbError(
      tdb.db.execute(
        `insert into app.price_index_daily
           (card_variant_id, condition, day, median_cents, p25_cents, p75_cents,
            low_cents, high_cents, observation_count)
         values ('${otherVariantId}', 'nm', current_date, 100, 900, 50, 1, 1000, 5)`,
      ),
      /price_index_daily_ordered/,
    );
  });
});
