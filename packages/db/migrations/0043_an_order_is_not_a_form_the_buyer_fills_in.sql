-- Checkout (Phase 5, slice 5d): narrowing what a session may write on an order.
--
-- Migration 0041 gave `app_web` table-wide INSERT and UPDATE on `orders`. The RLS policies
-- covered *which rows* and *which statuses*, which was enough while nothing created orders.
-- It is not enough now that one does.
--
-- ## What was still possible, and is not any more
--
-- AC-5.4 says a buyer cannot "change its price through the API". With a table-wide UPDATE
-- grant, the only thing stopping them was that no route offered to — the `orders_update_party`
-- policy constrains the status and the parties, and says nothing about `amount_cents`. A buyer
-- could have set their own `created` order to a dollar and the policy would have allowed it.
--
-- It would not have *charged* a dollar: the amount Stripe collects is the one in the Checkout
-- session, fixed when the session was created, and Stripe does not consult our table. So this
-- was a records-tampering hole rather than a theft hole. That is still the row somebody reads
-- during a dispute, so it is still a hole.
--
-- The grants below are column-level, which is the same control 0041 used on
-- `seller_accounts.charges_enabled` and for the same reason: a column outside the grant is not
-- merely one the code does not write, it is one this role cannot write however it is asked.
--
-- **Note for the next person, part one:** Drizzle names every column in an INSERT, including
-- defaulted ones, so the builder cannot be used against a partial INSERT grant. `createOrder`
-- is written out in SQL for exactly this reason, as `recordSellerAccount` already is. UPDATE is
-- fine — `.set()` names only what it is given.
--
-- **Part two: a hand-written migration does nothing until it is in `meta/_journal.json`.** The
-- runner reads the journal, not the directory. Adding this file and running the tests produced
-- a green-looking suite in which every grant below was absent — the one test that failed,
-- failed on a CHECK constraint that happened to fire first, which is how close it came to
-- passing for entirely the wrong reason. Add the entry in the same commit as the file.

-- ===========================================================================================
-- orders: what a session may write, and what it may only read
-- ===========================================================================================
REVOKE INSERT, UPDATE ON "app"."orders" FROM app_web;--> statement-breakpoint

-- Birth. Everything here is either the buyer's identity (checked by the policy), a copy of the
-- listing taken server-side, or money computed server-side from that copy.
--
-- `status` is absent, so an order can only ever be born with its default, `created`. The
-- policy's `AND status = 'created'` now has a second lock behind it.
--
-- `stripe_payment_intent_id`, `paid_at` and the tracking columns are absent because an order
-- is not born paid or posted.
GRANT INSERT (
  buyer_id, seller_id, listing_id,
  card_variant_id, condition, quantity,
  amount_cents, fee_cents, currency
) ON "app"."orders" TO app_web;--> statement-breakpoint

-- Life. A seller posts the parcel; either party cancels or escalates; the buy route attaches
-- the Checkout session id once Stripe has given us one.
--
-- Absent, and therefore unwritable by any session: `amount_cents`, `fee_cents`, `tax_cents`,
-- `currency` (the money), `buyer_id`, `seller_id`, `card_variant_id`, `condition`, `quantity`
-- (what was agreed), `stripe_payment_intent_id`, `paid_at`, `delivered_at`, `completed_at`
-- (facts only a webhook or the clock establishes).
GRANT UPDATE (
  status, stripe_checkout_id,
  tracking_carrier, tracking_number, shipped_at,
  updated_at
) ON "app"."orders" TO app_web;--> statement-breakpoint

-- ===========================================================================================
-- orders: one open order per listing, enforced where RLS cannot reach around it
-- ===========================================================================================
--
-- Two buyers who open the same listing at the same moment both get a Checkout session, both
-- pay, and the seller has two paid orders for one card. One of them has to be refunded, and
-- the seller finds out after the fact. That is the marketplace's most obvious race.
--
-- It cannot be fixed with a `NOT EXISTS` in the insert, because on `app_web` the subquery is
-- filtered by `orders_select_party` — a buyer can only see their own orders, so they would
-- never see the other buyer's. **A unique index is not.** The engine enforces it below RLS, so
-- the second insert fails with 23505 whoever it belongs to, and the route answers 409.
--
-- `cancelled` and `refunded` are excluded: those free the listing again. A `created` order
-- holds it for as long as its Checkout session lives (30 minutes), which is the same window in
-- which the buyer could still pay.
CREATE UNIQUE INDEX "orders_one_open_per_listing" ON "app"."orders" ("listing_id")
  WHERE "listing_id" IS NOT NULL
    AND "status" IN ('created', 'paid', 'shipped', 'delivered', 'completed', 'disputed');--> statement-breakpoint

-- ===========================================================================================
-- seller_accounts: where a purchase sends the money
-- ===========================================================================================
--
-- To create a Checkout session the buy route needs two things about the seller: whether Stripe
-- will let them take money, and which connected account to transfer to. Until now `app_web`
-- could read a `seller_accounts` row only if it was its own, so a buyer could not see either.
--
-- This policy is scoped to sellers who have something for sale. It is OR'd with
-- `seller_accounts_select_own`, so it widens the read and nothing else.
--
-- On `stripe_account_id` being visible to a buyer: an `acct_…` is an identifier, not a
-- credential. Stripe puts it in onboarding URLs and in client-side Connect configuration; it
-- does nothing without our secret key. The alternative — a SECURITY DEFINER function to fetch
-- one column — buys nothing and hides the access rule somewhere harder to audit than here.
CREATE POLICY seller_accounts_select_active_seller ON "app"."seller_accounts"
  FOR SELECT TO app_web
  USING (
    EXISTS (
      SELECT 1 FROM "app"."listings" l
       WHERE l.seller_id = "seller_accounts".user_id
         AND l.status = 'active'
    )
  );
