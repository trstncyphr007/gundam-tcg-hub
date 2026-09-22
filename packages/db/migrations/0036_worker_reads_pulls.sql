-- Let the price rollup read the pull logs it turns into observations (FR-3.2).
--
-- Migration 0011 revoked everything on `breaks` and `break_pulls` from app_worker, with a
-- reason that was true when it was written: "the scanner and alert worker have no business
-- reading a creator's session". Phase 3 then gave the worker a second job — the nightly
-- rollup, which ingests pull logs into `price_observations` — and nobody noticed, because the
-- rollup command ran as the *migrator* on a workstation. Running it the way the server does
-- (in the production image, on the worker role) fails immediately:
--
--   permission denied for table break_pulls
--
-- So the grant is the fix, and the interesting part is how narrow it can be. Not
-- `GRANT SELECT ON break_pulls`: only the columns the rollup actually reads. A break's title,
-- its creator, its overlay token hash and its seeds stay unreadable to this role, so a
-- compromised nightly job still cannot enumerate who ran which break, or take over an
-- overlay (SR-2.1, ADR-019).
--
-- Row-level security needs no change: `breaks_select_own_or_published` already shows an
-- un-scoped connection exactly the non-draft breaks, which is precisely the set the rollup
-- wants, and `break_pulls_select_visible` inherits it. The worker sets no `app.user_id`, so
-- it sees published breaks and nothing else — including no drafts.
GRANT SELECT (id, status) ON "app"."breaks" TO app_worker;
--> statement-breakpoint
GRANT SELECT (id, break_id, card_variant_id, value_cents_at_pull, value_source, pulled_at)
  ON "app"."break_pulls" TO app_worker;
--> statement-breakpoint

-- Still no writing, in either table: pull logs stay append-only and creator-owned, and the
-- rollup only ever inserts into `price_observations` (0013).
REVOKE INSERT, UPDATE, DELETE ON "app"."breaks", "app"."break_pulls" FROM app_worker;
