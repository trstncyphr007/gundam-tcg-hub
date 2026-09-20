import type { DeliveryOutcome, RestockMessage, Transport } from '@gth/alerts';
import {
  asUser,
  createApiKey,
  createDb,
  getRestockContext,
  listDeliveriesForEvent,
  seedSample,
} from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import { generateToken, hashToken } from '@gth/security';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';

const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });
const PEPPER = 'test-pepper-at-least-32-characters-long';

let tdb: TestDatabase;
/** Ingestion runs as app_worker in production; use the same role here so grants and RLS apply. */
let workerPool: ReturnType<typeof createDb>;
let app: FastifyInstance;
let listingId: string;
let productId: string;
let validKey: string;
let noScopeKey: string;
let revokedKey: string;

const sentEmails: { to: string; message: RestockMessage }[] = [];
let emailOutcome: DeliveryOutcome = { ok: true };

const emailTransport: Transport = {
  send: (message, recipient) => {
    sentEmails.push({ to: recipient.email, message });
    return Promise.resolve(emailOutcome);
  },
};

async function mintKey(
  name: string,
  scopes: ('ingest:write' | 'catalog:read')[],
  revoked = false,
): Promise<string> {
  const prefix = generateToken(16)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8);
  const secret = generateToken(32);
  await createApiKey(tdb.db, { name, prefix, keyHash: hashToken(secret, PEPPER), scopes });
  if (revoked) {
    await tdb.db.execute(`update app.api_keys set revoked_at = now() where prefix = '${prefix}'`);
  }
  return `gth_test_${prefix}_${secret}`;
}

async function report(key: string, body: object): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/v1/ingest/stock',
    headers: { authorization: `Bearer ${key}` },
    payload: body,
  });
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  const listings = await tdb.db.execute<{ id: string; sealed_product_id: string }>(
    `select id, sealed_product_id from app.retailer_products limit 1`,
  );
  listingId = String(listings[0]?.id);
  productId = String(listings[0]?.sealed_product_id);

  validKey = await mintKey('scanner', ['ingest:write']);
  noScopeKey = await mintKey('read-only bot', ['catalog:read']);
  revokedKey = await mintKey('old scanner', ['ingest:write'], true);

  workerPool = createDb({ url: tdb.urlFor('worker'), max: 4 });
  app = await buildApp(config, {
    db: tdb.db,
    ingest: {
      workerDb: workerPool.db,
      tokenPepper: PEPPER,
      transports: { email: emailTransport },
      buildMessage: async (db, id, priceCents, currency) => {
        const context = await getRestockContext(db, id);
        return context ? { ...context, priceCents, currency, detectedAt: new Date() } : null;
      },
    },
  });
});

afterAll(async () => {
  await app.close();
  await workerPool.close();
  await tdb.close();
});

beforeEach(() => {
  sentEmails.length = 0;
  emailOutcome = { ok: true };
});

describe('authentication (SR-3.1)', () => {
  it('rejects missing, malformed, unknown, revoked and wrong-secret keys', async () => {
    const goodPrefix = validKey.split('_')[2];
    const cases: [string, string | null][] = [
      ['no header', null],
      ['not a bearer token', 'Basic abc'],
      ['wrong format', 'gth_live_short'],
      ['unknown prefix', `gth_test_zzzzzzzz_${generateToken(32)}`],
      ['wrong secret for a real prefix', `gth_test_${String(goodPrefix)}_${generateToken(32)}`],
      ['revoked key', revokedKey],
    ];
    for (const [label, key] of cases) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/ingest/stock',
        ...(key === null
          ? {}
          : { headers: { authorization: key.startsWith('Basic') ? key : `Bearer ${key}` } }),
        payload: { reports: [{ retailerProductId: listingId, inStock: true }] },
      });
      expect(res.statusCode, label).toBe(401);
    }
  });

  it('rejects a valid key without the ingest scope', async () => {
    const res = await report(noScopeKey, {
      reports: [{ retailerProductId: listingId, inStock: true }],
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts a valid key and records last use', async () => {
    const res = await report(validKey, {
      reports: [{ retailerProductId: listingId, inStock: false }],
    });
    expect(res.statusCode).toBe(202);
    const rows = await tdb.db.execute<{ n: number }>(
      `select count(*)::int as n from app.api_keys where last_used_at is not null`,
    );
    expect(rows[0]?.n ?? 0).toBeGreaterThan(0);
  });
});

describe('payload validation', () => {
  it('rejects malformed reports', async () => {
    const bad: object[] = [
      {},
      { reports: [] },
      { reports: [{ retailerProductId: 'nope', inStock: true }] },
      { reports: [{ retailerProductId: listingId }] },
      { reports: [{ retailerProductId: listingId, inStock: 'yes' }] },
      { reports: [{ retailerProductId: listingId, inStock: true, priceCents: -1 }] },
      { reports: [{ retailerProductId: listingId, inStock: true, currency: 'dollars' }] },
      { reports: [{ retailerProductId: listingId, inStock: true, extra: 1 }] },
      {
        reports: Array.from({ length: 101 }, () => ({
          retailerProductId: listingId,
          inStock: true,
        })),
      },
    ];
    for (const payload of bad) {
      const res = await report(validKey, payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
    }
  });

  it('422s for an unknown listing id rather than 500', async () => {
    const res = await report(validKey, {
      reports: [{ retailerProductId: '00000000-0000-0000-0000-000000000000', inStock: true }],
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('reports by product + shop + url (ADR-016)', () => {
  const SHOP = 'ingest-shop.invalid';

  beforeAll(async () => {
    await tdb.db.execute(
      `insert into app.retailers (name, domain, adapter_key, robots_ok, tos_reviewed_at, enabled)
       values ('Ingest Shop', '${SHOP}', 'ingest', true, now(), true)`,
    );
  });

  it('registers the listing on first sight and detects the restock on the next report', async () => {
    const url = `https://${SHOP}/products/booster-box`;
    const first = await report(validKey, {
      reports: [
        {
          productSlug: 'sample-set-one-booster-box',
          retailerDomain: SHOP,
          url,
          inStock: false,
        },
      ],
    });
    expect(first.statusCode).toBe(202);
    const created = first.json<{
      results: { retailerProductId: string; listingCreated?: boolean; restock: boolean }[];
    }>().results[0];
    expect(created?.listingCreated).toBe(true);
    expect(created?.restock).toBe(false);

    // Second report, same URL: no new listing, and the transition is a real restock.
    const second = await report(validKey, {
      reports: [
        {
          productSlug: 'sample-set-one-booster-box',
          retailerDomain: SHOP,
          url,
          inStock: true,
          priceCents: 8499,
        },
      ],
    });
    const again = second.json<{
      results: { retailerProductId: string; listingCreated?: boolean; restock: boolean }[];
    }>().results[0];
    expect(again?.listingCreated).toBeUndefined();
    expect(again?.retailerProductId).toBe(created?.retailerProductId);
    expect(again?.restock).toBe(true);
  });

  it('refuses reports that would invent a listing somewhere we have not approved', async () => {
    const cases: [string, object, string][] = [
      [
        'a shop we have never reviewed',
        {
          productSlug: 'sample-set-one-booster-box',
          retailerDomain: 'nope.invalid',
          url: 'https://nope.invalid/x',
        },
        'unknown_retailer',
      ],
      [
        'a known shop that is not enabled',
        {
          productSlug: 'sample-set-one-booster-box',
          retailerDomain: 'sample-retailer.invalid',
          url: 'https://sample-retailer.invalid/x',
        },
        'retailer_not_enabled',
      ],
      [
        'a product not in the catalog',
        { productSlug: 'not-a-product', retailerDomain: SHOP, url: `https://${SHOP}/x` },
        'unknown_product',
      ],
      [
        'a url belonging to someone else',
        {
          productSlug: 'sample-set-one-booster-box',
          retailerDomain: SHOP,
          url: 'https://evil.test/x',
        },
        'url_host_mismatch',
      ],
      [
        'a lookalike host',
        {
          productSlug: 'sample-set-one-booster-box',
          retailerDomain: SHOP,
          url: `https://${SHOP}.evil.test/x`,
        },
        'url_host_mismatch',
      ],
    ];

    for (const [label, fields, reason] of cases) {
      const res = await report(validKey, { reports: [{ ...fields, inStock: true }] });
      expect(res.statusCode, label).toBe(422);
      expect(res.json<{ reason: string }>().reason, label).toBe(reason);
    }
  });

  it('rejects malformed by-url reports before they reach the resolver', async () => {
    const bad: object[] = [
      { productSlug: 'Sample_Set', retailerDomain: SHOP, url: `https://${SHOP}/x`, inStock: true },
      {
        productSlug: 'sample-set-one-booster-box',
        retailerDomain: 'not a domain',
        url: `https://${SHOP}/x`,
        inStock: true,
      },
      {
        productSlug: 'sample-set-one-booster-box',
        retailerDomain: SHOP,
        url: `http://${SHOP}/x`,
        inStock: true,
      },
      // Half a report: neither shape is satisfied, so the union rejects it.
      { productSlug: 'sample-set-one-booster-box', inStock: true },
      { retailerDomain: SHOP, url: `https://${SHOP}/x`, inStock: true },
      // Mixing both shapes is not a way to smuggle an id past the guards.
      {
        retailerProductId: '00000000-0000-0000-0000-000000000000',
        productSlug: 'sample-set-one-booster-box',
        retailerDomain: SHOP,
        url: `https://${SHOP}/x`,
        inStock: true,
      },
    ];
    for (const payload of bad) {
      const res = await report(validKey, { reports: [payload] });
      expect(res.statusCode, JSON.stringify(payload).slice(0, 70)).toBe(400);
    }
  });
});

describe('restock detection (FR-1.7)', () => {
  it('does not alert on a first sighting, even if in stock', async () => {
    const fresh = await tdb.db.execute<{ id: string }>(
      `insert into app.retailer_products (retailer_id, sealed_product_id, url)
       select r.id, '${productId}', 'https://sample-retailer.invalid/new-listing'
       from app.retailers r limit 1 returning id`,
    );
    const res = await report(validKey, {
      reports: [{ retailerProductId: String(fresh[0]?.id), inStock: true }],
    });
    expect(res.json<{ results: { restock: boolean }[] }>().results[0]?.restock).toBe(false);
  });

  it('alerts only on out-of-stock → in-stock', async () => {
    await report(validKey, { reports: [{ retailerProductId: listingId, inStock: false }] });

    const restock = await report(validKey, {
      reports: [{ retailerProductId: listingId, inStock: true, priceCents: 8999 }],
    });
    expect(restock.json<{ results: { restock: boolean }[] }>().results[0]?.restock).toBe(true);

    // Still in stock on the next pass: no second event.
    const again = await report(validKey, {
      reports: [{ retailerProductId: listingId, inStock: true }],
    });
    expect(again.json<{ results: { restock: boolean }[] }>().results[0]?.restock).toBe(false);
  });

  it('records every observation as history', async () => {
    const rows = await tdb.db.execute<{ n: number }>(
      `select count(*)::int as n from app.stock_snapshots where retailer_product_id = '${listingId}'`,
    );
    expect(rows[0]?.n ?? 0).toBeGreaterThan(2);
  });
});

describe('alert fan-out (FR-1.8)', () => {
  it('delivers to watchers of the product and of the listing, once each', async () => {
    // Two watchers: one on the product, one on this specific listing.
    await tdb.db.execute(
      `insert into app.users (id, name, email) values
         ('watch-user-1', 'One', 'one@example.com'),
         ('watch-user-2', 'Two', 'two@example.com')
       on conflict do nothing`,
    );
    // Row-level security applies to the table owner too, so even a test fixture must
    // declare who it is acting as — the same path the API uses.
    await asUser(tdb.db, 'watch-user-1', (tx) =>
      tx.execute(
        `insert into app.watch_subscriptions (user_id, sealed_product_id, channels)
         values ('watch-user-1', '${productId}', array['email']::app.alert_channel[])
         on conflict do nothing`,
      ),
    );
    await asUser(tdb.db, 'watch-user-2', (tx) =>
      tx.execute(
        `insert into app.watch_subscriptions (user_id, retailer_product_id, channels)
         values ('watch-user-2', '${listingId}', array['email']::app.alert_channel[])
         on conflict do nothing`,
      ),
    );

    await report(validKey, { reports: [{ retailerProductId: listingId, inStock: false }] });
    sentEmails.length = 0;
    const res = await report(validKey, {
      reports: [{ retailerProductId: listingId, inStock: true, priceCents: 7999 }],
    });
    expect(res.statusCode).toBe(202);

    expect(sentEmails.map((e) => e.to).sort()).toEqual(['one@example.com', 'two@example.com']);
    expect(sentEmails[0]?.message.productName).toBe('Sample Set One Booster Box');

    const events = await tdb.db.execute<{ id: string }>(
      `select id from app.restock_events order by detected_at desc limit 1`,
    );
    const deliveries = await listDeliveriesForEvent(tdb.db, String(events[0]?.id));
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((d) => d.status === 'sent')).toBe(true);
  });

  it('records a failure without throwing, and keeps other deliveries independent', async () => {
    emailOutcome = { ok: false, reason: 'smtp exploded', retryable: true };
    await report(validKey, { reports: [{ retailerProductId: listingId, inStock: false }] });
    const res = await report(validKey, {
      reports: [{ retailerProductId: listingId, inStock: true }],
    });
    expect(res.statusCode).toBe(202);

    const events = await tdb.db.execute<{ id: string }>(
      `select id from app.restock_events order by detected_at desc limit 1`,
    );
    const deliveries = await listDeliveriesForEvent(tdb.db, String(events[0]?.id));
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((d) => d.status === 'failed')).toBe(true);
    expect(deliveries[0]?.lastError).toContain('smtp exploded');
    expect(deliveries[0]?.attempts).toBe(1);
  });

  it('never sends the same alert twice for one event', async () => {
    const events = await tdb.db.execute<{ id: string }>(
      `select id from app.restock_events order by detected_at desc limit 1`,
    );
    const eventId = String(events[0]?.id);
    const before = await listDeliveriesForEvent(tdb.db, eventId);

    // Re-running the fan-out claims nothing new: the unique index is the guard.
    const { dispatchRestockEvent } = await import('@gth/alerts');
    sentEmails.length = 0;
    const result = await dispatchRestockEvent(
      { db: tdb.db, transports: { email: emailTransport } },
      { id: eventId, retailerProductId: listingId },
      {
        productName: 'x',
        retailerName: 'y',
        url: 'https://sample-retailer.invalid/x',
        priceCents: null,
        currency: 'USD',
        detectedAt: new Date(),
      },
    );
    expect(result.claimed).toBe(0);
    expect(sentEmails).toHaveLength(0);
    expect(await listDeliveriesForEvent(tdb.db, eventId)).toHaveLength(before.length);
  });
});
