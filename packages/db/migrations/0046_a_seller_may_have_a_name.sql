-- A seller may have a name (FR-5.7, SR-3.8).
--
-- Listings have shown "4.8 from 23" and no name, because the public browse route publishes no
-- user id: an identifier on a route with CORS `*` and no session is a directory of everyone
-- selling anything. A buyer choosing between two listings still wants to know who they are
-- buying from, so sellers may now choose a name to be known by.
--
-- ## Why it lives here rather than on `users`
--
-- The same reason `creator_profiles` is its own table (migration 0022): **the default must be
-- no public identity at all**. Nothing here is copied from the account — not `users.name`, not
-- the email, not the Discord handle. The column is null until a seller types something, and
-- nulling it again removes the name rather than blanking it.
--
-- ## Why it lives on `seller_accounts` specifically
--
-- Because the row exists only once Stripe has been asked to onboard the person, and that turns
-- out to be the useful property rather than an accident of storage: **a public seller identity
-- costs a completed identity check.** Somebody who has not been through Stripe's KYC cannot
-- call themselves "Bandai Official Store" on a listing, because they have no row to write the
-- name to. For a name displayed next to a price, that is worth more than any denylist of
-- reserved words, which is always one spelling behind.
--
-- ## The shape of a name
--
-- Trimmed, 2 to 40 characters, starting and ending with a letter or digit. The inner set
-- allows spaces, full stops, underscores, hyphens and apostrophes — enough for "J. Random
-- Cards" and "O'Neill's Singles", and not enough for a name made of punctuation or one that
-- pads itself with spaces to sort first. Control characters are excluded by the class, which
-- also keeps the bidirectional-override trick out.
--
-- Unique case-insensitively, because two sellers called "TRSTN" is not a naming collision, it
-- is a buyer who cannot tell which one they are paying.
--
-- ## Hand-written, so it needs a journal entry
--
-- drizzle-kit did not generate this file, and the migrator reads `meta/_journal.json` rather
-- than the directory. A migration missing from that file is silently skipped — which has
-- happened here before, and produced a test run where every grant below was absent and one
-- test passed anyway for an unrelated reason.
ALTER TABLE "app"."seller_accounts" ADD COLUMN "display_name" text;--> statement-breakpoint

ALTER TABLE "app"."seller_accounts"
  ADD CONSTRAINT "seller_accounts_display_name_shape"
  CHECK (
    "display_name" IS NULL
    OR (
      "display_name" = btrim("display_name")
      AND length("display_name") BETWEEN 2 AND 40
      AND "display_name" ~ '^[[:alnum:]][[:alnum:] ._''-]*[[:alnum:]]$'
    )
  );--> statement-breakpoint

CREATE UNIQUE INDEX "seller_accounts_display_name_key"
  ON "app"."seller_accounts" (lower("display_name"))
  WHERE "display_name" IS NOT NULL;--> statement-breakpoint

-- The seller may write their own name, and nothing else on this row.
--
-- Column-level, like the INSERT grant above it: `charges_enabled`, `payouts_enabled`,
-- `hold_until` and `stripe_account_id` stay outside what a session can write, so this new
-- ability cannot be turned into any of the older ones. A seller who edits the request body to
-- enable their own payouts is refused by the grant, not by the route.
GRANT UPDATE ("display_name", "updated_at") ON "app"."seller_accounts" TO app_web;--> statement-breakpoint

CREATE POLICY seller_accounts_update_own ON "app"."seller_accounts"
  FOR UPDATE TO app_web
  USING (user_id = current_setting('app.user_id', true))
  WITH CHECK (user_id = current_setting('app.user_id', true));--> statement-breakpoint

-- The public may read the name, and only the name.
--
-- `GRANT SELECT (user_id, display_name)` is the whole control: `stripe_account_id` is not in
-- the list, so the read-only role cannot select it however the query is written. The policy
-- then limits the rows to sellers who actually chose a name — an account that never set one is
-- not visible to this role at all.
GRANT SELECT ("user_id", "display_name") ON "app"."seller_accounts" TO app_readonly;--> statement-breakpoint

CREATE POLICY seller_accounts_select_named ON "app"."seller_accounts"
  FOR SELECT TO app_readonly
  USING ("display_name" IS NOT NULL);
