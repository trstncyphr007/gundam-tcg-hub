import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { seedSample } from '../seed/sample.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import {
  MAX_PAGE_SIZE,
  getCardById,
  listGames,
  listSealedProducts,
  listSets,
  pingDatabase,
  searchCards,
} from './catalog.js';

let tdb: TestDatabase;

/** postgres.js wraps failures, so the constraint/permission text lives on `cause`. */
async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected the query to fail').toBeDefined();
  const messages: string[] = [];
  for (let e: unknown = caught; e instanceof Error; e = e.cause) {
    messages.push(e.message);
  }
  expect(messages.join(' | ')).toMatch(pattern);
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
});

afterAll(async () => {
  await tdb.close();
});

describe('catalog queries', () => {
  it('pings', async () => {
    await expect(pingDatabase(tdb.db)).resolves.toBe(true);
  });

  it('lists games', async () => {
    const games = await listGames(tdb.db);
    expect(games.map((g) => g.slug)).toEqual(['gundam']);
  });

  it('lists sets for a game and ignores unknown games', async () => {
    const mine = await listSets(tdb.db, { gameSlug: 'gundam' });
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]?.code).toBe('SAMPLE-01');
    expect(mine.nextCursor).toBeNull();

    const none = await listSets(tdb.db, { gameSlug: 'does-not-exist' });
    expect(none.items).toEqual([]);
  });

  it('searches cards by name and number', async () => {
    const byName = await searchCards(tdb.db, { q: 'pilot' });
    expect(byName.items.map((c) => c.name)).toEqual(['Sample Pilot Gamma']);

    const byNumber = await searchCards(tdb.db, { q: '002' });
    expect(byNumber.items.map((c) => c.number)).toEqual(['002']);

    const none = await searchCards(tdb.db, { q: 'zaku-not-seeded' });
    expect(none.items).toEqual([]);
  });

  it('treats search input as data, not SQL', async () => {
    const evil = await searchCards(tdb.db, { q: "'; drop table app.cards; --" });
    expect(evil.items).toEqual([]);
    // Table still there.
    expect((await searchCards(tdb.db, {})).items.length).toBeGreaterThan(0);
  });

  it('paginates with a cursor and clamps the page size', async () => {
    const first = await searchCards(tdb.db, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await searchCards(tdb.db, { limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const ids = new Set([...first.items, ...second.items].map((c) => c.id));
    expect(ids.size).toBe(3);

    const huge = await searchCards(tdb.db, { limit: 10_000 });
    expect(huge.items.length).toBeLessThanOrEqual(MAX_PAGE_SIZE);
    const silly = await searchCards(tdb.db, { limit: -5 });
    expect(silly.items.length).toBeGreaterThan(0);
  });

  it('gets a card with its variants, and null for unknown ids', async () => {
    const { items } = await searchCards(tdb.db, { q: 'Alpha' });
    const id = items[0]?.id;
    expect(id).toBeDefined();
    const card = await getCardById(tdb.db, id as string);
    expect(card?.name).toBe('Sample Unit Alpha');
    expect(card?.variants.map((v) => v.finish)).toEqual(['normal', 'parallel']);

    await expect(getCardById(tdb.db, '00000000-0000-0000-0000-000000000000')).resolves.toBeNull();
  });

  it('lists sealed products', async () => {
    const products = await listSealedProducts(tdb.db, { gameSlug: 'gundam' });
    expect(products.items.map((p) => p.kind)).toEqual(['booster_box']);
  });

  it('does not re-seed an already seeded database', async () => {
    await seedSample(tdb.db);
    expect(await listGames(tdb.db)).toHaveLength(1);
  });
});

describe('database constraints', () => {
  it('rejects enabling a retailer before its ToS/robots review (FR-1.4)', async () => {
    await expectDbError(
      tdb.db.execute(
        `update app.retailers set enabled = true where domain = 'sample-retailer.invalid'`,
      ),
      /retailers_enabled_requires_review/,
    );
  });

  it('allows enabling once reviewed', async () => {
    await tdb.db.execute(
      `update app.retailers set robots_ok = true, tos_reviewed_at = now(), enabled = true
         where domain = 'sample-retailer.invalid'`,
    );
    const [row] = await tdb.db.execute<{ enabled: boolean }>(
      `select enabled from app.retailers where domain = 'sample-retailer.invalid'`,
    );
    expect(row?.enabled).toBe(true);
    await tdb.db.execute(
      `update app.retailers set enabled = false, robots_ok = false, tos_reviewed_at = null
         where domain = 'sample-retailer.invalid'`,
    );
  });

  it('rejects non-https retailer product urls (SR-1.1)', async () => {
    await expectDbError(
      tdb.db.execute(
        `insert into app.retailer_products (retailer_id, sealed_product_id, url)
         select r.id, p.id, 'http://sample-retailer.invalid/x' from app.retailers r, app.sealed_products p limit 1`,
      ),
      /retailer_products_url_https/,
    );
  });

  it('rejects a scan interval below the floor and negative prices', async () => {
    await expectDbError(
      tdb.db.execute(`update app.retailers set min_interval_s = 5`),
      /retailers_min_interval_positive/,
    );
    await expectDbError(
      tdb.db.execute(
        `insert into app.stock_snapshots (retailer_product_id, in_stock, price_cents)
         select id, true, -1 from app.retailer_products limit 1`,
      ),
      /stock_snapshots_price_nonneg/,
    );
  });

  it('rejects a bogus currency code', async () => {
    await expectDbError(
      tdb.db.execute(
        `insert into app.stock_snapshots (retailer_product_id, in_stock, currency)
         select id, true, 'dollars' from app.retailer_products limit 1`,
      ),
      /stock_snapshots_currency_iso/,
    );
  });

  it('keeps card numbers unique within a set', async () => {
    await expectDbError(
      tdb.db.execute(
        `insert into app.cards (set_id, number, name)
         select set_id, number, 'dupe' from app.cards limit 1`,
      ),
      /cards_set_number_key/,
    );
  });
});

describe('role privileges (least privilege, SR-X.8)', () => {
  it('web role edits the catalog (admin UI) but cannot run DDL or write stock history', async () => {
    const web = createDb({ url: tdb.urlFor('web'), max: 1 });
    try {
      const rows = await web.db.execute(`select count(*)::int as n from app.cards`);
      expect(rows[0]).toMatchObject({ n: 3 });

      // Catalog writes are allowed: admin curation goes through the API, which runs as app_web.
      await web.db.execute(`insert into app.games (slug, name) values ('tmp-test', 'Temp')`);
      await web.db.execute(`delete from app.games where slug = 'tmp-test'`);

      // But it may not change the schema...
      await expectDbError(web.db.execute(`create table app.nope (id int)`), /permission denied/);
      // ...nor fabricate stock history (that is the worker's job, insert-only).
      await expectDbError(
        web.db.execute(
          `insert into app.stock_snapshots (retailer_product_id, in_stock)
           select id, true from app.retailer_products limit 1`,
        ),
        /permission denied/,
      );
    } finally {
      await web.close();
    }
  });

  it('audit log is append-only for the web role', async () => {
    const web = createDb({ url: tdb.urlFor('web'), max: 1 });
    try {
      await web.db.execute(
        `insert into app.audit_log (action, target_type) values ('test.write', 'test')`,
      );
      await expectDbError(
        web.db.execute(`update app.audit_log set action = 'tampered'`),
        /permission denied/,
      );
      await expectDbError(web.db.execute(`delete from app.audit_log`), /permission denied/);
      await expectDbError(web.db.execute(`truncate app.audit_log`), /permission denied/);
    } finally {
      await web.close();
    }
  });

  it('worker can append stock snapshots but not edit the catalog or rewrite history', async () => {
    const worker = createDb({ url: tdb.urlFor('worker'), max: 1 });
    try {
      await worker.db.execute(
        `insert into app.stock_snapshots (retailer_product_id, in_stock, price_cents)
         select id, true, 9999 from app.retailer_products limit 1`,
      );
      await expectDbError(
        worker.db.execute(`update app.cards set name = 'tampered'`),
        /permission denied/,
      );
      await expectDbError(
        worker.db.execute(`update app.retailers set enabled = true`),
        /permission denied/,
      );
      await expectDbError(
        worker.db.execute(`delete from app.stock_snapshots`),
        /permission denied/,
      );
    } finally {
      await worker.close();
    }
  });

  it('readonly role cannot write anything', async () => {
    const ro = createDb({ url: tdb.urlFor('readonly'), max: 1 });
    try {
      const rows = await ro.db.execute(`select count(*)::int as n from app.sets`);
      expect(rows[0]).toMatchObject({ n: 1 });
      await expectDbError(
        ro.db.execute(`insert into app.audit_log (action, target_type) values ('x', 'y')`),
        /read-only transaction|permission denied/,
      );
      await expectDbError(
        ro.db.execute(`update app.cards set name = 'tampered'`),
        /read-only transaction|permission denied/,
      );
    } finally {
      await ro.close();
    }
  });
});
