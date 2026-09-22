-- Known sign-in devices: owned rows, and a history that cannot be rewritten (ADR-026).
--
-- The table decides whether a sign-in is "from somewhere new", which decides whether the
-- owner gets an email. So the thing to protect is the *history*: a device row that could be
-- inserted ahead of time, or quietly deleted, would let someone suppress the one notice that
-- tells the owner they are there.
--
-- Hence: the web role may add a device and bump its last-seen time, and nothing else. No
-- DELETE, no rewriting a device name or a first-seen date. Rows go when the account goes, by
-- the foreign key's cascade.
ALTER TABLE "app"."sign_in_devices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."sign_in_devices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY sign_in_devices_select_own ON "app"."sign_in_devices"
  FOR SELECT
  USING (user_id = current_setting('app.user_id', true));
--> statement-breakpoint

-- A device can only be recorded against the account the transaction declared.
CREATE POLICY sign_in_devices_insert_own ON "app"."sign_in_devices"
  FOR INSERT
  WITH CHECK (user_id = current_setting('app.user_id', true));
--> statement-breakpoint

CREATE POLICY sign_in_devices_update_own ON "app"."sign_in_devices"
  FOR UPDATE
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));
--> statement-breakpoint

REVOKE ALL ON "app"."sign_in_devices" FROM app_web, app_worker, app_readonly;
--> statement-breakpoint
GRANT SELECT, INSERT ON "app"."sign_in_devices" TO app_web;
--> statement-breakpoint
-- The one column that is allowed to move.
GRANT UPDATE (last_seen_at) ON "app"."sign_in_devices" TO app_web;
