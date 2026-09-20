import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { seedSample } from '../seed/sample.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import {
  MAX_LISTINGS_PER_PRODUCT_RETAILER,
  hostMatchesDomain,
  resolveListing,
} from './listings.js';

let tdb: TestDatabase;
/** Ingestion runs as app_worker in production, so privilege tests use that role. */
let workerPool: ReturnType<typeof createDb>;
const APPROVED = 'approved-shop.invalid';
const UNAPPROVED = 'unreviewed-shop.invalid';
const WORKER_SHOP = 'worker-shop.invalid';
const SLUG = 'sample-set-one-booster-box';

/** postgres.js wraps failures, so the permission text lives on `cause`. */
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
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 4 });

  // An approved retailer: review recorded, so the database permits enabling it.
  await tdb.db.execute(
    `insert into app.retailers (name, domain, adapter_key, robots_ok, tos_reviewed_at, enabled)
     values ('Approved Shop', '${APPROVED}', 'approved', true, now(), true),
            ('Worker Shop', '${WORKER_SHOP}', 'worker', true, now(), true)`,
  );
  // A retailer that exists but has not been reviewed, so it must stay off.
  await tdb.db.execute(
    `insert into app.retailers (name, domain, adapter_key, robots_ok, enabled)
     values ('Unreviewed Shop', '${UNAPPROVED}', 'unreviewed', false, false)`,
  );
});

afterAll(async () => {
  await workerPool.close();
  await tdb.close();
});

describe('hostMatchesDomain', () => {
  it('accepts the domain and its subdomains', () => {
    expect(hostMatchesDomain('shop.example.com', 'example.com')).toBe(true);
    expect(hostMatchesDomain('example.com', 'example.com')).toBe(true);
    expect(hostMatchesDomain('EXAMPLE.com', 'example.com')).toBe(true);
  });

  it('rejects lookalikes and suffix tricks', () => {
    for (const host of [
      'example.com.evil.test', // suffix attack
      'notexample.com', // substring
      'example.com.', // trailing dot handled, but different domain below
      'evil.test',
    ]) {
      const result = hostMatchesDomain(host, 'example.com');
      if (host === 'example.com.') expect(result).toBe(true);
      else expect(result, host).toBe(false);
    }
  });
});

describe('resolveListing', () => {
  it('creates a listing on first sight, then reuses it', async () => {
    const url = `https://${APPROVED}/products/box`;
    const first = await resolveListing(tdb.db, {
      productSlug: SLUG,
      retailerDomain: APPROVED,
      url,
    });
    expect(first).toMatchObject({ ok: true, created: true });

    const second = await resolveListing(tdb.db, {
      productSlug: SLUG,
      retailerDomain: APPROVED,
      url,
    });
    expect(second).toMatchObject({ ok: true, created: false });
    if (first.ok && second.ok) expect(second.retailerProductId).toBe(first.retailerProductId);
  });

  it('refuses a retailer that has not been reviewed and enabled', async () => {
    const result = await resolveListing(tdb.db, {
      productSlug: SLUG,
      retailerDomain: UNAPPROVED,
      url: `https://${UNAPPROVED}/products/box`,
    });
    expect(result).toEqual({ ok: false, reason: 'retailer_not_enabled' });
  });

  it('refuses a retailer we have never heard of', async () => {
    const result = await resolveListing(tdb.db, {
      productSlug: SLUG,
      retailerDomain: 'random-shop.invalid',
      url: 'https://random-shop.invalid/box',
    });
    expect(result).toEqual({ ok: false, reason: 'unknown_retailer' });
  });

  it('refuses a product that is not in our catalog', async () => {
    const result = await resolveListing(tdb.db, {
      productSlug: 'not-a-real-product',
      retailerDomain: APPROVED,
      url: `https://${APPROVED}/x`,
    });
    expect(result).toEqual({ ok: false, reason: 'unknown_product' });
  });

  it('refuses a url that does not belong to the named retailer', async () => {
    // The whole point: a compromised or buggy scanner must not be able to point one of
    // our listings at somewhere else entirely.
    const hostile = [
      'https://evil.test/box',
      `https://${APPROVED}.evil.test/box`,
      `http://${APPROVED}/box`, // not https
      'https://127.0.0.1/box',
      'https://169.254.169.254/latest/meta-data',
      'not a url',
    ];
    for (const url of hostile) {
      const result = await resolveListing(tdb.db, {
        productSlug: SLUG,
        retailerDomain: APPROVED,
        url,
      });
      expect(result, url).toEqual({ ok: false, reason: 'url_host_mismatch' });
    }
  });

  it('accepts a subdomain of the approved retailer', async () => {
    const result = await resolveListing(tdb.db, {
      productSlug: SLUG,
      retailerDomain: APPROVED,
      url: `https://store.${APPROVED}/products/box`,
    });
    expect(result).toMatchObject({ ok: true });
  });

  it('caps how many listings one report stream can create', async () => {
    for (let i = 0; i < MAX_LISTINGS_PER_PRODUCT_RETAILER + 5; i += 1) {
      await resolveListing(tdb.db, {
        productSlug: SLUG,
        retailerDomain: APPROVED,
        url: `https://${APPROVED}/flood/${String(i)}`,
      });
    }
    const rows = await tdb.db.execute<{ n: number }>(
      `select count(*)::int as n from app.retailer_products rp
         join app.retailers r on r.id = rp.retailer_id
        where r.domain = '${APPROVED}'`,
    );
    expect(rows[0]?.n ?? 0).toBeLessThanOrEqual(MAX_LISTINGS_PER_PRODUCT_RETAILER);

    const overflow = await resolveListing(tdb.db, {
      productSlug: SLUG,
      retailerDomain: APPROVED,
      url: `https://${APPROVED}/flood/one-too-many`,
    });
    expect(overflow).toEqual({ ok: false, reason: 'listing_limit_reached' });
  });
});

describe('app_worker privileges (migration 0009)', () => {
  it('can register a listing, which is what ingestion needs', async () => {
    const result = await resolveListing(workerPool.db, {
      productSlug: SLUG,
      retailerDomain: WORKER_SHOP,
      url: `https://${WORKER_SHOP}/products/box`,
    });
    expect(result).toMatchObject({ ok: true, created: true });
  });

  it('cannot repoint or remove a listing once it exists', async () => {
    await expectDbError(
      workerPool.db.execute(
        `update app.retailer_products set url = 'https://evil.test/x'
           where url = 'https://${WORKER_SHOP}/products/box'`,
      ),
      /permission denied/i,
    );
    await expectDbError(
      workerPool.db.execute(
        `delete from app.retailer_products where url = 'https://${WORKER_SHOP}/products/box'`,
      ),
      /permission denied/i,
    );
  });

  it('cannot approve a shop or invent a product', async () => {
    // The grant is INSERT on retailer_products alone; everything that decides *what may be
    // scanned at all* stays admin-only.
    await expectDbError(
      workerPool.db.execute(
        `insert into app.retailers (name, domain, adapter_key) values ('X', 'x.invalid', 'x')`,
      ),
      /permission denied/i,
    );
    await expectDbError(
      workerPool.db.execute(
        `update app.retailers set enabled = true where domain = '${UNAPPROVED}'`,
      ),
      /permission denied/i,
    );
    await expectDbError(
      workerPool.db.execute(
        `insert into app.sealed_products (game_id, kind, name, slug)
         select id, 'booster_box', 'Invented', 'invented' from app.games limit 1`,
      ),
      /permission denied/i,
    );
  });
});
