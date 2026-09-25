import { createDb, createListing, seedSample, setListingStatus } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';

/**
 * `GET /v1/cards/:id/listings` — the entry point to buying anything (FR-5.2).
 *
 * Built on the **read-only pool**, deliberately, because that is the role the public routes
 * actually run as and it is the reason most of the assertions below hold. A draft is not
 * filtered out by this route; it is invisible to the connection the route uses. Running this
 * suite as the owner would prove nothing about either.
 */
const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });

let tdb: TestDatabase;
let app: FastifyInstance;
let webPool: ReturnType<typeof createDb>;
let readonlyPool: ReturnType<typeof createDb>;

const SELLER = 'browse-seller';
let cardId = '';
let variantId = '';

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  readonlyPool = createDb({ url: tdb.urlFor('readonly'), max: 2 });
  app = await buildApp(config, { db: readonlyPool.db });

  await tdb.db.execute(
    `insert into app.users (id, name, email) values ('${SELLER}', '${SELLER}', '${SELLER}@example.invalid')`,
  );
  const [variant] = await tdb.db.execute<{ id: string; card_id: string }>(
    `select id, card_id from app.card_variants limit 1`,
  );
  variantId = String(variant?.id);
  cardId = String(variant?.card_id);
}, 180_000);

afterAll(async () => {
  await app.close();
  await webPool.close();
  await readonlyPool.close();
  await tdb.close();
});

beforeEach(async () => {
  await tdb.db.execute(`truncate app.orders, app.listings cascade`);
});

async function listFor(priceCents: number, publish: boolean): Promise<string> {
  const listing = await createListing(webPool.db, SELLER, {
    cardVariantId: variantId,
    condition: 'nm',
    priceCents,
    quantity: 1,
  });
  if (publish) await setListingStatus(webPool.db, SELLER, listing.id, 'active');
  return listing.id;
}

describe('what is for sale for a card', () => {
  it('answers anybody, with no session at all', async () => {
    const id = await listFor(2500, true);

    const res = await app.inject({ method: 'GET', url: `/v1/cards/${cardId}/listings` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: { id: string; priceCents: number }[] }>();
    expect(body.items.map((l) => l.id)).toEqual([id]);
    expect(body.items[0]?.priceCents).toBe(2500);
  });

  it('orders by price, so the cheapest is the first thing read', async () => {
    await listFor(3000, true);
    await listFor(1000, true);
    await listFor(2000, true);

    const res = await app.inject({ method: 'GET', url: `/v1/cards/${cardId}/listings` });
    expect(res.json<{ items: { priceCents: number }[] }>().items.map((l) => l.priceCents)).toEqual([
      1000, 2000, 3000,
    ]);
  });

  it('cannot show a draft, because the role it runs as cannot see one', async () => {
    await listFor(100, false);

    const res = await app.inject({ method: 'GET', url: `/v1/cards/${cardId}/listings` });
    expect(res.json<{ items: unknown[] }>().items).toEqual([]);
  });

  /**
   * The response schema is the control, not the query.
   *
   * `browseListingsForCard` never selects a seller id into its result, and the registrar parses
   * every response through its zod schema before sending it — so even if the query changed to
   * return one, the route could not emit it. Asserted on the serialised body rather than on a
   * field name, because the point is that the string does not appear anywhere.
   */
  it('never names the seller, on a route that answers to anyone', async () => {
    await listFor(2500, true);

    const res = await app.inject({ method: 'GET', url: `/v1/cards/${cardId}/listings` });
    expect(res.body).not.toContain(SELLER);
    expect(res.json<{ items: Record<string, unknown>[] }>().items[0]).not.toHaveProperty(
      'sellerId',
    );
  });

  it('shows an unrated seller as unrated rather than as nought out of five', async () => {
    await listFor(2500, true);

    const res = await app.inject({ method: 'GET', url: `/v1/cards/${cardId}/listings` });
    expect(res.json<{ items: { seller: unknown }[] }>().items[0]?.seller).toEqual({
      average: null,
      count: 0,
    });
  });

  it('answers with no picture when object storage is not configured', async () => {
    /**
     * This app is built without `photos`, so the registrar has no presigner to hand the route.
     * The listing must still be served — a deployment without photographs is a deployment
     * without photographs, not one that cannot show what is for sale.
     */
    await listFor(2500, true);

    const res = await app.inject({ method: 'GET', url: `/v1/cards/${cardId}/listings` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: { photoUrl: unknown }[] }>().items[0]?.photoUrl).toBeNull();
  });

  it('answers a card that does not exist with an empty list, not a 404', async () => {
    // Which cards exist is what GET /v1/cards/{id} is for. Answering it twice would be a
    // second thing to keep in agreement with the first.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/cards/00000000-0000-7000-8000-000000000000/listings',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it('refuses an id that is not one', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/cards/not-a-uuid/listings' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_request');
    // Field and rule only. The submitted value is never echoed back (SR-X.10).
    expect(res.body).not.toContain('not-a-uuid');
  });

  /**
   * Being in `publicRoutes` is what makes it public.
   *
   * That one array drives CORS, the kill switch, quota metering, the OpenAPI document and the
   * deny-by-default exemption. These two assertions are how we know the new path was actually
   * treated as one of them rather than merely registered.
   */
  it('is cached briefly, because a listing is the most perishable thing here', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/cards/${cardId}/listings` });
    expect(res.headers['cache-control']).toBe('public, max-age=30');
    expect(res.headers.etag).toBeDefined();
  });

  it('is readable cross-origin, like the rest of the public API', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/cards/${cardId}/listings`,
      headers: { origin: 'https://somebody-elses-site.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('*');
    // Anonymous and cacheable: no credentials are ever sent to it.
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('appears in the published API document', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/openapi.json' });
    const doc = res.json<{ paths: Record<string, unknown> }>();
    expect(doc.paths).toHaveProperty('/v1/cards/{id}/listings');
  });
});
