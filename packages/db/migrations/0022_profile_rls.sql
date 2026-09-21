-- Breaker profiles and pack odds: row-level security and least privilege (FR-4.3, SR-3.8).
--
-- Two tables with opposite shapes, so they get opposite treatment.
--
-- `creator_profiles` is user-owned and publishes a person's name on the open internet, so it
-- is FORCE'd: there is no admin or job path that legitimately creates someone's public
-- identity for them. The default is unpublished, and the SELECT policy is what makes that
-- default mean something — an unpublished row is invisible to everyone but its owner, at the
-- database, not merely absent from a query somewhere in the application.
--
-- `pack_odds` is reference data: the publisher's own numbers, the same for every reader.
-- Nobody owns a row, so there is no ownership predicate to write. It is readable by all and
-- writable by nobody through the application at all (see the grants below).
ALTER TABLE "app"."creator_profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."creator_profiles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The owner sees their own profile at any stage; everyone else sees published ones.
-- current_setting(..., true) is NULL when unset, and NULL = user_id is never true, so a
-- connection with no declared user sees published profiles only — which is exactly what the
-- public API's read-only role is.
CREATE POLICY creator_profiles_select_own_or_published ON "app"."creator_profiles"
  FOR SELECT
  USING (user_id = current_setting('app.user_id', true) OR published);
--> statement-breakpoint

-- A forged user_id in the payload fails here, not in application code.
CREATE POLICY creator_profiles_insert_own ON "app"."creator_profiles"
  FOR INSERT
  WITH CHECK (user_id = current_setting('app.user_id', true));
--> statement-breakpoint

-- USING and WITH CHECK both: USING decides which rows may be updated, WITH CHECK decides
-- what they may become. Without the second, a profile could be handed to another account by
-- writing a new user_id — which is not sharing a page, it is losing one.
CREATE POLICY creator_profiles_update_own ON "app"."creator_profiles"
  FOR UPDATE
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));
--> statement-breakpoint

-- Unpublishing is an UPDATE; deleting is how someone leaves entirely, and it frees the
-- handle. Both are the owner's to do.
CREATE POLICY creator_profiles_delete_own ON "app"."creator_profiles"
  FOR DELETE
  USING (user_id = current_setting('app.user_id', true));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "app"."creator_profiles" TO app_web;
--> statement-breakpoint
-- The public profile page is served by the read-only role, which may read and nothing else.
-- It has no declared user, so the policy above admits published rows and only those.
GRANT SELECT ON "app"."creator_profiles" TO app_readonly;
--> statement-breakpoint
-- The alert worker has no business reading who is publicly a breaker.
REVOKE ALL ON "app"."creator_profiles" FROM app_worker;
--> statement-breakpoint

-- Pack odds: read by everyone, written by the migrator only.
--
-- No route writes this table and none is planned in this phase, so the application roles get
-- SELECT and nothing more. That is the real control behind `source_url`: the citation cannot
-- be edited by a web request, because the web role cannot write the row at all. When an
-- admin screen for it arrives it will have to grant the privilege explicitly, and argue with
-- this line rather than inherit one.
ALTER TABLE "app"."pack_odds" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY pack_odds_select_all ON "app"."pack_odds"
  FOR SELECT
  USING (true);
--> statement-breakpoint
GRANT SELECT ON "app"."pack_odds" TO app_web, app_readonly, app_worker;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "app"."pack_odds" FROM app_web, app_readonly, app_worker;
