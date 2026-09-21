-- VOD timestamps: row-level security and least privilege (FR-4.4).
--
-- This table sits deliberately outside the hash chain, and its permissions say so.
--
-- `break_pulls` is append-only: UPDATE and DELETE are revoked from every application role,
-- because a pull log that can be edited is not a log. `pull_evidence` is the opposite — it is
-- editable by its owner, on purpose. A timestamp is typed by a person watching a VOD back and
-- a typo in one should be fixable. The distinction the public page has to make, and does, is
-- that the pull is proven and the timestamp is not.
--
-- What this is NOT is a way around the append-only rule. The only columns are an offset and
-- an optional URL: nothing here can change what was pulled, what it was worth, or when.
ALTER TABLE "app"."pull_evidence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."pull_evidence" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Visible exactly when the pull is. The EXISTS re-enters `break_pulls`, which is itself
-- policied, so there is one rule about who may see a break and it is written once — a
-- timestamp cannot leak the existence of a draft break's pulls.
CREATE POLICY pull_evidence_select_visible ON "app"."pull_evidence"
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM "app"."break_pulls" p WHERE p.id = break_pull_id));
--> statement-breakpoint

-- Only the creator of the break the pull belongs to. Two joins rather than a denormalised
-- creator_id: one source of truth for who owns a break, even at the cost of the join.
CREATE POLICY pull_evidence_insert_own ON "app"."pull_evidence"
  FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM "app"."break_pulls" p
      JOIN "app"."breaks" b ON b.id = p.break_id
     WHERE p.id = break_pull_id
       AND b.creator_id = current_setting('app.user_id', true)
  ));
--> statement-breakpoint

CREATE POLICY pull_evidence_update_own ON "app"."pull_evidence"
  FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM "app"."break_pulls" p
      JOIN "app"."breaks" b ON b.id = p.break_id
     WHERE p.id = break_pull_id
       AND b.creator_id = current_setting('app.user_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "app"."break_pulls" p
      JOIN "app"."breaks" b ON b.id = p.break_id
     WHERE p.id = break_pull_id
       AND b.creator_id = current_setting('app.user_id', true)
  ));
--> statement-breakpoint

-- Removing a timestamp is how a creator says "this one was wrong and I have no right one".
-- Better than leaving a link that points at the wrong moment.
CREATE POLICY pull_evidence_delete_own ON "app"."pull_evidence"
  FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM "app"."break_pulls" p
      JOIN "app"."breaks" b ON b.id = p.break_id
     WHERE p.id = break_pull_id
       AND b.creator_id = current_setting('app.user_id', true)
  ));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "app"."pull_evidence" TO app_web;
--> statement-breakpoint
-- The public break page is served by the read-only role, which has no declared user and so
-- sees the evidence for published breaks only.
GRANT SELECT ON "app"."pull_evidence" TO app_readonly;
--> statement-breakpoint
-- The alert worker has no business with break evidence.
REVOKE ALL ON "app"."pull_evidence" FROM app_worker;
--> statement-breakpoint

-- Re-stated, because this migration puts an editable table next to an append-only one and
-- that distinction is the whole point. A future GRANT loosening `break_pulls` now has to
-- argue with three migrations rather than quietly widen one.
REVOKE UPDATE, DELETE ON "app"."break_pulls" FROM app_web, app_worker, app_readonly;
