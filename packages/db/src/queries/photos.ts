import { MAX_PHOTOS_PER_LISTING } from '@gth/core';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { listingPhotos, listings } from '../schema/market.js';
import { asUser } from './watches.js';

/**
 * Photographs of the actual card (FR-5.2, SR-5.5).
 *
 * Split by role, the same way orders are, and for the same reason.
 *
 * **The seller's half** runs on `app_web`: start an upload, list what is on a listing, reorder,
 * remove. It can say where a file will land and nothing about what the file is.
 *
 * **The pipeline's half** runs on `app_worker`: read the bytes, decide, record. Migration 0044
 * puts `status`, `object_key`, `sha256`, the dimensions and `scanned_at` outside the web role's
 * grant, so `approved` is not a state a session fails to reach — it is one a session cannot
 * spell.
 */

export type PhotoStatus = 'pending' | 'approved' | 'rejected';

export interface ListingPhoto {
  id: string;
  listingId: string;
  uploadKey: string;
  objectKey: string | null;
  status: PhotoStatus;
  rejectionReason: string | null;
  contentType: string | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  sha256: string | null;
  scannedAt: Date | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

export class PhotoLimitError extends Error {
  constructor() {
    super(`a listing may carry ${String(MAX_PHOTOS_PER_LISTING)} photos`);
    this.name = 'PhotoLimitError';
  }
}

export class PhotoNotFoundError extends Error {
  constructor() {
    super('no such photo');
    this.name = 'PhotoNotFoundError';
  }
}

/** Raised when the listing named is not this seller's, or is not there. */
export class ListingNotYoursError extends Error {
  constructor() {
    super('no such listing');
    this.name = 'ListingNotYoursError';
  }
}

/**
 * Reserve a slot for a file that has not been uploaded yet.
 *
 * Written before the bytes exist, on purpose: the row is what the presigned PUT is *for*, and
 * an upload with no row is a file in a bucket nothing will ever look at or clean up.
 *
 * The count and the insert share a transaction, so two requests racing cannot both see seven
 * photos and both add one. The limit is not a CHECK because a CHECK cannot count rows — which
 * means this is the only thing enforcing it, and is why it is here rather than in a route.
 */
export async function startPhotoUpload(
  db: Database,
  sellerId: string,
  input: { listingId: string; uploadKey: string; contentType: string },
): Promise<ListingPhoto> {
  return asUser(db, sellerId, async (tx) => {
    // Read through the policies rather than trusting the caller: a listing that is not this
    // seller's is invisible here, so this is the ownership check as well as the existence one.
    const [listing] = await tx
      .select({ id: listings.id })
      .from(listings)
      .where(and(eq(listings.id, input.listingId), eq(listings.sellerId, sellerId)))
      .limit(1);
    if (!listing) throw new ListingNotYoursError();

    const existing = await tx
      .select({ position: listingPhotos.position })
      .from(listingPhotos)
      .where(eq(listingPhotos.listingId, input.listingId));
    if (existing.length >= MAX_PHOTOS_PER_LISTING) throw new PhotoLimitError();

    const position = existing.length;

    /**
     * Written out, rather than through the query builder, because of the grant.
     *
     * Drizzle names every column in an INSERT including the ones it is only letting default,
     * so a statement mentioning `status` is refused outright by a role with no privilege on
     * `status`. The same reason `createOrder` and `recordSellerAccount` are written out.
     */
    const rows = await tx.execute<{ id: string }>(sql`
      insert into app.listing_photos (listing_id, upload_key, content_type, position)
      values (${input.listingId}, ${input.uploadKey}, ${input.contentType}, ${position})
      returning id
    `);
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('photo insert returned nothing');

    const [photo] = await tx.select().from(listingPhotos).where(eq(listingPhotos.id, id)).limit(1);
    if (!photo) throw new Error('photo vanished between insert and read');
    return photo;
  });
}

/** Everything on this listing that this viewer may see. The policy decides which that is. */
export async function listPhotos(
  db: Database,
  viewerId: string,
  listingId: string,
): Promise<ListingPhoto[]> {
  return asUser(db, viewerId, async (tx) =>
    tx
      .select()
      .from(listingPhotos)
      .where(eq(listingPhotos.listingId, listingId))
      .orderBy(listingPhotos.position),
  );
}

/**
 * How many approved photos a listing has.
 *
 * What `canPublish` needs, and it counts **approved** only. A pending upload is a file nobody
 * has inspected, and letting one satisfy the requirement above $25 would turn the whole
 * control into "did somebody send us bytes".
 */
export async function countApprovedPhotos(
  db: Database,
  viewerId: string,
  listingId: string,
): Promise<number> {
  return asUser(db, viewerId, async (tx) => {
    const rows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(listingPhotos)
      .where(and(eq(listingPhotos.listingId, listingId), eq(listingPhotos.status, 'approved')));
    return rows[0]?.n ?? 0;
  });
}

/** Take a photo down. Allowed in any state — a wrong picture should not need a scanner first. */
export async function deletePhoto(
  db: Database,
  sellerId: string,
  photoId: string,
): Promise<ListingPhoto> {
  return asUser(db, sellerId, async (tx) => {
    const rows = await tx.delete(listingPhotos).where(eq(listingPhotos.id, photoId)).returning();
    const row = rows[0];
    // Somebody else's photo and a photo that never existed answer the same way: the policy
    // filtered it out, so there was nothing to delete either way.
    if (!row) throw new PhotoNotFoundError();
    return row;
  });
}

/** Put them in a chosen order. Positions are rewritten wholesale rather than swapped. */
export async function reorderPhotos(
  db: Database,
  sellerId: string,
  listingId: string,
  photoIds: string[],
): Promise<ListingPhoto[]> {
  return asUser(db, sellerId, async (tx) => {
    const current = await tx
      .select({ id: listingPhotos.id })
      .from(listingPhotos)
      .where(eq(listingPhotos.listingId, listingId));

    // Every photo, each exactly once. A partial order would leave two photos sharing a
    // position, and the gallery would then depend on whatever the planner felt like.
    const known = new Set(current.map((row) => row.id));
    const wanted = new Set(photoIds);
    if (wanted.size !== photoIds.length || wanted.size !== known.size) {
      throw new PhotoNotFoundError();
    }
    for (const id of photoIds) if (!known.has(id)) throw new PhotoNotFoundError();

    for (const [position, id] of photoIds.entries()) {
      await tx
        .update(listingPhotos)
        .set({ position, updatedAt: new Date() })
        .where(eq(listingPhotos.id, id));
    }

    return tx
      .select()
      .from(listingPhotos)
      .where(eq(listingPhotos.listingId, listingId))
      .orderBy(listingPhotos.position);
  });
}

/* ------------------------------------------------------------------------------------------ *
 * The pipeline's half. Worker role only.
 * ------------------------------------------------------------------------------------------ */

/** Uploads nobody has looked at yet, oldest first. What the pipeline asks for. */
export async function pendingPhotos(db: Database, limit = 20): Promise<ListingPhoto[]> {
  return db
    .select()
    .from(listingPhotos)
    .where(eq(listingPhotos.status, 'pending'))
    .orderBy(listingPhotos.createdAt)
    .limit(limit);
}

export interface ApprovedPhotoFacts {
  objectKey: string;
  width: number;
  height: number;
  sha256: string;
  byteSize: number;
  contentType: string;
}

/**
 * The bytes were read, re-encoded and found acceptable.
 *
 * Worker role only. `scanned_at` is set here and nowhere else, so "nothing has looked at this"
 * stays a state the database can distinguish from "something looked and was happy".
 */
export async function approvePhoto(
  db: Database,
  photoId: string,
  facts: ApprovedPhotoFacts,
): Promise<ListingPhoto | null> {
  const rows = await db
    .update(listingPhotos)
    .set({
      status: 'approved',
      objectKey: facts.objectKey,
      width: facts.width,
      height: facts.height,
      sha256: facts.sha256,
      byteSize: facts.byteSize,
      contentType: facts.contentType,
      rejectionReason: null,
      scannedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(listingPhotos.id, photoId), ne(listingPhotos.status, 'approved')))
    .returning();
  return rows[0] ?? null;
}

/**
 * The bytes were read and refused.
 *
 * The row stays. A seller whose upload vanished with no explanation assumes the site is broken,
 * and a rejection nobody recorded is one nobody can count when asking whether the rules are too
 * strict.
 */
export async function rejectPhoto(
  db: Database,
  photoId: string,
  reason: string,
): Promise<ListingPhoto | null> {
  const rows = await db
    .update(listingPhotos)
    .set({
      status: 'rejected',
      rejectionReason: reason,
      objectKey: null,
      scannedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(listingPhotos.id, photoId))
    .returning();
  return rows[0] ?? null;
}

/**
 * Other listings carrying a byte-identical photo (SR-5.6).
 *
 * The cheap half of the stolen-photo question. Two sellers photographing the same card get
 * different bytes; the same digest on two listings is the same file, which usually means one of
 * them took it from the other's page.
 *
 * It reports rather than refuses. Refusing would let anybody lock a photograph out of the
 * marketplace by uploading it first, which is a worse problem than the one it solves.
 */
export async function listingsSharingPhoto(
  db: Database,
  sha256: string,
  exceptListingId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ listingId: listingPhotos.listingId })
    .from(listingPhotos)
    .where(and(eq(listingPhotos.sha256, sha256), ne(listingPhotos.listingId, exceptListingId)));
  return rows.map((row) => row.listingId);
}
