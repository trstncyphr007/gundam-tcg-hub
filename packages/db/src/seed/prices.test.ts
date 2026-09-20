import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import { SYNTHETIC_EVIDENCE, seedSamplePrices } from './prices.js';
import { seedSample } from './sample.js';

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await startTestDatabase();
});

afterAll(async () => {
  await tdb.close();
});

async function count(sql: string): Promise<number> {
  const rows = await tdb.db.execute<{ n: number }>(sql);
  return rows[0]?.n ?? 0;
}

describe('synthetic price seeding', () => {
  it('writes nothing when there is no sample catalog', async () => {
    // The guard that matters: pointed at a database holding the real catalog, this finds no
    // SAMPLE-01 cards and does nothing, rather than inventing prices for real ones.
    const result = await seedSamplePrices(tdb.db, { days: 5 });
    expect(result).toEqual({ variants: 0, observations: 0, published: 0, skipped: 0 });
    expect(await count(`select count(*)::int as n from app.price_observations`)).toBe(0);
  });

  it('publishes an index through the real rollup', async () => {
    await seedSample(tdb.db);
    const result = await seedSamplePrices(tdb.db, { days: 30 });

    expect(result.variants).toBeGreaterThan(0);
    expect(result.observations).toBeGreaterThan(0);
    // Not written directly: the rows exist because rollUpDay computed them, which is the
    // code that also runs in production.
    expect(result.published).toBeGreaterThan(0);
    expect(await count(`select count(*)::int as n from app.price_index_daily`)).toBe(
      result.published,
    );
  });

  it('tags every row it writes, so synthetic data is never mistaken for real', async () => {
    await seedSamplePrices(tdb.db, { days: 10 });
    const untagged = await count(
      `select count(*)::int as n from app.price_observations
        where evidence_ref is distinct from '${SYNTHETIC_EVIDENCE}'`,
    );
    expect(untagged).toBe(0);
  });

  it('is re-runnable without piling up', async () => {
    const first = await seedSamplePrices(tdb.db, { days: 10 });
    const after = await count(`select count(*)::int as n from app.price_observations`);
    const second = await seedSamplePrices(tdb.db, { days: 10 });

    expect(second.observations).toBe(first.observations);
    expect(await count(`select count(*)::int as n from app.price_observations`)).toBe(after);
  });

  it('is deterministic, so a chart looks the same after a database reset', async () => {
    await seedSamplePrices(tdb.db, { days: 10, seed: 7 });
    const a = await tdb.db.execute<{ total: string }>(
      `select coalesce(sum(price_cents), 0)::text as total from app.price_observations`,
    );
    await seedSamplePrices(tdb.db, { days: 10, seed: 7 });
    const b = await tdb.db.execute<{ total: string }>(
      `select coalesce(sum(price_cents), 0)::text as total from app.price_observations`,
    );
    expect(a[0]?.total).toBe(b[0]?.total);
  });

  it('produces prices the index itself would accept', async () => {
    await seedSamplePrices(tdb.db, { days: 30 });

    // Nothing published below the evidence floor, and the quartiles in order. Both are CHECK
    // constraints, so a violation would have thrown — asserting them here says the generator
    // produces usable data rather than data that merely squeaks past.
    expect(
      await count(
        `select count(*)::int as n from app.price_index_daily where observation_count < 3`,
      ),
    ).toBe(0);
    expect(
      await count(
        `select count(*)::int as n from app.price_index_daily
          where p25_cents > median_cents or median_cents > p75_cents`,
      ),
    ).toBe(0);

    // A parallel printing is worth more than a normal one; if the generator ever stops
    // modelling that, the charts stop being a useful thing to look at.
    const [row] = await tdb.db.execute<{ normal: number; parallel: number }>(`
      select
        max(d.median_cents) filter (where v.finish = 'normal')   as normal,
        max(d.median_cents) filter (where v.finish = 'parallel') as parallel
      from app.price_index_daily d
      join app.card_variants v on v.id = d.card_variant_id
     where d.condition = 'nm'
    `);
    expect(Number(row?.parallel)).toBeGreaterThan(Number(row?.normal));
  });
});
