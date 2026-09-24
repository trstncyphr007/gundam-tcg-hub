-- Listing photos (Phase 5, slice 4; FR-5.2, SR-5.5, T10).
--
-- The table, and the rule that a seller uploads bytes and asserts nothing about them.
--
-- ## What a session may write, and what it may not
--
-- A seller may say "I am going to upload a file, here is where it will land". That is the whole
-- of it. Everything else on the row is a **finding** rather than a claim:
--
--   status, rejection_reason, object_key, width, height, sha256, byte_size, scanned_at
--
-- Those are established by the pipeline, from the bytes, on the worker role. A session cannot
-- write any of them, for the same reason it cannot write an order's `paid`: a party with an
-- interest in the answer does not get to supply it. A seller who could set `status = 'approved'`
-- could put an unscanned file in front of every buyer, and the photo requirement above $25
-- would mean nothing at all.
--
-- The column-level grants below are what make that true. The status enum and the CHECKs would
-- not: `UPDATE listing_photos SET status = 'approved'` is a perfectly well-formed statement,
-- and the only thing that refuses it is having no privilege on the column.
--
-- ## Note for the next person
--
-- A hand-written migration does nothing until it has an entry in `meta/_journal.json`. The
-- runner reads the journal, not the directory. 0043 was added without one and the whole suite
-- ran against a database where none of its grants existed. Add the entry in the same commit.

CREATE TYPE "app"."photo_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint

CREATE TABLE "app"."listing_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"upload_key" text NOT NULL,
	"object_key" text,
	"status" "app"."photo_status" DEFAULT 'pending' NOT NULL,
	"rejection_reason" text,
	"content_type" text,
	"byte_size" integer,
	"width" integer,
	"height" integer,
	"sha256" text,
	"scanned_at" timestamp with time zone,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_photos_approved_is_complete" CHECK ("app"."listing_photos"."status" <> 'approved'
          or ("app"."listing_photos"."object_key" is not null and "app"."listing_photos"."width" is not null and "app"."listing_photos"."height" is not null
              and "app"."listing_photos"."sha256" is not null and "app"."listing_photos"."scanned_at" is not null)),
	CONSTRAINT "listing_photos_rejected_has_reason" CHECK ("app"."listing_photos"."status" <> 'rejected' or "app"."listing_photos"."rejection_reason" is not null),
	CONSTRAINT "listing_photos_dimensions_sane" CHECK (("app"."listing_photos"."width" is null or ("app"."listing_photos"."width" > 0 and "app"."listing_photos"."width" <= 8000))
          and ("app"."listing_photos"."height" is null or ("app"."listing_photos"."height" > 0 and "app"."listing_photos"."height" <= 8000))),
	CONSTRAINT "listing_photos_size_sane" CHECK ("app"."listing_photos"."byte_size" is null or ("app"."listing_photos"."byte_size" > 0 and "app"."listing_photos"."byte_size" <= 10485760)),
	CONSTRAINT "listing_photos_position_sane" CHECK ("app"."listing_photos"."position" >= 0 and "app"."listing_photos"."position" < 8),
	CONSTRAINT "listing_photos_sha256_hex" CHECK ("app"."listing_photos"."sha256" is null or "app"."listing_photos"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "app"."listing_photos" ADD CONSTRAINT "listing_photos_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "app"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listing_photos_listing_idx" ON "app"."listing_photos" USING btree ("listing_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_photos_upload_key" ON "app"."listing_photos" USING btree ("upload_key");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_photos_object_key" ON "app"."listing_photos" USING btree ("object_key") WHERE "app"."listing_photos"."object_key" is not null;--> statement-breakpoint
CREATE INDEX "listing_photos_sha256_idx" ON "app"."listing_photos" USING btree ("sha256") WHERE "app"."listing_photos"."sha256" is not null;--> statement-breakpoint

ALTER TABLE "app"."listing_photos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."listing_photos" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- A seller sees every photo on their own listing, whatever state it is in, because they need to
-- be told which one was refused and why. Everybody else sees approved photos on listings that
-- are actually for sale -- and only those, so a pending upload is not browsable while it waits
-- and a rejected one is never visible to anyone but its owner.
CREATE POLICY listing_photos_select ON "app"."listing_photos"
  FOR SELECT TO app_web
  USING (
    EXISTS (
      SELECT 1 FROM "app"."listings" l
       WHERE l.id = listing_id
         AND (l.seller_id = current_setting('app.user_id', true)
              OR (l.status = 'active' AND "listing_photos".status = 'approved'))
    )
  );--> statement-breakpoint

-- The public API has no session, so it sees what a stranger may see and nothing else.
CREATE POLICY listing_photos_select_public ON "app"."listing_photos"
  FOR SELECT TO app_readonly
  USING (
    status = 'approved'
    AND EXISTS (SELECT 1 FROM "app"."listings" l WHERE l.id = listing_id AND l.status = 'active')
  );--> statement-breakpoint

-- Starting an upload, on a listing you own. `pending` only: a photo cannot be born approved.
CREATE POLICY listing_photos_insert_own ON "app"."listing_photos"
  FOR INSERT TO app_web
  WITH CHECK (
    status = 'pending'
    AND EXISTS (
      SELECT 1 FROM "app"."listings" l
       WHERE l.id = listing_id AND l.seller_id = current_setting('app.user_id', true)
    )
  );--> statement-breakpoint

-- Reordering. The WITH CHECK repeats the ownership test because USING decides which rows may
-- change and WITH CHECK decides what they may become -- without it a seller could move a photo
-- onto somebody else's listing.
CREATE POLICY listing_photos_update_own ON "app"."listing_photos"
  FOR UPDATE TO app_web
  USING (
    EXISTS (
      SELECT 1 FROM "app"."listings" l
       WHERE l.id = listing_id AND l.seller_id = current_setting('app.user_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "app"."listings" l
       WHERE l.id = listing_id AND l.seller_id = current_setting('app.user_id', true)
    )
  );--> statement-breakpoint

-- Removing your own photo. Allowed in any state: a seller who uploaded the wrong picture
-- should not have to wait for a scanner to finish before taking it down.
CREATE POLICY listing_photos_delete_own ON "app"."listing_photos"
  FOR DELETE TO app_web
  USING (
    EXISTS (
      SELECT 1 FROM "app"."listings" l
       WHERE l.id = listing_id AND l.seller_id = current_setting('app.user_id', true)
    )
  );--> statement-breakpoint

REVOKE ALL ON "app"."listing_photos" FROM PUBLIC, app_web, app_worker, app_readonly;--> statement-breakpoint
GRANT SELECT, DELETE ON "app"."listing_photos" TO app_web;--> statement-breakpoint

-- Column-level, and this is the control. A seller declares where a file will land and where it
-- belongs in the order; every finding about the bytes is outside the grant.
GRANT INSERT (listing_id, upload_key, content_type, position)
  ON "app"."listing_photos" TO app_web;--> statement-breakpoint
-- Reordering only. Not `status`, which is how an unscanned file would reach a buyer.
GRANT UPDATE (position, updated_at) ON "app"."listing_photos" TO app_web;--> statement-breakpoint

GRANT SELECT ON "app"."listing_photos" TO app_readonly;--> statement-breakpoint

-- The pipeline. It reads the bytes, forms an opinion, and is the only thing that can record one.
GRANT SELECT, INSERT, UPDATE, DELETE ON "app"."listing_photos" TO app_worker;--> statement-breakpoint
CREATE POLICY listing_photos_worker ON "app"."listing_photos"
  FOR ALL TO app_worker
  USING (true) WITH CHECK (true);
