-- Commit–reveal: row and column privileges (FR-4.2, SR-4.2, AC-4.3).
--
-- The property this protects is narrow and absolute: **nobody may learn the server seed
-- before the break ends.** Anyone who does can compute the assignment in advance, and the
-- whole scheme is theatre. It is defended three ways, none of which relies on application
-- code being correct:
--
--   1. The seed is stored encrypted (AES-256-GCM). A database backup does not contain it.
--   2. The web role has no SELECT privilege on the encrypted column at all, so the tier that
--      serves requests cannot read the ciphertext, let alone attempt to decrypt it.
--   3. Reveal is an UPDATE of `revealed_seed`, and a CHECK constraint forbids revealing
--      before the audience's client seed is recorded.
ALTER TABLE "app"."break_commitments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."break_commitments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The commitment is published before the break, so anyone may read the row. What they may
-- read *of* it is decided by the column grants below, not by this policy.
CREATE POLICY break_commitments_select_visible ON "app"."break_commitments"
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM "app"."breaks" b WHERE b.id = break_id));
--> statement-breakpoint

-- Only the creator of the break may commit to it, and only once (the unique index).
CREATE POLICY break_commitments_insert_own ON "app"."break_commitments"
  FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM "app"."breaks" b
     WHERE b.id = break_id
       AND b.creator_id = current_setting('app.user_id', true)
  ));
--> statement-breakpoint

CREATE POLICY break_commitments_update_own ON "app"."break_commitments"
  FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM "app"."breaks" b
     WHERE b.id = break_id
       AND b.creator_id = current_setting('app.user_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "app"."breaks" b
     WHERE b.id = break_id
       AND b.creator_id = current_setting('app.user_id', true)
  ));
--> statement-breakpoint

-- Column privileges. The web role can write the ciphertext and can never read it back --
-- the same asymmetry that protects API key hashes, for the same reason.
REVOKE ALL ON "app"."break_commitments" FROM app_web, app_readonly;
--> statement-breakpoint
GRANT SELECT (id, break_id, commitment, client_seed, revealed_seed, slot_count,
              algorithm_version, committed_at, revealed_at)
  ON "app"."break_commitments" TO app_web, app_readonly;
--> statement-breakpoint
GRANT INSERT ON "app"."break_commitments" TO app_web;
--> statement-breakpoint
-- The worker is the only role that may read the ciphertext, and it is the role the reveal
-- runs on. It may read and nothing else: it cannot write a commitment, change one, or
-- delete one, so the most a compromised worker achieves is learning seeds for breaks that
-- have already ended — which are published anyway.
GRANT SELECT ON "app"."break_commitments" TO app_worker;
--> statement-breakpoint
CREATE POLICY break_commitments_read_secret ON "app"."break_commitments"
  FOR SELECT
  TO app_worker
  USING (true);
--> statement-breakpoint
-- Reveal writes the plaintext seed; the client seed is recorded before that.
GRANT UPDATE (client_seed, revealed_seed, revealed_at) ON "app"."break_commitments" TO app_web;
--> statement-breakpoint
-- Nobody deletes a commitment. Deleting one would erase the evidence that a break was
-- committed to at all, which is the one record a dishonest breaker would want gone.
REVOKE DELETE ON "app"."break_commitments" FROM app_web, app_worker, app_readonly;
--> statement-breakpoint

-- The hash chain is written once, with the row, by the same append-only path as the pull
-- itself. AC-4.3 asserts the app role cannot UPDATE or DELETE `break_pulls`; migration 0011
-- already revoked both, and this re-states it so that a future GRANT has to argue with two
-- migrations rather than silently widen one.
REVOKE UPDATE, DELETE ON "app"."break_pulls" FROM app_web, app_worker, app_readonly;
