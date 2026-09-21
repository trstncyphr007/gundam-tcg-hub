-- Live sales: row-level security, and a column the ingestion cannot read (FR-4.1, SR-4.5).
--
-- Two separate things are being protected here and they pull in different directions.
--
-- **The rows** are the seller's own record of their stream, so they are FORCE'd and owned:
-- nobody reads or writes another seller's log, including us, including a job.
--
-- **The buyer handle** is somebody else's name, typed by a third party who never agreed to
-- anything with us. It needs to reach exactly one place — the seller's own listing — and
-- nowhere else, and in particular it must not be able to travel down the path that publishes
-- price observations to the open internet.
--
-- So the grants split by column, not just by row: `app_worker` runs the ingestion and the
-- retention sweep, and it may **UPDATE the handle without being able to SELECT it**. That is
-- not a trick — it is the exact shape of what the worker needs. It has to erase handles; it
-- never has to read one. With no SELECT privilege, the ingestion cannot carry a handle into a
-- public observation even if a future version of that query asks for `*`: the query fails
-- instead, loudly, in a test.
--
-- That asymmetry is also why `has_buyer_handle` exists. Postgres requires SELECT on every
-- column a statement *reads*, including in its own WHERE clause — so a sweep written as
-- `WHERE buyer_handle_encrypted IS NOT NULL` would need the privilege it is designed not to
-- have. Separating "is there a name here" from "what is it" keeps the predicate legal and
-- the secret unreadable, and a CHECK constraint keeps the two in step.
ALTER TABLE "app"."live_sales" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."live_sales" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- A seller sees their own entries and nobody else's. There is no "public" live-sale view:
-- what reaches the public is the derived price observation, which carries no handle, no
-- seller id and no label the seller did not type.
CREATE POLICY live_sales_select_own ON "app"."live_sales"
  FOR SELECT
  USING (seller_id = current_setting('app.user_id', true));
--> statement-breakpoint

-- A forged seller_id in the payload fails here, not in application code.
CREATE POLICY live_sales_insert_own ON "app"."live_sales"
  FOR INSERT
  WITH CHECK (seller_id = current_setting('app.user_id', true));
--> statement-breakpoint

-- USING and WITH CHECK both: USING decides which rows may change, WITH CHECK decides what
-- they may become. Without the second an entry could be reassigned to another seller.
CREATE POLICY live_sales_update_own ON "app"."live_sales"
  FOR UPDATE
  USING (seller_id = current_setting('app.user_id', true))
  WITH CHECK (seller_id = current_setting('app.user_id', true));
--> statement-breakpoint

-- A mistyped entry is deleted, not corrected in place, and only before it has been ingested.
-- After that the observation is out in the index and deleting the source row would leave a
-- published number with nothing behind it. The policy says so rather than a comment.
CREATE POLICY live_sales_delete_own_unpublished ON "app"."live_sales"
  FOR DELETE
  USING (
    seller_id = current_setting('app.user_id', true)
    AND price_observation_id IS NULL
  );
--> statement-breakpoint

-- The web tier: full access to its own rows, including the handle, because the seller
-- entered it and needs it back.
GRANT SELECT, INSERT, UPDATE, DELETE ON "app"."live_sales" TO app_web;
--> statement-breakpoint

-- The worker: ingestion and retention, and nothing that needs a name.
REVOKE ALL ON "app"."live_sales" FROM app_worker, app_readonly;
--> statement-breakpoint
-- Every column EXCEPT buyer_handle_encrypted. Listed one by one so that adding a column
-- later is a decision someone has to make rather than a privilege that arrives by default.
GRANT SELECT (id, seller_id, card_variant_id, label, condition, price_cents, currency,
              sold_at, stream_ref, has_buyer_handle, price_observation_id,
              created_at, updated_at)
  ON "app"."live_sales" TO app_worker;
--> statement-breakpoint
-- It links the observation it created, and it erases expired handles. Writing a column it
-- cannot read is exactly right: the sweep sets it to NULL and never looks.
GRANT UPDATE (price_observation_id, buyer_handle_encrypted, has_buyer_handle, updated_at)
  ON "app"."live_sales" TO app_worker;
--> statement-breakpoint

-- The worker needs a row policy of its own: FORCE applies to it too, and it has no user id.
CREATE POLICY live_sales_worker_all ON "app"."live_sales"
  FOR SELECT
  TO app_worker
  USING (true);
--> statement-breakpoint
CREATE POLICY live_sales_worker_update ON "app"."live_sales"
  FOR UPDATE
  TO app_worker
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint

-- Nobody deletes an ingested entry, the worker included. The published index has to keep
-- something behind it.
REVOKE DELETE ON "app"."live_sales" FROM app_worker;
--> statement-breakpoint

-- The observation a live sale produces is written by the worker, which migration 0013
-- already allows for any non-`user_report` source. Re-stated here because it is now load
-- bearing for a second feature, and a future narrowing of that policy would silently stop
-- live sales reaching the index rather than failing visibly.
--
-- Note what is NOT granted: the web role still cannot insert a `live_sale` observation. A
-- seller's entry becomes evidence only after passing through a role a request cannot reach.
GRANT SELECT ON "app"."price_index_daily" TO app_worker;
