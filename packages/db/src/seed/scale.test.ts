import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import { seedScale } from './scale.js';

/**
 * The scale seed (ADR-040). Small numbers here — the point is that it produces a catalog of
 * the right *shape*, not that it is fast; the speed measurement uses ten thousand.
 */
let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await startTestDatabase();
}, 180_000);

afterAll(async () => {
  await tdb.close();
});

describe('seeding a catalog worth measuring', () => {
  it('fills cards, variants and published prices', async () => {
    const result = await seedScale(tdb.db, { cards: 200, priceDays: 3 });
    expect(result.cards).toBe(200);
    expect(result.variants).toBe(200);
    // Four variants in five get a published price, times three days.
    expect(result.priceRows).toBe(160 * 3);
  });

  it('produces names a search has to discriminate between', async () => {
    const rows = await tdb.db.execute<{ distinct_names: number; shared_prefix: number }>(`
      select count(distinct name)::int as distinct_names,
             count(*) filter (where name like 'Gundam%')::int as shared_prefix
        from app.cards`);
    // Distinct, or a search would match one row and prove nothing...
    expect(rows[0]?.distinct_names).toBe(200);
    // ...but sharing words, or it would match everything and prove just as little.
    expect(rows[0]?.shared_prefix).toBeGreaterThan(5);
  });

  it('is safe to run twice', async () => {
    // Re-running must not duplicate a card or fail on a conflict: the measurement loop is
    // "seed, measure, seed more, measure again".
    const again = await seedScale(tdb.db, { cards: 200, priceDays: 3 });
    expect(again.cards).toBe(0);
    const rows = await tdb.db.execute<{ n: number }>(`select count(*)::int as n from app.cards`);
    expect(rows[0]?.n).toBe(200);
  });

  it('marks everything it wrote, so it can be told from a real catalog', async () => {
    const rows = await tdb.db.execute<{ n: number }>(
      `select count(*)::int as n from app.sets where code not like 'SCALE-%'`,
    );
    expect(rows[0]?.n).toBe(0);
  });
});
