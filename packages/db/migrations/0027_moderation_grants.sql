-- Moderation: who may decide that a price counts (SR-3.5, SR-4.4, SR-5.9).
--
-- Until this migration nothing could. `moderateObservation` has existed since Phase 3, but
-- the web role has UPDATE revoked on price_observations (0013) and the worker had no UPDATE
-- policy — so the only thing that ever approved a report was the table owner, in a test.
-- The control "a report counts for nothing until a human approves it" was true, and it was
-- true partly because no human could.
--
-- The decision is given to the worker role, not the web role, for the same reason the break
-- reveal and API-key verification run there: the tier that serves ordinary requests must
-- never be able to mark a price as counting. An admin request hands the one write that
-- needs it to the one role that may do it, exactly as those paths already do.
--
-- And the worker gets the three decision columns and nothing else. It cannot change a
-- price, a card, a date or a source through this grant — only whether the row counts.
GRANT UPDATE (approved_at, rejected_at, flagged_at) ON "app"."price_observations" TO app_worker;
--> statement-breakpoint

-- price_observations is ENABLEd, not FORCEd (0013), so the owner bypasses policies but the
-- worker does not: without a policy of its own, its UPDATE would match no rows at all and
-- report success. That is the silent failure worth a comment.
CREATE POLICY price_observations_worker_moderate ON "app"."price_observations"
  FOR UPDATE
  TO app_worker
  USING (true)
  WITH CHECK (
    -- A decision, not two: the existing CHECK forbids approved + rejected together, and this
    -- keeps a moderation write from ever producing a row that is both held and rejected.
    NOT (rejected_at IS NOT NULL AND flagged_at IS NOT NULL)
  );
--> statement-breakpoint

-- Re-stated: the web role still decides nothing. An admin session reaches the worker pool
-- through a route, never through a privilege on its own connection.
REVOKE UPDATE ON "app"."price_observations" FROM app_web;
