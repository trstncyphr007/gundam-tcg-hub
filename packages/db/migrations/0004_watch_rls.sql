-- Row-level security on user-owned data (SR-X.8, threat T4).
-- Defence in depth: even if an application bug forgets a WHERE clause, Postgres still
-- restricts every row to its owner. The acting user is declared per transaction by
-- asUser() via set_config('app.user_id', ..., true).
ALTER TABLE "app"."watch_subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- FORCE so the table owner (app_migrator) is subject to the policies too.
ALTER TABLE "app"."watch_subscriptions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Readable only by the owner. current_setting(..., true) returns NULL when unset,
-- and NULL = user_id is never true, so an un-scoped connection sees nothing.
CREATE POLICY watch_subscriptions_select_own ON "app"."watch_subscriptions"
  FOR SELECT
  USING (user_id = current_setting('app.user_id', true));
--> statement-breakpoint
-- Rows may only be created for the acting user: a forged user_id in the payload fails here.
CREATE POLICY watch_subscriptions_insert_own ON "app"."watch_subscriptions"
  FOR INSERT
  WITH CHECK (user_id = current_setting('app.user_id', true));
--> statement-breakpoint
CREATE POLICY watch_subscriptions_update_own ON "app"."watch_subscriptions"
  FOR UPDATE
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));
--> statement-breakpoint
CREATE POLICY watch_subscriptions_delete_own ON "app"."watch_subscriptions"
  FOR DELETE
  USING (user_id = current_setting('app.user_id', true));
--> statement-breakpoint
-- The worker reads every watch to fan out alerts; it never edits them.
CREATE POLICY watch_subscriptions_worker_read ON "app"."watch_subscriptions"
  FOR SELECT
  TO app_worker
  USING (true);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "app"."watch_subscriptions" FROM app_worker;
