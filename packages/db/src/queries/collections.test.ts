import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { seedSample } from '../seed/sample.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import {
  CollectionLimitError,
  MAX_COLLECTIONS_PER_USER,
  addItem,
  collectionItemCount,
  createCollection,
  deleteCollection,
  exportCollectionCsv,
  getCollection,
  importCollectionCsv,
  listCollections,
  listItems,
  listPublicCollections,
  removeItem,
  updateCollection,
  updateItem,
  valueCollection,
  weightedAverageCents,
} from './collections.js';
import { asUser } from './watches.js';

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
/** The web role is what a request actually runs as, so the IDOR matrix runs through it. */
let web: TestDatabase['db'];
let alphaId: string;
let betaId: string;

const OWNER = 'collection-owner';
const STRANGER = 'collection-stranger';

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

/** Publish an index price for a variant, standing in for a completed rollup. */
async function publishPrice(
  variantId: string,
  cents: number,
  opts: { dayOffset?: number; condition?: string; currency?: string } = {},
): Promise<void> {
  const day = new Date(Date.now() - (opts.dayOffset ?? 0) * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  await tdb.db.execute(
    `insert into app.price_index_daily
       (card_variant_id, condition, day, median_cents, p25_cents, p75_cents,
        low_cents, high_cents, observation_count, currency)
     values ('${variantId}', '${opts.condition ?? 'nm'}', '${day}',
             ${String(cents)}, ${String(cents)}, ${String(cents)},
             ${String(cents)}, ${String(cents)}, 4, '${opts.currency ?? 'USD'}')
     on conflict do nothing`,
  );
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  web = webPool.db;

  await tdb.db.execute(
    `insert into app.users (id, name, email, role) values
       ('${OWNER}', 'Owner', 'owner@example.com', 'user'),
       ('${STRANGER}', 'Stranger', 'stranger@example.com', 'user')
     on conflict do nothing`,
  );

  const variants = await tdb.db.execute<{ id: string; number: string; finish: string }>(
    `select v.id, c.number, v.finish::text as finish
       from app.card_variants v
       join app.cards c on c.id = v.card_id
      where v.finish = 'normal'
      order by c.number`,
  );
  alphaId = String(variants[0]?.id);
  betaId = String(variants[1]?.id);
});

afterAll(async () => {
  await webPool.close();
  await tdb.close();
});

beforeEach(async () => {
  await tdb.db.execute(`delete from app.price_index_daily`);
  // FORCE row-level security applies to the table owner too, so a bare delete here would
  // silently remove nothing and leave the next test reading the last one's rows.
  for (const user of [OWNER, STRANGER]) {
    await asUser(tdb.db, user, (tx) => tx.execute(`delete from app.collections`));
  }
});

describe('collections (FR-3.4)', () => {
  it('creates one, private by default', async () => {
    const created = await createCollection(web, OWNER, { name: 'Binder' });
    expect(created.visibility).toBe('private');
    expect(created.ownerId).toBe(OWNER);
  });

  it('lists only the caller’s own', async () => {
    await createCollection(web, OWNER, { name: 'Mine' });
    await createCollection(web, STRANGER, { name: 'Theirs' });
    const mine = await listCollections(web, OWNER);
    expect(mine.map((c) => c.name)).toEqual(['Mine']);
  });

  it('renames and re-shares', async () => {
    const created = await createCollection(web, OWNER, { name: 'Binder' });
    const updated = await updateCollection(web, OWNER, created.id, {
      name: 'Main Binder',
      visibility: 'public',
    });
    expect(updated?.name).toBe('Main Binder');
    expect(updated?.visibility).toBe('public');
  });

  it('refuses a blank name at the database, not only in the form', async () => {
    await expectDbError(
      createCollection(web, OWNER, { name: '   ' }),
      /collections_name_not_blank/,
    );
  });

  it('caps how many one account may have', async () => {
    for (let i = 0; i < MAX_COLLECTIONS_PER_USER; i += 1) {
      await createCollection(web, OWNER, { name: `Binder ${String(i)}` });
    }
    await expect(createCollection(web, OWNER, { name: 'One more' })).rejects.toBeInstanceOf(
      CollectionLimitError,
    );
  });

  it('deletes with its items', async () => {
    const created = await createCollection(web, OWNER, { name: 'Binder' });
    await addItem(web, OWNER, created.id, { cardVariantId: alphaId });
    expect(await deleteCollection(web, OWNER, created.id)).toBe(true);
    expect(await getCollection(web, OWNER, created.id)).toBeNull();
  });
});

describe('visibility (FR-3.4, SR-3.8)', () => {
  it('hides a private collection from everyone but its owner', async () => {
    const created = await createCollection(web, OWNER, { name: 'Private' });
    expect(await getCollection(web, OWNER, created.id)).not.toBeNull();
    expect(await getCollection(web, STRANGER, created.id)).toBeNull();
    expect(await getCollection(web, null, created.id)).toBeNull();
  });

  it('lets anyone holding the id open an unlisted one', async () => {
    const created = await createCollection(web, OWNER, {
      name: 'Unlisted',
      visibility: 'unlisted',
    });
    expect(await getCollection(web, STRANGER, created.id)).not.toBeNull();
    expect(await getCollection(web, null, created.id)).not.toBeNull();
  });

  it('keeps an unlisted collection out of the public listing', async () => {
    // This is the entire difference between unlisted and public, and row-level security
    // cannot enforce it -- it cannot know whether the caller already had the id.
    await createCollection(web, OWNER, { name: 'Unlisted', visibility: 'unlisted' });
    await createCollection(web, OWNER, { name: 'Public', visibility: 'public' });
    const listed = await listPublicCollections(web);
    expect(listed.map((c) => c.name)).toEqual(['Public']);
  });

  it('hides a private collection’s items too', async () => {
    const created = await createCollection(web, OWNER, { name: 'Private' });
    await addItem(web, OWNER, created.id, { cardVariantId: alphaId });
    expect(await listItems(web, OWNER, created.id)).toHaveLength(1);
    expect(await listItems(web, STRANGER, created.id)).toHaveLength(0);
  });

  it('shows a visitor the cards but never what they cost (SR-3.8)', async () => {
    // Row-level security decides which rows a shared collection hands out; it cannot mask a
    // column. Publishing a card list was never meant to publish a purchase history with it.
    const created = await createCollection(web, OWNER, { name: 'Public', visibility: 'public' });
    await addItem(web, OWNER, created.id, {
      cardVariantId: alphaId,
      quantity: 2,
      acquiredPriceCents: 1000,
      acquiredAt: new Date('2026-01-02T00:00:00Z'),
      notes: 'bought at the shop on the corner',
    });

    const asOwner = await listItems(web, OWNER, created.id);
    expect(asOwner[0]?.acquiredPriceCents).toBe(1000);
    expect(asOwner[0]?.notes).toContain('corner');

    for (const viewer of [STRANGER, null]) {
      const seen = await listItems(web, viewer, created.id);
      expect(seen).toHaveLength(1);
      // The card, the printing and the quantity are the point of sharing. The rest is not.
      expect(seen[0]?.cardName).toBe(asOwner[0]?.cardName);
      expect(seen[0]?.quantity).toBe(2);
      expect(seen[0]?.acquiredPriceCents).toBeNull();
      expect(seen[0]?.acquiredAt).toBeNull();
      expect(seen[0]?.notes).toBeNull();
    }
  });

  it('values a shared collection for a visitor without revealing its gain', async () => {
    await publishPrice(alphaId, 1500);
    const created = await createCollection(web, OWNER, { name: 'Public', visibility: 'public' });
    await addItem(web, OWNER, created.id, {
      cardVariantId: alphaId,
      quantity: 2,
      acquiredPriceCents: 1000,
    });

    const owner = await valueCollection(web, OWNER, created.id);
    expect(owner.currentValueCents).toBe(3000);
    expect(owner.gainLossCents).toBe(1000);

    const visitor = await valueCollection(web, STRANGER, created.id);
    // What it is worth is public. What it cost is not, so there is no gain to report.
    expect(visitor.currentValueCents).toBe(3000);
    expect(visitor.costBasisCents).toBe(0);
    expect(visitor.comparableValueCents).toBe(0);
    expect(visitor.gainLossCents).toBe(0);
  });

  it('exports a shared collection without the owner’s prices', async () => {
    const created = await createCollection(web, OWNER, { name: 'Public', visibility: 'public' });
    await addItem(web, OWNER, created.id, { cardVariantId: alphaId, acquiredPriceCents: 1250 });

    expect(await exportCollectionCsv(web, OWNER, created.id)).toContain('"12.50"');
    expect(await exportCollectionCsv(web, STRANGER, created.id)).not.toContain('"12.50"');
  });
});

describe('the two-user IDOR matrix (AC-3.2, SR-3.3, threat T4)', () => {
  let ownerCollection: string;
  let ownerItem: string;

  beforeEach(async () => {
    const created = await createCollection(web, OWNER, { name: 'Binder' });
    ownerCollection = created.id;
    const item = await addItem(web, OWNER, ownerCollection, { cardVariantId: alphaId });
    ownerItem = item.id;
  });

  it('a stranger cannot read it', async () => {
    expect(await getCollection(web, STRANGER, ownerCollection)).toBeNull();
    expect(await listItems(web, STRANGER, ownerCollection)).toEqual([]);
    expect(await collectionItemCount(web, STRANGER, ownerCollection)).toBe(0);
  });

  it('a stranger cannot rename it or make it public', async () => {
    expect(
      await updateCollection(web, STRANGER, ownerCollection, { visibility: 'public' }),
    ).toBeNull();
    const still = await getCollection(web, OWNER, ownerCollection);
    expect(still?.visibility).toBe('private');
  });

  it('a stranger cannot delete it', async () => {
    expect(await deleteCollection(web, STRANGER, ownerCollection)).toBe(false);
    expect(await getCollection(web, OWNER, ownerCollection)).not.toBeNull();
  });

  it('a stranger cannot add to it', async () => {
    await expectDbError(
      addItem(web, STRANGER, ownerCollection, { cardVariantId: betaId }),
      /row-level security|violates/i,
    );
    expect(await collectionItemCount(web, OWNER, ownerCollection)).toBe(1);
  });

  it('a stranger cannot edit or remove an item by id', async () => {
    expect(await updateItem(web, STRANGER, ownerItem, { quantity: 99 })).toBeNull();
    expect(await removeItem(web, STRANGER, ownerItem)).toBe(false);
    const items = await listItems(web, OWNER, ownerCollection);
    expect(items[0]?.quantity).toBe(1);
  });

  it('being able to SEE a public collection does not mean being able to WRITE it', async () => {
    await updateCollection(web, OWNER, ownerCollection, { visibility: 'public' });
    expect(await getCollection(web, STRANGER, ownerCollection)).not.toBeNull();
    await expectDbError(
      addItem(web, STRANGER, ownerCollection, { cardVariantId: betaId }),
      /row-level security|violates/i,
    );
    expect(await updateItem(web, STRANGER, ownerItem, { quantity: 99 })).toBeNull();
  });

  it('an owner cannot hand a collection to someone else by writing a new owner_id', async () => {
    // Not a feature we offer; it would be a way of losing a row, not sharing one.
    // The assertion wraps the whole transaction rather than the statement: once Postgres
    // rejects the write the transaction is aborted, so catching it inside would only move
    // the failure to the commit.
    await expectDbError(
      asUser(tdb.db, OWNER, (tx) =>
        tx.execute(
          `update app.collections set owner_id = '${STRANGER}' where id = '${ownerCollection}'`,
        ),
      ),
      /row-level security|violates/i,
    );
  });
});

describe('items and cost basis (FR-3.4)', () => {
  let collectionId: string;

  beforeEach(async () => {
    collectionId = (await createCollection(web, OWNER, { name: 'Binder' })).id;
  });

  it('adds a second copy as a quantity, not a second line', async () => {
    await addItem(web, OWNER, collectionId, { cardVariantId: alphaId, quantity: 1 });
    await addItem(web, OWNER, collectionId, { cardVariantId: alphaId, quantity: 2 });
    const items = await listItems(web, OWNER, collectionId);
    expect(items).toHaveLength(1);
    expect(items[0]?.quantity).toBe(3);
  });

  it('keeps the same card in two conditions as two lines', async () => {
    await addItem(web, OWNER, collectionId, { cardVariantId: alphaId, condition: 'nm' });
    await addItem(web, OWNER, collectionId, { cardVariantId: alphaId, condition: 'lp' });
    expect(await listItems(web, OWNER, collectionId)).toHaveLength(2);
  });

  it('averages the cost basis by quantity when a line grows', async () => {
    await addItem(web, OWNER, collectionId, {
      cardVariantId: alphaId,
      quantity: 1,
      acquiredPriceCents: 1000,
    });
    await addItem(web, OWNER, collectionId, {
      cardVariantId: alphaId,
      quantity: 3,
      acquiredPriceCents: 2000,
    });
    const items = await listItems(web, OWNER, collectionId);
    // (1x1000 + 3x2000) / 4
    expect(items[0]?.acquiredPriceCents).toBe(1750);
  });

  it('forgets the cost basis when half the lot has no known cost', async () => {
    // An average that treats "unknown" as zero is not an average, it is an understatement
    // that compounds every time the line grows.
    await addItem(web, OWNER, collectionId, {
      cardVariantId: alphaId,
      quantity: 1,
      acquiredPriceCents: 1000,
    });
    await addItem(web, OWNER, collectionId, { cardVariantId: alphaId, quantity: 1 });
    const items = await listItems(web, OWNER, collectionId);
    expect(items[0]?.acquiredPriceCents).toBeNull();
  });

  it('refuses to add a purchase in another currency to an existing line', async () => {
    await addItem(web, OWNER, collectionId, { cardVariantId: alphaId, acquiredPriceCents: 1000 });
    await expect(
      addItem(web, OWNER, collectionId, {
        cardVariantId: alphaId,
        acquiredPriceCents: 1500,
        currency: 'CAD',
      }),
    ).rejects.toThrow(/CAD/);
  });

  it('refuses a quantity of zero at the database', async () => {
    await expectDbError(
      addItem(web, OWNER, collectionId, { cardVariantId: alphaId, quantity: 0 }),
      /collection_items_quantity_positive/,
    );
  });
});

describe('the weighted average, on its own', () => {
  it('is null when either side is unknown', () => {
    expect(
      weightedAverageCents({ quantity: 1, unitCents: null }, { quantity: 1, unitCents: 10 }),
    ).toBeNull();
    expect(
      weightedAverageCents({ quantity: 1, unitCents: 10 }, { quantity: 1, unitCents: null }),
    ).toBeNull();
  });

  it('weights by quantity, not by line', () => {
    expect(
      weightedAverageCents({ quantity: 1, unitCents: 1000 }, { quantity: 3, unitCents: 2000 }),
    ).toBe(1750);
  });

  it('stays an integer number of cents', () => {
    const result = weightedAverageCents(
      { quantity: 1, unitCents: 100 },
      { quantity: 2, unitCents: 101 },
    );
    expect(Number.isInteger(result)).toBe(true);
  });
});

describe('valuation (FR-3.4)', () => {
  let collectionId: string;

  beforeEach(async () => {
    collectionId = (await createCollection(web, OWNER, { name: 'Binder' })).id;
  });

  it('values what it can and says what it could not', async () => {
    await publishPrice(alphaId, 1500);
    await addItem(web, OWNER, collectionId, { cardVariantId: alphaId, quantity: 2 });
    await addItem(web, OWNER, collectionId, { cardVariantId: betaId, quantity: 3 });

    const value = await valueCollection(web, OWNER, collectionId);
    expect(value.currentValueCents).toBe(3000);
    expect(value.valuedCards).toBe(2);
    // A card with no published price is NOT worth zero; it is reported separately.
    expect(value.unpricedLines).toBe(1);
    expect(value.unpricedCards).toBe(3);
    expect(value.cards).toBe(5);
  });

  it('ignores a price older than the window', async () => {
    await publishPrice(alphaId, 1500, { dayOffset: 400 });
    await addItem(web, OWNER, collectionId, { cardVariantId: alphaId });
    const value = await valueCollection(web, OWNER, collectionId);
    expect(value.currentValueCents).toBe(0);
    expect(value.unpricedLines).toBe(1);
  });

  it('reports how fresh the numbers are', async () => {
    await publishPrice(alphaId, 1500, { dayOffset: 5 });
    await publishPrice(betaId, 800);
    await addItem(web, OWNER, collectionId, { cardVariantId: alphaId });
    await addItem(web, OWNER, collectionId, { cardVariantId: betaId });
    const value = await valueCollection(web, OWNER, collectionId);
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(value.oldestPriceDay).toBe(fiveDaysAgo);
  });

  it('computes gain and loss over the cards that have both a price and a cost', async () => {
    await publishPrice(alphaId, 1500);
    await publishPrice(betaId, 900);
    // Priced and with a cost: counts on both sides.
    await addItem(web, OWNER, collectionId, {
      cardVariantId: alphaId,
      quantity: 2,
      acquiredPriceCents: 1000,
    });
    // Priced but no known cost: counts in the value, not in the gain.
    await addItem(web, OWNER, collectionId, { cardVariantId: betaId, quantity: 1 });

    const value = await valueCollection(web, OWNER, collectionId);
    expect(value.currentValueCents).toBe(3900);
    expect(value.comparableValueCents).toBe(3000);
    expect(value.costBasisCents).toBe(2000);
    expect(value.gainLossCents).toBe(1000);
  });

  it('does not invent an exchange rate', async () => {
    await publishPrice(alphaId, 1500, { currency: 'CAD' });
    await addItem(web, OWNER, collectionId, { cardVariantId: alphaId, currency: 'CAD' });
    const value = await valueCollection(web, OWNER, collectionId, { currency: 'USD' });
    expect(value.currentValueCents).toBe(0);
    expect(value.otherCurrencyLines).toBe(1);
  });

  it('is empty, not broken, for an empty collection', async () => {
    const value = await valueCollection(web, OWNER, collectionId);
    expect(value).toMatchObject({ lines: 0, cards: 0, currentValueCents: 0, gainLossCents: 0 });
  });
});

describe('CSV export (FR-3.5, SR-2.5, AC-2.4)', () => {
  let collectionId: string;

  beforeEach(async () => {
    collectionId = (await createCollection(web, OWNER, { name: 'Binder' })).id;
  });

  it('writes the documented header and a readable amount', async () => {
    await addItem(web, OWNER, collectionId, {
      cardVariantId: alphaId,
      quantity: 2,
      acquiredPriceCents: 1250,
    });
    const csv = await exportCollectionCsv(web, OWNER, collectionId);
    const [header, row] = csv.split('\r\n');
    expect(header).toContain('"set"');
    // Cents in the database, dollars in the file: nobody types 1250 into a spreadsheet.
    expect(row).toContain('"12.50"');
    expect(row).toContain('"SAMPLE-01"');
  });

  it('neutralises a formula the owner typed into a note', async () => {
    await addItem(web, OWNER, collectionId, {
      cardVariantId: alphaId,
      notes: `=cmd|'/c calc'!A1`,
    });
    const csv = await exportCollectionCsv(web, OWNER, collectionId);
    expect(csv).toContain(`"'=cmd|'/c calc'!A1"`);
  });

  it('refuses to export a collection the caller may not see', async () => {
    await addItem(web, OWNER, collectionId, { cardVariantId: alphaId });
    const csv = await exportCollectionCsv(web, STRANGER, collectionId);
    expect(csv.split('\r\n')).toHaveLength(1); // header only
  });
});

describe('CSV import (FR-3.5, SR-3.4, AC-3.5)', () => {
  let collectionId: string;

  beforeEach(async () => {
    collectionId = (await createCollection(web, OWNER, { name: 'Binder' })).id;
  });

  const file = (...rows: string[]): string => ['set,number,quantity', ...rows].join('\n');

  it('dry-runs by default and writes nothing', async () => {
    const report = await importCollectionCsv(web, OWNER, collectionId, file('SAMPLE-01,001,2'));
    expect(report.dryRun).toBe(true);
    expect(report.valid).toBe(1);
    expect(report.created).toBe(0);
    expect(await collectionItemCount(web, OWNER, collectionId)).toBe(0);
  });

  it('applies when asked, with the same verdict the dry run gave', async () => {
    const rows = file('SAMPLE-01,001,2', 'SAMPLE-01,002,1');
    const preview = await importCollectionCsv(web, OWNER, collectionId, rows);
    const applied = await importCollectionCsv(web, OWNER, collectionId, rows, { dryRun: false });
    expect(applied.valid).toBe(preview.valid);
    expect(applied.created).toBe(2);
    expect(applied.cardsAdded).toBe(3);
    expect(await collectionItemCount(web, OWNER, collectionId)).toBe(2);
  });

  it('rejects a 5,001-row file (AC-3.5)', async () => {
    const rows = Array.from({ length: 5001 }, () => 'SAMPLE-01,001,1');
    const report = await importCollectionCsv(web, OWNER, collectionId, file(...rows));
    expect(report.errors[0]?.message).toMatch(/more than 5000 rows/);
    expect(report.valid).toBe(0);
  });

  it('accepts exactly 5,000', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => `SAMPLE-01,00${String((i % 3) + 1)},1`);
    const report = await importCollectionCsv(web, OWNER, collectionId, file(...rows));
    expect(report.rows).toBe(5000);
    // Only the first of each repeated line survives; the rest are reported as duplicates.
    expect(report.valid).toBe(3);
  });

  it('stores a formula payload as text and hands it back neutralised (AC-3.5)', async () => {
    const payload = '=HYPERLINK("http://evil.test")';
    const csv = [
      'set,number,quantity,notes',
      `SAMPLE-01,001,1,"${payload.replaceAll('"', '""')}"`,
    ].join('\n');
    await importCollectionCsv(web, OWNER, collectionId, csv, { dryRun: false });

    const items = await listItems(web, OWNER, collectionId);
    expect(items[0]?.notes).toBe(payload);

    const exported = await exportCollectionCsv(web, OWNER, collectionId);
    expect(exported).toContain(`"'=HYPERLINK(""http://evil.test"")"`);
  });

  it('names the row a problem is on, counting the way the file is numbered', async () => {
    const report = await importCollectionCsv(
      web,
      OWNER,
      collectionId,
      file('SAMPLE-01,001,1', 'SAMPLE-01,002,zero', 'SAMPLE-01,003,1'),
    );
    expect(report.valid).toBe(2);
    // Header is row 1, so the bad row is row 3.
    expect(report.errors).toEqual([
      { row: 3, message: 'quantity: quantity must be a whole number' },
    ]);
  });

  it('keeps the row numbers honest when an earlier row is the wrong shape', async () => {
    const report = await importCollectionCsv(
      web,
      OWNER,
      collectionId,
      file('SAMPLE-01,001', 'SAMPLE-01,002,nope'),
    );
    expect(report.errors.map((e) => e.row)).toEqual([2, 3]);
  });

  it('reports a card it cannot find instead of skipping it quietly', async () => {
    const report = await importCollectionCsv(web, OWNER, collectionId, file('SAMPLE-01,999,1'));
    expect(report.valid).toBe(0);
    expect(report.errors[0]?.message).toMatch(/no card 999 in set SAMPLE-01/);
  });

  it('refuses a file that says two different things about one line', async () => {
    const report = await importCollectionCsv(
      web,
      OWNER,
      collectionId,
      file('SAMPLE-01,001,1', 'SAMPLE-01,001,5'),
    );
    expect(report.valid).toBe(1);
    expect(report.errors[0]).toEqual({ row: 3, message: 'duplicates row 2' });
  });

  it('rejects an unknown header once, not once per row', async () => {
    const csv = ['set,number,qty', 'SAMPLE-01,001,1', 'SAMPLE-01,002,1'].join('\n');
    const report = await importCollectionCsv(web, OWNER, collectionId, csv);
    expect(report.errors).toHaveLength(2); // unknown column + missing required column
    expect(report.errors.every((e) => e.row === 0)).toBe(true);
  });

  it('adds to an existing line by default and replaces it when told to', async () => {
    await addItem(web, OWNER, collectionId, { cardVariantId: alphaId, quantity: 4 });

    await importCollectionCsv(web, OWNER, collectionId, file('SAMPLE-01,001,1'), { dryRun: false });
    expect((await listItems(web, OWNER, collectionId))[0]?.quantity).toBe(5);

    await importCollectionCsv(web, OWNER, collectionId, file('SAMPLE-01,001,1'), {
      dryRun: false,
      mode: 'replace',
    });
    expect((await listItems(web, OWNER, collectionId))[0]?.quantity).toBe(1);
  });

  it('round-trips an export back into an empty collection', async () => {
    await addItem(web, OWNER, collectionId, {
      cardVariantId: alphaId,
      quantity: 2,
      acquiredPriceCents: 1250,
      condition: 'lp',
    });
    const exported = await exportCollectionCsv(web, OWNER, collectionId);

    const copyId = (await createCollection(web, OWNER, { name: 'Copy' })).id;
    const report = await importCollectionCsv(web, OWNER, copyId, exported, { dryRun: false });
    expect(report.errors).toEqual([]);

    const items = await listItems(web, OWNER, copyId);
    expect(items[0]).toMatchObject({ quantity: 2, acquiredPriceCents: 1250, condition: 'lp' });
  });

  it('will not import into someone else’s collection', async () => {
    await expectDbError(
      importCollectionCsv(web, STRANGER, collectionId, file('SAMPLE-01,001,1'), { dryRun: false }),
      /row-level security|violates/i,
    );
    expect(await collectionItemCount(web, OWNER, collectionId)).toBe(0);
  });
});
