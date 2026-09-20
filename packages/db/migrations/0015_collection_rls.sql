-- Row-level security and least privilege for collections (SR-3.3, SR-3.8, SR-X.8, threat T4).
--
-- A collection is the most personal thing in the database: it is a list of what someone owns
-- and what they paid for it. So the default is private, and the policies below are the
-- second lock on that -- `authorize()` in the app is the first, and neither is trusted to be
-- the only one.
--
-- FORCE, unlike `price_observations`: there is no admin or job path that legitimately writes
-- another person's collection. Anything that touches these rows acts as a user, including
-- the CSV import. (A consequence worth knowing: `delete from app.collections` as the table
-- owner removes nothing, because the owner is policied too. Test cleanup has to declare a
-- user, the same as everything else.)
ALTER TABLE "app"."collections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."collections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."collection_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."collection_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The owner sees their own collections whatever the visibility; everyone else sees the ones
-- that are not private. current_setting(..., true) is NULL when unset, and NULL = owner_id
-- is never true, so a connection with no declared user sees shared collections only.
--
-- Note what this policy does *not* decide: `unlisted` rows are readable here, exactly like
-- public ones, because RLS can only answer "may this row be returned", not "did the caller
-- already know the id". Discoverability is a property of the query, so the listing query
-- filters `visibility = 'public'` and the by-id query does not. Both are in
-- queries/collections.ts, and both have tests -- an unlisted collection appearing in a
-- listing would be a leak this layer cannot catch.
CREATE POLICY collections_select_own_or_shared ON "app"."collections"
  FOR SELECT
  USING (owner_id = current_setting('app.user_id', true) OR visibility <> 'private');
--> statement-breakpoint

-- A forged owner_id in the payload fails here, not in application code.
CREATE POLICY collections_insert_own ON "app"."collections"
  FOR INSERT
  WITH CHECK (owner_id = current_setting('app.user_id', true));
--> statement-breakpoint
-- USING and WITH CHECK both: USING decides which rows may be updated, WITH CHECK decides
-- what they may become. Without the second, an owner could hand their collection to someone
-- else by writing a new owner_id -- which is a way of losing a row, not sharing one.
CREATE POLICY collections_update_own ON "app"."collections"
  FOR UPDATE
  USING (owner_id = current_setting('app.user_id', true))
  WITH CHECK (owner_id = current_setting('app.user_id', true));
--> statement-breakpoint
CREATE POLICY collections_delete_own ON "app"."collections"
  FOR DELETE
  USING (owner_id = current_setting('app.user_id', true));
--> statement-breakpoint

-- Items inherit their collection's visibility. The EXISTS re-enters `collections`, which is
-- itself policied, so a visible item is exactly an item in a visible collection: there is
-- one rule, written once.
CREATE POLICY collection_items_select_visible ON "app"."collection_items"
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM "app"."collections" c WHERE c.id = collection_id));
--> statement-breakpoint

-- Writes are narrower than reads, and deliberately do not lean on the SELECT policy: a
-- public collection is readable by everyone, so "can see it" must not imply "can add to it".
-- Hence the explicit owner check rather than a bare EXISTS.
CREATE POLICY collection_items_insert_own ON "app"."collection_items"
  FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM "app"."collections" c
     WHERE c.id = collection_id
       AND c.owner_id = current_setting('app.user_id', true)
  ));
--> statement-breakpoint
CREATE POLICY collection_items_update_own ON "app"."collection_items"
  FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM "app"."collections" c
     WHERE c.id = collection_id
       AND c.owner_id = current_setting('app.user_id', true)
  ))
  -- Re-checked after the update, so an item cannot be moved into someone else's collection.
  WITH CHECK (EXISTS (
    SELECT 1 FROM "app"."collections" c
     WHERE c.id = collection_id
       AND c.owner_id = current_setting('app.user_id', true)
  ));
--> statement-breakpoint
CREATE POLICY collection_items_delete_own ON "app"."collection_items"
  FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM "app"."collections" c
     WHERE c.id = collection_id
       AND c.owner_id = current_setting('app.user_id', true)
  ));
--> statement-breakpoint

-- Collections are a web-tier concern entirely. The scanner and alert worker have no reason
-- to read what anyone owns, and saying so here costs nothing today and a lot later.
REVOKE ALL ON "app"."collections", "app"."collection_items" FROM app_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "app"."collections", "app"."collection_items" TO app_web;
--> statement-breakpoint
-- The public API serves shared collection pages through the read-only role. It is still
-- subject to the SELECT policy above, so "read-only" does not mean "reads everything".
GRANT SELECT ON "app"."collections", "app"."collection_items" TO app_readonly;
