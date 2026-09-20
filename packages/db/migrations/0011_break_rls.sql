-- Row-level security and least privilege for creator breaks (SR-2.1, SR-2.6, SR-X.8).
--
-- Breaks are a hybrid: the creator owns them, but the public break page and the OBS
-- overlay are read by people with no account at all. So "public" is expressed as a
-- policy predicate on the row's own status, not as an absence of policy -- a draft break
-- stays private until its creator starts it.
ALTER TABLE "app"."breaks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."breaks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."break_pulls" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."break_pulls" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The creator sees their own breaks in any state; everyone sees ones that have started.
-- current_setting(..., true) is NULL when unset, and NULL = creator_id is never true, so
-- an un-scoped connection sees published breaks only.
CREATE POLICY breaks_select_own_or_published ON "app"."breaks"
  FOR SELECT
  USING (creator_id = current_setting('app.user_id', true) OR status <> 'draft');
--> statement-breakpoint
-- A forged creator_id in the payload fails here, not in application code.
-- The OBS overlay presents a token and nothing else -- no session, no account. Rather
-- than exempt that path from RLS, make the token itself the credential Postgres checks:
-- the caller sets app.overlay_token to the token's HMAC for the transaction, and sees
-- exactly the one row whose stored hash matches.
--
-- This is what lets a creator wire the overlay into OBS while the break is still a draft,
-- without making drafts readable to anyone who guesses an id. The setting holds the hash,
-- never the token, so the secret is not in the session either.
CREATE POLICY breaks_select_by_overlay_token ON "app"."breaks"
  FOR SELECT
  USING (overlay_token_hash = current_setting('app.overlay_token', true));
--> statement-breakpoint
CREATE POLICY breaks_insert_own ON "app"."breaks"
  FOR INSERT
  WITH CHECK (creator_id = current_setting('app.user_id', true));
--> statement-breakpoint
CREATE POLICY breaks_update_own ON "app"."breaks"
  FOR UPDATE
  USING (creator_id = current_setting('app.user_id', true))
  WITH CHECK (creator_id = current_setting('app.user_id', true));
--> statement-breakpoint
CREATE POLICY breaks_delete_own ON "app"."breaks"
  FOR DELETE
  USING (creator_id = current_setting('app.user_id', true));
--> statement-breakpoint

-- Pulls inherit their break's visibility. The EXISTS re-enters `breaks`, which is itself
-- policied, so this cannot widen access beyond what the break already allows.
CREATE POLICY break_pulls_select_visible ON "app"."break_pulls"
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM "app"."breaks" b WHERE b.id = break_id));
--> statement-breakpoint
-- Only the owning creator may log a pull, and only into a break that is actually live:
-- a finished break cannot gain new rows afterwards.
CREATE POLICY break_pulls_insert_own_live ON "app"."break_pulls"
  FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM "app"."breaks" b
     WHERE b.id = break_id
       AND b.creator_id = current_setting('app.user_id', true)
       AND b.status = 'live'
  ));
--> statement-breakpoint

-- Pull logs are append-only (SR-4.1 arrives in Phase 4 and hash-chains this table; the
-- grants that make that meaningful belong here, before there is data to protect).
-- A correction is a new row, never an edit, so the public log cannot be quietly rewritten.
REVOKE UPDATE, DELETE ON "app"."break_pulls" FROM app_web, app_worker;
--> statement-breakpoint
-- Breaks are a web-tier concern entirely: the scanner and alert worker have no business
-- reading a creator's session, let alone writing one.
REVOKE ALL ON "app"."breaks", "app"."break_pulls" FROM app_worker;
--> statement-breakpoint
-- The public API serves break pages through the read-only role.
GRANT SELECT ON "app"."breaks", "app"."break_pulls" TO app_readonly;
