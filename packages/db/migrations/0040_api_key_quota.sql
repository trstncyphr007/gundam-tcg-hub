-- The daily quota was a Map in one process (FR-3.7, SR-3.2).
--
-- `apps/api/src/plugins/quota.ts` said the counter moves to a shared store "the day a second
-- API container exists". That is the right trigger for *sharing* a limit and the wrong one for
-- *keeping* one. A counter in memory is lost on restart, and a restart is not a rare event --
-- it is every deploy. So "1,000 requests per day" has meant "1,000 requests since the API last
-- started", on a single instance, today.
--
-- A day also becomes a day. The in-memory window ran for 24 hours from a key's first call,
-- which drifts, and is not what a developer reading the published limit is owed.
ALTER TABLE "app"."api_keys"
  ADD COLUMN "quota_day" date,
  ADD COLUMN "quota_used" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Nothing here is allowed to count downwards.
ALTER TABLE "app"."api_keys"
  ADD CONSTRAINT "api_keys_quota_used_not_negative" CHECK ("quota_used" >= 0);
--> statement-breakpoint

-- Migration 0017 narrowed the worker's write to `last_used_at` precisely so that the role
-- which authenticates requests cannot re-scope a key or un-revoke one. Two more columns, by
-- name, and nothing else: counting requests is the same class of act as stamping the time of
-- the last one.
GRANT UPDATE ("quota_day", "quota_used") ON "app"."api_keys" TO app_worker;
--> statement-breakpoint

-- The web role serves the developer console, which shows how much of a key's allowance is
-- gone. Reading the counter is all it may do with it: the UPDATE grant above is not extended,
-- so the tier that takes session traffic cannot reset somebody's quota.
GRANT SELECT ("quota_day", "quota_used") ON "app"."api_keys" TO app_web;
