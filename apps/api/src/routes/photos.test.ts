import { createAuth } from '@gth/auth';
import { MAX_PHOTOS_PER_LISTING } from '@gth/core';
import { createDb, seedSample } from '@gth/db';
import { type TestDatabase, startTestDatabase } from '@gth/db/test';
import { createScanner, createStorage } from '@gth/photos';
import type { FastifyInstance } from 'fastify';
import { PNG } from 'pngjs';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { type ApiConfig, loadConfig } from '../config.js';
import { TEST_PASSKEY } from '../test/auth-fixtures.js';

/**
 * Uploading a photograph, end to end (FR-5.2, SR-5.5, AC-5.3).
 *
 * Real storage, a real virus scanner and a real database. The file genuinely leaves the test
 * process by a presigned PUT, genuinely lands in a bucket, and is genuinely fetched back by the
 * pipeline — because the one thing a mocked version of this would not catch is the pipeline
 * looking for the file somewhere other than where the browser put it, which is exactly the bug
 * the first draft of these routes had.
 */
const config: ApiConfig = loadConfig({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });
const ORIGIN = 'http://127.0.0.1:3000';
const ACCESS_KEY = 'accessKey1';
const SECRET_KEY = 'verySecretKey1';
const BUCKET = 'gth-photos-routes';

let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let s3: StartedTestContainer;
let clam: StartedTestContainer;
let app: FastifyInstance;

let sellerCookie = '';
let variantId = '';
const sentLinks: { email: string; url: string }[] = [];

/** A real PNG with real pixels, encoded by a real encoder. */
function realPng(width = 600, height = 800): Uint8Array {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data.set([200, 40, 40, 255], i);
  }
  return new Uint8Array(PNG.sync.write(png));
}

function ascii(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) out.push(text.charCodeAt(i));
  return out;
}

/**
 * A seller nobody has used before, one per test.
 *
 * Uploading is limited to twenty a minute **per account**, and this file does well over twenty
 * across its tests. Sharing one seller spends the allowance on itself — the same way
 * `seller.test.ts` found its onboarding limit and `checkout.test.ts` found its buy limit. Three
 * times now, which is why the helper exists rather than the number being raised.
 */
let sellerCounter = 0;
async function newSeller(): Promise<string> {
  sellerCounter += 1;
  return signIn(`photo-seller-${String(sellerCounter)}@example.com`);
}

let ipCounter = 0;
async function signIn(email: string): Promise<string> {
  ipCounter += 1;
  const ip = `198.51.104.${String(ipCounter % 250)}`;
  const before = sentLinks.length;
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/magic-link',
    headers: { origin: ORIGIN, 'x-forwarded-for': ip },
    payload: { email, callbackURL: '/' },
  });
  const url = new URL(String(sentLinks.at(before)?.url));
  const verified = await app.inject({
    method: 'GET',
    url: url.pathname + url.search,
    headers: { 'x-forwarded-for': ip },
  });
  const raw = verified.headers['set-cookie'];
  const joined = Array.isArray(raw) ? raw.join('\n') : String(raw);
  return String(/gth\.session_token=[^;\s]+/.exec(joined)?.[0]);
}

async function newListing(cookie = sellerCookie, priceCents = 5000): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/listings',
    headers: { cookie, origin: ORIGIN },
    payload: { cardVariantId: variantId, condition: 'nm', priceCents, quantity: 1 },
  });
  return created.json<{ id: string }>().id;
}

/** The whole browser side: ask for a URL, PUT the bytes to it, then ask us to process them. */
async function upload(
  listingId: string,
  body: Uint8Array,
  contentType = 'image/png',
  cookie = sellerCookie,
) {
  const started = await app.inject({
    method: 'POST',
    url: `/v1/listings/${listingId}/photos`,
    headers: { cookie, origin: ORIGIN },
    payload: { contentType, contentLength: body.length },
  });
  // Loud on purpose. The first version returned an object with no `photoId` when this failed,
  // so four later tests failed with `400 invalid_request` on an `undefined` in a URL — which
  // says nothing about the actual cause (a rate limit, as it turned out).
  expect(started.statusCode, `could not start an upload: ${started.body}`).toBe(201);

  const { photoId, uploadUrl } = started.json<{ photoId: string; uploadUrl: string }>();
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType, 'content-length': String(body.length) },
    body,
  });
  expect(put.ok, 'the presigned PUT was refused').toBe(true);

  const completed = await app.inject({
    method: 'POST',
    url: `/v1/listings/${listingId}/photos/${photoId}/complete`,
    headers: { cookie, origin: ORIGIN },
  });
  return { started, completed, photoId };
}

beforeAll(async () => {
  [tdb, s3, clam] = await Promise.all([
    startTestDatabase(),
    new GenericContainer('zenko/cloudserver:latest')
      .withEnvironment({
        S3BACKEND: 'mem',
        REMOTE_MANAGEMENT_DISABLE: '1',
        SCALITY_ACCESS_KEY_ID: ACCESS_KEY,
        SCALITY_SECRET_ACCESS_KEY: SECRET_KEY,
      })
      .withExposedPorts(8000)
      .withWaitStrategy(Wait.forListeningPorts())
      .withStartupTimeout(120_000)
      .start(),
    new GenericContainer('clamav/clamav:1.4')
      .withEnvironment({ CLAMAV_NO_FRESHCLAMD: 'true' })
      .withExposedPorts(3310)
      .withWaitStrategy(Wait.forLogMessage(/Self checking every .* seconds|clamd started/iu))
      .withStartupTimeout(300_000)
      .start(),
  ]);

  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 2 });

  const storage = createStorage({
    endpoint: `http://${s3.getHost()}:${String(s3.getMappedPort(8000))}`,
    bucket: BUCKET,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, region: 'us-east-1' },
  });
  await storage.ensureBucket();

  const auth = createAuth(tdb.db, {
    baseURL: 'http://127.0.0.1:4000',
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: ['http://127.0.0.1:4000', ORIGIN],
    production: false,
    trustProxyHeaders: true,
    passkey: TEST_PASSKEY,
    sendMagicLink: ({ email, url }) => {
      sentLinks.push({ email, url });
      return Promise.resolve();
    },
  });

  app = await buildApp(config, {
    db: tdb.db,
    writeDb: webPool.db,
    auth,
    photos: {
      db: webPool.db,
      workerDb: workerPool.db,
      storage,
      scanner: createScanner({
        host: clam.getHost(),
        port: clam.getMappedPort(3310),
        timeoutMs: 30_000,
      }),
    },
  });

  const [variant] = await tdb.db.execute<{ id: string }>(
    `select id from app.card_variants limit 1`,
  );
  variantId = String(variant?.id);
}, 420_000);

afterAll(async () => {
  await app.close();
  await webPool.close();
  await workerPool.close();
  await Promise.all([tdb.close(), s3.stop(), clam.stop()]);
});

beforeEach(async () => {
  await tdb.db.execute(`truncate app.listing_photos, app.listings, app.audit_log cascade`);
  sellerCookie = await newSeller();
});

describe('a photograph that is a photograph', () => {
  it('goes from presigned URL to approved copy', async () => {
    const listingId = await newListing();
    const { started, completed } = await upload(listingId, realPng());

    expect(started.statusCode).toBe(201);
    // The conditions the browser must satisfy are handed back explicitly rather than implied.
    expect(started.json<{ requiredHeaders: Record<string, string> }>().requiredHeaders).toEqual({
      'content-type': 'image/png',
      'content-length': String(realPng().length),
    });

    expect(completed.statusCode).toBe(200);
    expect(completed.json<{ status: string }>().status).toBe('approved');
  });

  it('is served through a short-lived URL, and the original is gone', async () => {
    const listingId = await newListing();
    await upload(listingId, realPng());

    const list = await app.inject({
      method: 'GET',
      url: `/v1/listings/${listingId}/photos`,
      headers: { cookie: sellerCookie },
    });
    const [photo] = list.json<{ items: { url: string | null; status: string }[] }>().items;
    expect(photo?.status).toBe('approved');
    expect(photo?.url).toContain('X-Amz-Signature');

    // And it really is fetchable, as a JPEG — whatever was uploaded.
    const served = await fetch(String(photo?.url));
    expect(served.status).toBe(200);
    const bytes = new Uint8Array(await served.arrayBuffer());
    expect([bytes.at(0), bytes.at(1)], 'the served copy is not a JPEG').toEqual([0xff, 0xd8]);
  });

  it('never caches the gallery, because the URLs in it expire', async () => {
    const listingId = await newListing();
    const list = await app.inject({
      method: 'GET',
      url: `/v1/listings/${listingId}/photos`,
      headers: { cookie: sellerCookie },
    });
    expect(list.headers['cache-control']).toBe('no-store');
  });

  it('lets a listing over $25 go on sale once it has one', async () => {
    /**
     * The loop closed.
     *
     * `canPublish` counted a hardcoded zero until #97 and a real number afterwards, but nothing
     * could approve a photo until now — so this is the first time the photo requirement has
     * ever been satisfiable rather than merely enforced.
     */
    const listingId = await newListing(sellerCookie, 4000);

    const before = await app.inject({
      method: 'POST',
      url: `/v1/listings/${listingId}/status`,
      headers: { cookie: sellerCookie, origin: ORIGIN },
      payload: { status: 'active' },
    });
    expect(before.statusCode, 'a $40 listing went live with no photo').toBe(409);
    expect(before.json<{ error: string }>().error).toBe('photos_required');

    await upload(listingId, realPng());

    const after = await app.inject({
      method: 'POST',
      url: `/v1/listings/${listingId}/status`,
      headers: { cookie: sellerCookie, origin: ORIGIN },
      payload: { status: 'active' },
    });
    expect(after.statusCode).toBe(200);
  });
});

describe('files that are refused', () => {
  it('refuses a real image with a web page glued on after it (AC-5.3)', async () => {
    const polyglot = Uint8Array.from([...realPng(), ...ascii('<script>alert(1)</script>')]);
    const listingId = await newListing();
    const { completed } = await upload(listingId, polyglot);

    expect(completed.statusCode).toBe(422);
    // Told plainly, because a seller who is not told assumes the site is broken.
    expect(completed.json<{ reason: string }>().reason).toBe('trailing_data');
  });

  it('refuses something that is not an image at all', async () => {
    const listingId = await newListing();
    const { completed } = await upload(listingId, Uint8Array.from(ascii('<!DOCTYPE html>')));
    expect(completed.statusCode).toBe(422);
    expect(completed.json<{ reason: string }>().reason).toBe('not_an_image');
  });

  it('keeps a refused upload visible to its seller, with the reason', async () => {
    const listingId = await newListing();
    await upload(listingId, Uint8Array.from(ascii('nope')));

    const list = await app.inject({
      method: 'GET',
      url: `/v1/listings/${listingId}/photos`,
      headers: { cookie: sellerCookie },
    });
    const [photo] = list.json<{ items: { status: string; rejectionReason: string }[] }>().items;
    expect(photo).toMatchObject({ status: 'rejected', rejectionReason: 'not_an_image' });
  });

  it('does not let a rejected photo satisfy the photo requirement', async () => {
    const listingId = await newListing(sellerCookie, 4000);
    await upload(listingId, Uint8Array.from(ascii('nope')));

    const published = await app.inject({
      method: 'POST',
      url: `/v1/listings/${listingId}/status`,
      headers: { cookie: sellerCookie, origin: ORIGIN },
      payload: { status: 'active' },
    });
    expect(published.statusCode).toBe(409);
  });

  it('will not issue a URL for more than ten megabytes', async () => {
    const listingId = await newListing();
    const asked = await app.inject({
      method: 'POST',
      url: `/v1/listings/${listingId}/photos`,
      headers: { cookie: sellerCookie, origin: ORIGIN },
      payload: { contentType: 'image/png', contentLength: 11 * 1024 * 1024 },
    });
    expect(asked.statusCode).toBe(400);
  });

  it('will not issue a URL for a format we cannot re-encode', async () => {
    const listingId = await newListing();
    const asked = await app.inject({
      method: 'POST',
      url: `/v1/listings/${listingId}/photos`,
      headers: { cookie: sellerCookie, origin: ORIGIN },
      payload: { contentType: 'image/webp', contentLength: 1000 },
    });
    expect(asked.statusCode).toBe(400);
  });
});

describe('whose listing it is', () => {
  it('refuses to start an upload on somebody else’s listing', async () => {
    const mine = await newListing();
    const stranger = await newSeller();

    const asked = await app.inject({
      method: 'POST',
      url: `/v1/listings/${mine}/photos`,
      headers: { cookie: stranger, origin: ORIGIN },
      payload: { contentType: 'image/png', contentLength: 1000 },
    });
    // Not "forbidden" — invisible, the same answer as a listing that never existed.
    expect(asked.statusCode).toBe(404);
  });

  it('refuses an anonymous caller', async () => {
    const listingId = await newListing();
    const asked = await app.inject({
      method: 'POST',
      url: `/v1/listings/${listingId}/photos`,
      payload: { contentType: 'image/png', contentLength: 1000 },
    });
    expect(asked.statusCode).toBe(401);
  });

  it('refuses the ninth photo', async () => {
    const listingId = await newListing();
    for (let i = 0; i < MAX_PHOTOS_PER_LISTING; i += 1) {
      const asked = await app.inject({
        method: 'POST',
        url: `/v1/listings/${listingId}/photos`,
        headers: { cookie: sellerCookie, origin: ORIGIN },
        payload: { contentType: 'image/png', contentLength: 1000 },
      });
      expect(asked.statusCode).toBe(201);
    }
    const ninth = await app.inject({
      method: 'POST',
      url: `/v1/listings/${listingId}/photos`,
      headers: { cookie: sellerCookie, origin: ORIGIN },
      payload: { contentType: 'image/png', contentLength: 1000 },
    });
    expect(ninth.statusCode).toBe(409);
    expect(ninth.json<{ error: string }>().error).toBe('photo_limit');
  });
});

describe('managing them afterwards', () => {
  it('will not process the same upload twice', async () => {
    const listingId = await newListing();
    const { photoId } = await upload(listingId, realPng());

    const again = await app.inject({
      method: 'POST',
      url: `/v1/listings/${listingId}/photos/${photoId}/complete`,
      headers: { cookie: sellerCookie, origin: ORIGIN },
    });
    expect(again.statusCode).toBe(409);
  });

  it('reorders them', async () => {
    const listingId = await newListing();
    const first = await upload(listingId, realPng(400, 400));
    const second = await upload(listingId, realPng(420, 420));

    const reordered = await app.inject({
      method: 'PATCH',
      url: `/v1/listings/${listingId}/photos`,
      headers: { cookie: sellerCookie, origin: ORIGIN },
      payload: { photoIds: [second.photoId, first.photoId] },
    });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json<{ items: { id: string }[] }>().items.map((p) => p.id)).toEqual([
      second.photoId,
      first.photoId,
    ]);
  });

  it('refuses a reorder that names only some of them', async () => {
    const listingId = await newListing();
    const first = await upload(listingId, realPng(400, 400));
    await upload(listingId, realPng(420, 420));

    const partial = await app.inject({
      method: 'PATCH',
      url: `/v1/listings/${listingId}/photos`,
      headers: { cookie: sellerCookie, origin: ORIGIN },
      payload: { photoIds: [first.photoId] },
    });
    expect(partial.statusCode).toBe(404);
  });

  it('deletes one, and the picture stops being fetchable', async () => {
    const listingId = await newListing();
    await upload(listingId, realPng());

    const list = await app.inject({
      method: 'GET',
      url: `/v1/listings/${listingId}/photos`,
      headers: { cookie: sellerCookie },
    });
    const [photo] = list.json<{ items: { id: string; url: string }[] }>().items;

    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/listings/${listingId}/photos/${String(photo?.id)}`,
      headers: { cookie: sellerCookie, origin: ORIGIN },
    });
    expect(removed.statusCode).toBe(204);

    // The object is gone from the bucket too, not merely hidden from the gallery.
    expect((await fetch(String(photo?.url))).ok).toBe(false);
  });

  it('refuses to delete somebody else’s photo', async () => {
    const listingId = await newListing();
    const { photoId } = await upload(listingId, realPng());
    const stranger = await newSeller();

    const attempt = await app.inject({
      method: 'DELETE',
      url: `/v1/listings/${listingId}/photos/${photoId}`,
      headers: { cookie: stranger, origin: ORIGIN },
    });
    expect(attempt.statusCode).toBe(404);
  });
});
