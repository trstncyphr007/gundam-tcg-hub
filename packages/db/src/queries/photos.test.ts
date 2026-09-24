import { MAX_PHOTOS_PER_LISTING } from '@gth/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { seedSample } from '../seed/sample.js';
import { expectDbError } from '../test/expect.js';
import { type TestDatabase, startTestDatabase } from '../test/harness.js';
import { createListing, setListingStatus } from './market.js';
import {
  ListingNotYoursError,
  PhotoLimitError,
  PhotoNotFoundError,
  approvePhoto,
  countApprovedPhotos,
  deletePhoto,
  listPhotos,
  listingsSharingPhoto,
  pendingPhotos,
  rejectPhoto,
  reorderPhotos,
  startPhotoUpload,
} from './photos.js';
import { asUser } from './watches.js';

/**
 * Photographs of a card (FR-5.2, SR-5.5).
 *
 * The question, as everywhere else in Phase 5, is not what the routes refuse but **what a
 * session can do if it gets past every line of our code**. So the writes below are raw SQL on
 * the web pool with the seller declared, and what refuses them is Postgres.
 *
 * The one that matters most: a seller cannot mark their own upload `approved`. If they could,
 * an unscanned file would reach every buyer and the photo requirement above $25 would mean
 * nothing more than "did somebody send us bytes".
 */
let tdb: TestDatabase;
let webPool: ReturnType<typeof createDb>;
let workerPool: ReturnType<typeof createDb>;
let readonlyPool: ReturnType<typeof createDb>;
let web: TestDatabase['db'];
let workerDb: TestDatabase['db'];
let anonymous: TestDatabase['db'];

const SELLER = 'photo-seller';
const OTHER = 'photo-other';
let variantId = '';
let keyCounter = 0;

/** A digest that satisfies the hex CHECK without pretending to be of anything. */
function digest(seed: string): string {
  return seed
    .repeat(64)
    .slice(0, 64)
    .replace(/[^0-9a-f]/gu, 'a');
}

async function newListing(sellerId = SELLER, priceCents = 5000): Promise<string> {
  const listing = await createListing(web, sellerId, {
    cardVariantId: variantId,
    condition: 'nm',
    priceCents,
    quantity: 1,
  });
  return listing.id;
}

async function upload(listingId: string, sellerId = SELLER) {
  keyCounter += 1;
  return startPhotoUpload(web, sellerId, {
    listingId,
    uploadKey: `uploads/test-${String(keyCounter)}`,
    contentType: 'image/jpeg',
  });
}

/** Approve one the way the pipeline would, with facts the CHECK will accept. */
async function approve(photoId: string, sha = digest('1')) {
  return approvePhoto(workerDb, photoId, {
    objectKey: `photos/${photoId}.jpg`,
    width: 1200,
    height: 1600,
    sha256: sha,
    byteSize: 240_000,
    contentType: 'image/jpeg',
  });
}

/** A statement on the web pool as this user, with nothing of ours between it and Postgres. */
async function asWeb(userId: string, statement: string): Promise<unknown> {
  return asUser(web, userId, async (tx) => tx.execute(statement));
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await seedSample(tdb.db);
  webPool = createDb({ url: tdb.urlFor('web'), max: 4 });
  workerPool = createDb({ url: tdb.urlFor('worker'), max: 2 });
  readonlyPool = createDb({ url: tdb.urlFor('readonly'), max: 2 });
  web = webPool.db;
  workerDb = workerPool.db;
  anonymous = readonlyPool.db;

  for (const id of [SELLER, OTHER]) {
    await tdb.db.execute(
      `insert into app.users (id, name, email) values ('${id}', '${id}', '${id}@example.invalid')`,
    );
  }
  const [variant] = await tdb.db.execute<{ id: string }>(
    `select id from app.card_variants limit 1`,
  );
  variantId = String(variant?.id);
}, 180_000);

afterAll(async () => {
  await webPool.close();
  await workerPool.close();
  await readonlyPool.close();
  await tdb.close();
});

beforeEach(async () => {
  // TRUNCATE, not DELETE: these tables FORCE row-level security and a DELETE from the owner
  // matches nothing at all, silently.
  await tdb.db.execute(`truncate app.listing_photos, app.listings cascade`);
});

describe('starting an upload', () => {
  it('reserves a pending slot before any bytes exist', async () => {
    const listingId = await newListing();
    const photo = await upload(listingId);

    expect(photo.status).toBe('pending');
    expect(photo.position).toBe(0);
    // Nothing is known about the file yet, because there is no file yet.
    expect(photo.objectKey).toBeNull();
    expect(photo.sha256).toBeNull();
    expect(photo.scannedAt).toBeNull();
  });

  it('numbers them in the order they were started', async () => {
    const listingId = await newListing();
    await upload(listingId);
    const second = await upload(listingId);
    expect(second.position).toBe(1);
  });

  it('refuses a listing that is not yours', async () => {
    // Not "forbidden" — invisible. The policy filters the listing out, so this is the
    // ownership check and the existence check at once.
    const listingId = await newListing(SELLER);
    await expect(upload(listingId, OTHER)).rejects.toThrow(ListingNotYoursError);
  });

  it('refuses the ninth photo', async () => {
    const listingId = await newListing();
    for (let i = 0; i < MAX_PHOTOS_PER_LISTING; i += 1) await upload(listingId);
    await expect(upload(listingId)).rejects.toThrow(PhotoLimitError);
  });
});

describe('what a seller can do to their own photo', () => {
  it('cannot approve it', async () => {
    /**
     * The one that matters. A CHECK would not stop this and neither would the enum — `UPDATE
     * listing_photos SET status = 'approved'` is a perfectly well-formed statement. What
     * refuses it is having no privilege on the column.
     */
    const photo = await upload(await newListing());
    await expectDbError(
      asWeb(SELLER, `update app.listing_photos set status = 'approved' where id = '${photo.id}'`),
      /permission denied/i,
    );
  });

  it('cannot say what the file is', async () => {
    const photo = await upload(await newListing());
    for (const column of ['object_key', 'sha256', 'width', 'byte_size']) {
      await expectDbError(
        asWeb(
          SELLER,
          `update app.listing_photos set ${column} = ${column === 'width' || column === 'byte_size' ? '100' : `'x'`} where id = '${photo.id}'`,
        ),
        /permission denied/i,
      );
    }
  });

  it('cannot claim something looked at it', async () => {
    const photo = await upload(await newListing());
    await expectDbError(
      asWeb(SELLER, `update app.listing_photos set scanned_at = now() where id = '${photo.id}'`),
      /permission denied/i,
    );
  });

  it('can reorder them, which is the one thing it may write', async () => {
    const listingId = await newListing();
    const a = await upload(listingId);
    const b = await upload(listingId);

    const ordered = await reorderPhotos(web, SELLER, listingId, [b.id, a.id]);
    expect(ordered.map((p) => p.id)).toEqual([b.id, a.id]);
  });

  it('refuses a partial reorder rather than leaving two photos sharing a position', async () => {
    const listingId = await newListing();
    const a = await upload(listingId);
    await upload(listingId);
    await expect(reorderPhotos(web, SELLER, listingId, [a.id])).rejects.toThrow(PhotoNotFoundError);
  });

  it('can take it down in any state, without waiting for a scanner', async () => {
    const photo = await upload(await newListing());
    const removed = await deletePhoto(web, SELLER, photo.id);
    expect(removed.id).toBe(photo.id);
  });
});

describe('who can see what', () => {
  it('shows a seller their own pending and rejected uploads', async () => {
    const listingId = await newListing();
    const photo = await upload(listingId);
    await rejectPhoto(workerDb, photo.id, 'trailing_data');

    const mine = await listPhotos(web, SELLER, listingId);
    // A seller has to be told which upload was refused and why, or they will send it again.
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'rejected', rejectionReason: 'trailing_data' });
  });

  it('shows a stranger nothing until a photo is approved and the listing is on sale', async () => {
    const listingId = await newListing();
    const photo = await upload(listingId);
    await setListingStatus(web, SELLER, listingId, 'active');

    // Pending: a file nobody has inspected is not browsable while it waits.
    expect(await listPhotos(web, OTHER, listingId)).toHaveLength(0);

    await approve(photo.id);
    expect(await listPhotos(web, OTHER, listingId)).toHaveLength(1);
  });

  it('hides approved photos on a listing that is not for sale', async () => {
    const listingId = await newListing();
    const photo = await upload(listingId);
    await approve(photo.id);
    // Still a draft: the seller sees it, nobody else does.
    expect(await listPhotos(web, SELLER, listingId)).toHaveLength(1);
    expect(await listPhotos(web, OTHER, listingId)).toHaveLength(0);
  });

  it('never shows a rejected photo to anybody but its owner', async () => {
    const listingId = await newListing();
    const photo = await upload(listingId);
    await setListingStatus(web, SELLER, listingId, 'active');
    await rejectPhoto(workerDb, photo.id, 'not_an_image');

    expect(await listPhotos(web, OTHER, listingId)).toHaveLength(0);
  });

  it('shows the public API approved photos on active listings and nothing else', async () => {
    const listingId = await newListing();
    const approved = await upload(listingId);
    const pending = await upload(listingId);
    await approve(approved.id);
    await setListingStatus(web, SELLER, listingId, 'active');

    const rows = await anonymous.execute<{ id: string }>(`select id from app.listing_photos`);
    expect(rows.map((r) => r.id)).toEqual([approved.id]);
    expect(rows.map((r) => r.id)).not.toContain(pending.id);
  });
});

describe('counting what may be published', () => {
  it('counts approved photos only', async () => {
    /**
     * `canPublish` reads this number. Letting a pending upload satisfy the requirement above
     * $25 would turn the whole control into "did somebody send us bytes", which is not a
     * photograph of anything.
     */
    const listingId = await newListing();
    const a = await upload(listingId);
    await upload(listingId);
    expect(await countApprovedPhotos(web, SELLER, listingId)).toBe(0);

    await approve(a.id);
    expect(await countApprovedPhotos(web, SELLER, listingId)).toBe(1);
  });
});

describe('the pipeline, on the role it runs as', () => {
  it('finds uploads nobody has looked at', async () => {
    const photo = await upload(await newListing());
    const waiting = await pendingPhotos(workerDb);
    expect(waiting.map((p) => p.id)).toContain(photo.id);
  });

  it('records what it found', async () => {
    const photo = await upload(await newListing());
    const approved = await approve(photo.id, digest('b'));

    expect(approved).toMatchObject({ status: 'approved', width: 1200, height: 1600 });
    expect(approved?.objectKey).toBe(`photos/${photo.id}.jpg`);
    expect(approved?.scannedAt).not.toBeNull();
  });

  it('will not approve one twice', async () => {
    // The guard against a pipeline that runs the same upload again after a restart, which
    // would otherwise overwrite an object key that something is already serving.
    const photo = await upload(await newListing());
    await approve(photo.id);
    expect(await approve(photo.id)).toBeNull();
  });

  it('cannot call something approved without having anything to serve', async () => {
    // `listing_photos_approved_is_complete`. Without it, `approved` with a null object key is
    // a row the gallery renders as a broken image.
    const photo = await upload(await newListing());
    await expectDbError(
      workerDb.execute(
        `update app.listing_photos set status = 'approved' where id = '${photo.id}'`,
      ),
      /listing_photos_approved_is_complete/,
    );
  });

  it('cannot refuse something without saying why', async () => {
    const photo = await upload(await newListing());
    await expectDbError(
      workerDb.execute(
        `update app.listing_photos set status = 'rejected' where id = '${photo.id}'`,
      ),
      /listing_photos_rejected_has_reason/,
    );
  });

  it('refuses a digest that is not one', async () => {
    const photo = await upload(await newListing());
    await expectDbError(
      workerDb.execute(
        `update app.listing_photos set sha256 = 'not-a-digest' where id = '${photo.id}'`,
      ),
      /listing_photos_sha256_hex/,
    );
  });
});

describe('the same photograph on two listings (SR-5.6)', () => {
  it('reports the other listing rather than refusing the upload', async () => {
    /**
     * A report, not a refusal. Refusing would let anybody lock a photograph out of the
     * marketplace by uploading it first — a worse problem than the one it solves, and one with
     * no way for the real owner to appeal.
     */
    const mine = await newListing();
    const theirs = await newListing(OTHER);
    const shared = digest('c');

    const a = await upload(mine);
    const b = await upload(theirs, OTHER);
    await approve(a.id, shared);
    await approve(b.id, shared);

    expect(await listingsSharingPhoto(workerDb, shared, mine)).toEqual([theirs]);
  });

  it('says nothing about a photograph only one listing has', async () => {
    const mine = await newListing();
    const photo = await upload(mine);
    const unique = digest('d');
    await approve(photo.id, unique);

    expect(await listingsSharingPhoto(workerDb, unique, mine)).toEqual([]);
  });
});
