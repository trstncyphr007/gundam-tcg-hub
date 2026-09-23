-- The kill switches the incident runbook promises (plan §22).
--
-- `docs/runbooks/incident.md` has told an operator to turn off alert delivery or the public
-- API since it was written. Nothing implemented either, so the one document read under
-- pressure described controls that did not exist — the worst possible place for that.
--
-- Only overrides are stored. A missing row means the feature is on, so the table is empty in
-- normal operation and every switch fails **safe in the direction of working**: a database
-- that cannot be read, or a row that was never written, leaves the site up.
CREATE TABLE "app"."feature_flags" (
  "key" text PRIMARY KEY,
  "enabled" boolean NOT NULL,
  -- Why it was flipped. Required by the API, because "who turned this off and what for" is
  -- the first question asked the next morning.
  "reason" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" text
);
--> statement-breakpoint

-- Read by everything, written by the console. The public API reads on the read-only role, so
-- that role needs SELECT: a switch nobody can read is not a switch.
REVOKE ALL ON "app"."feature_flags" FROM PUBLIC, app_web, app_worker, app_readonly;
--> statement-breakpoint
GRANT SELECT ON "app"."feature_flags" TO app_web, app_worker, app_readonly;
--> statement-breakpoint
-- The admin console runs its writes on the worker pool (migration 0027), which is where the
-- moderation decisions go. Flipping a switch is the same kind of act: rare, audited, admin.
GRANT INSERT, UPDATE ON "app"."feature_flags" TO app_worker;
--> statement-breakpoint

-- Deliberately no DELETE for anyone. A switch is turned back on by setting it to true, which
-- leaves the row — and the reason, and who did it — behind. Removing the evidence that the
-- API was off for two hours is not an operation this system offers.
REVOKE DELETE ON "app"."feature_flags" FROM app_web, app_worker, app_readonly;
