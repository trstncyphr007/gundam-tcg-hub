-- A seller cannot mark their own listing sold.
--
-- Found by a test in the slice that introduced it, which is the good version of this story.
-- `setListingStatus` accepts `'draft' | 'active' | 'withdrawn'` and TypeScript refused `'sold'`
-- — and at runtime the update went straight through, because the type was the only thing
-- saying no. The row-level policy permitted any status the enum allows.
--
-- That is the same shape as an order's `paid`: a rule that exists in the type system and
-- nowhere the running system can feel it. A listing becomes `sold` because an order was paid
-- for, which happens on the worker after a verified webhook, and a seller asserting it about
-- their own listing is asserting a sale that may not have happened.
--
-- The WITH CHECK below also has a second effect, and it is wanted: once a listing is sold, its
-- seller cannot edit it at all, because any update would have to leave `status = 'sold'` and
-- the check refuses that. A sold listing is what somebody bought. It is history, like the
-- order that froze a copy of it.
--
-- The worker's policy is unchanged and still allows everything, which is how `sold` is ever
-- written.
DROP POLICY listings_update_own ON "app"."listings";--> statement-breakpoint

CREATE POLICY listings_update_own ON "app"."listings"
  FOR UPDATE TO app_web
  USING (seller_id = current_setting('app.user_id', true))
  WITH CHECK (
    seller_id = current_setting('app.user_id', true)
    AND status <> 'sold'
  );
