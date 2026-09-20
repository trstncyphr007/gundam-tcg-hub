-- Row-level security and least privilege for the price index (SR-3.5, SR-X.8).
--
-- The threat here points the other way from the rest of the system. Nothing about a card
-- price is confidential; the risk is someone moving the published number by asserting
-- prices (threat T7). So these rules are about who may WRITE, and about what counts.
--
-- Note the deliberate difference from watches and breaks: RLS is ENABLED but **not FORCED**.
-- FORCE would apply policies to the table owner too, and the owner is the admin/job path --
-- the moderation CLI and the break-pull ingestion, both of which legitimately write rows
-- that no session may write. Forcing it there would not add protection, it would just mean
-- no trusted source could ever be recorded. The control that matters is the policy on the
-- web role, which is what a request actually runs as.
ALTER TABLE "app"."price_observations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Anyone may read observations: the index is published, and so is its evidence. Publishing
-- an output while hiding its inputs is how a price benchmark loses the right to be believed.
CREATE POLICY price_observations_select_all ON "app"."price_observations"
  FOR SELECT
  USING (true);
--> statement-breakpoint

-- A session may only file a report as itself, and only as a `user_report`.
--
-- This is the important rule: the sources we weight most heavily -- our own break logs and
-- live sales -- are **not reachable from a session at all**. A compromised web process
-- cannot claim its number came from a break we never ran; the most it can do is file a
-- report, which counts for nothing until a human approves it.
CREATE POLICY price_observations_insert_own_report ON "app"."price_observations"
  FOR INSERT
  TO app_web
  WITH CHECK (
    source = 'user_report'
    AND reporter_id = current_setting('app.user_id', true)
    AND approved_at IS NULL
  );
--> statement-breakpoint

-- The worker turns logged pulls into observations, which is a first-party source and its
-- actual job. It may not file user reports -- those must come from a person.
CREATE POLICY price_observations_insert_first_party ON "app"."price_observations"
  FOR INSERT
  TO app_worker
  WITH CHECK (source <> 'user_report');
--> statement-breakpoint

-- Nobody edits an observation through the web tier. A correction is a new row; a moderation
-- decision runs on the admin path, not from a request.
REVOKE UPDATE, DELETE ON "app"."price_observations" FROM app_web, app_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON "app"."price_observations" TO app_worker;
--> statement-breakpoint
GRANT SELECT ON "app"."price_observations" TO app_readonly;
--> statement-breakpoint

-- The published index is read by everyone and written only by the rollup.
REVOKE INSERT, UPDATE, DELETE ON "app"."price_index_daily" FROM app_web;
--> statement-breakpoint
GRANT SELECT ON "app"."price_index_daily" TO app_readonly, app_web;
--> statement-breakpoint
-- The rollup replaces a day's row when it recomputes, so it needs UPDATE as well as INSERT.
GRANT SELECT, INSERT, UPDATE ON "app"."price_index_daily" TO app_worker;
