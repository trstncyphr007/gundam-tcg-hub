-- The marketplace (Phase 5, §14): who may see an order, and who may say it was paid.
--
-- The tables are generated from src/schema/market.ts. Everything below the tables is written
-- by hand, because row-level security and column grants are not something a schema generator
-- has an opinion about — and here they are the point.
--
-- Note for whoever runs `drizzle-kit generate` next: migrations 0035-0040 were hand-written
-- and left no snapshot, so `generate` diffs against 0034 and re-emits 0040's `api_keys`
-- columns. They were removed from this file by hand. Expect to do the same.
--
-- ## The rule the database keeps on its own
--
-- `@gth/core`'s state machine says only Stripe may mark an order `paid` or `refunded`. That
-- is a rule in TypeScript, and TypeScript is not what stands between a compromised web
-- process and somebody's money. So the web role is given a WITH CHECK that permits exactly
-- four statuses, and `paid` is not one of them.
--
-- A session cannot write `paid` here. Not through a bug, not through an injection, not
-- through a route somebody forgets to guard. The webhook handler runs on the worker role,
-- which can — and a webhook is only accepted after its signature has been verified.

CREATE TYPE "app"."listing_status" AS ENUM('draft', 'active', 'sold', 'withdrawn');--> statement-breakpoint
CREATE TYPE "app"."order_actor" AS ENUM('buyer', 'seller', 'admin', 'stripe', 'system');--> statement-breakpoint
CREATE TYPE "app"."order_status" AS ENUM('created', 'paid', 'shipped', 'delivered', 'completed', 'cancelled', 'refunded', 'disputed');--> statement-breakpoint
CREATE TABLE "app"."listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" text NOT NULL,
	"card_variant_id" uuid NOT NULL,
	"condition" "app"."card_condition" NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"status" "app"."listing_status" DEFAULT 'draft' NOT NULL,
	"photo_required" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listings_price_positive" CHECK ("app"."listings"."price_cents" > 0),
	CONSTRAINT "listings_price_sane" CHECK ("app"."listings"."price_cents" <= 100000000),
	CONSTRAINT "listings_quantity_positive" CHECK ("app"."listings"."quantity" >= 1),
	CONSTRAINT "listings_quantity_sane" CHECK ("app"."listings"."quantity" <= 999),
	CONSTRAINT "listings_currency_iso" CHECK ("app"."listings"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "listings_notes_length" CHECK ("app"."listings"."notes" is null or length("app"."listings"."notes") <= 500)
);
--> statement-breakpoint
CREATE TABLE "app"."order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"from_status" "app"."order_status" NOT NULL,
	"to_status" "app"."order_status" NOT NULL,
	"actor" "app"."order_actor" NOT NULL,
	"actor_id" text,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_events_reason_length" CHECK ("app"."order_events"."reason" is null or length("app"."order_events"."reason") <= 280),
	CONSTRAINT "order_events_actor_identified" CHECK (("app"."order_events"."actor" in ('stripe', 'system') and "app"."order_events"."actor_id" is null)
          or ("app"."order_events"."actor" in ('buyer', 'seller', 'admin')))
);
--> statement-breakpoint
CREATE TABLE "app"."orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"buyer_id" text NOT NULL,
	"seller_id" text NOT NULL,
	"listing_id" uuid,
	"card_variant_id" uuid NOT NULL,
	"condition" "app"."card_condition" NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"status" "app"."order_status" DEFAULT 'created' NOT NULL,
	"amount_cents" integer NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"stripe_checkout_id" text,
	"stripe_payment_intent_id" text,
	"tracking_carrier" text,
	"tracking_number" text,
	"paid_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_not_self_dealing" CHECK ("app"."orders"."buyer_id" <> "app"."orders"."seller_id"),
	CONSTRAINT "orders_amount_positive" CHECK ("app"."orders"."amount_cents" > 0),
	CONSTRAINT "orders_amount_sane" CHECK ("app"."orders"."amount_cents" <= 100000000),
	CONSTRAINT "orders_fee_non_negative" CHECK ("app"."orders"."fee_cents" >= 0),
	CONSTRAINT "orders_tax_non_negative" CHECK ("app"."orders"."tax_cents" >= 0),
	CONSTRAINT "orders_fee_within_amount" CHECK ("app"."orders"."fee_cents" <= "app"."orders"."amount_cents"),
	CONSTRAINT "orders_quantity_positive" CHECK ("app"."orders"."quantity" >= 1),
	CONSTRAINT "orders_currency_iso" CHECK ("app"."orders"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "orders_paid_has_payment" CHECK ("app"."orders"."status" in ('created', 'cancelled') or "app"."orders"."stripe_payment_intent_id" is not null),
	CONSTRAINT "orders_shipped_has_tracking" CHECK ("app"."orders"."status" not in ('shipped', 'delivered', 'completed')
          or ("app"."orders"."tracking_carrier" is not null and "app"."orders"."tracking_number" is not null))
);
--> statement-breakpoint
CREATE TABLE "app"."seller_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"stripe_account_id" text NOT NULL,
	"charges_enabled" boolean DEFAULT false NOT NULL,
	"payouts_enabled" boolean DEFAULT false NOT NULL,
	"hold_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_accounts_stripe_id_format" CHECK ("app"."seller_accounts"."stripe_account_id" ~ '^acct_[A-Za-z0-9]+$')
);
--> statement-breakpoint
CREATE TABLE "app"."webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app"."listings" ADD CONSTRAINT "listings_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."listings" ADD CONSTRAINT "listings_card_variant_id_card_variants_id_fk" FOREIGN KEY ("card_variant_id") REFERENCES "app"."card_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "app"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."order_events" ADD CONSTRAINT "order_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."orders" ADD CONSTRAINT "orders_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."orders" ADD CONSTRAINT "orders_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "app"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."orders" ADD CONSTRAINT "orders_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "app"."listings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."orders" ADD CONSTRAINT "orders_card_variant_id_card_variants_id_fk" FOREIGN KEY ("card_variant_id") REFERENCES "app"."card_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."seller_accounts" ADD CONSTRAINT "seller_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listings_variant_active_idx" ON "app"."listings" USING btree ("card_variant_id","price_cents") WHERE "app"."listings"."status" = 'active';--> statement-breakpoint
CREATE INDEX "listings_seller_idx" ON "app"."listings" USING btree ("seller_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "app"."order_events" USING btree ("order_id","at");--> statement-breakpoint
CREATE INDEX "orders_buyer_idx" ON "app"."orders" USING btree ("buyer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_seller_idx" ON "app"."orders" USING btree ("seller_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "orders_checkout_key" ON "app"."orders" USING btree ("stripe_checkout_id") WHERE "app"."orders"."stripe_checkout_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_payment_intent_key" ON "app"."orders" USING btree ("stripe_payment_intent_id") WHERE "app"."orders"."stripe_payment_intent_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_accounts_user_key" ON "app"."seller_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_accounts_stripe_key" ON "app"."seller_accounts" USING btree ("stripe_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_key" ON "app"."webhook_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "app"."webhook_events" USING btree ("received_at") WHERE "app"."webhook_events"."processed_at" is null;--> statement-breakpoint

-- ===========================================================================================
-- seller_accounts: Stripe's answers, mirrored. Nobody marks their own account ready.
-- ===========================================================================================
ALTER TABLE "app"."seller_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."seller_accounts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY seller_accounts_select_own ON "app"."seller_accounts"
  FOR SELECT TO app_web
  USING (user_id = current_setting('app.user_id', true));--> statement-breakpoint

-- Starting onboarding is a session action: the user clicks, we ask Stripe for an account, we
-- store the id it gave us.
CREATE POLICY seller_accounts_insert_own ON "app"."seller_accounts"
  FOR INSERT TO app_web
  WITH CHECK (user_id = current_setting('app.user_id', true));--> statement-breakpoint

REVOKE ALL ON "app"."seller_accounts" FROM PUBLIC, app_web, app_worker, app_readonly;--> statement-breakpoint
GRANT SELECT ON "app"."seller_accounts" TO app_web;--> statement-breakpoint
-- Column-level, so the two booleans that decide whether somebody may take money are not in
-- the set of things a session can write. They arrive from a webhook or not at all.
GRANT INSERT (id, user_id, stripe_account_id, created_at, updated_at)
  ON "app"."seller_accounts" TO app_web;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "app"."seller_accounts" TO app_worker;--> statement-breakpoint
CREATE POLICY seller_accounts_worker ON "app"."seller_accounts"
  FOR ALL TO app_worker
  USING (true) WITH CHECK (true);--> statement-breakpoint

-- ===========================================================================================
-- listings: yours to edit, everyone's to browse once active.
-- ===========================================================================================
ALTER TABLE "app"."listings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."listings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- A seller sees their own drafts; everybody sees what is actually for sale. Two conditions in
-- one policy rather than two policies, because policies are OR'd and that is what is wanted.
CREATE POLICY listings_select_active_or_own ON "app"."listings"
  FOR SELECT TO app_web
  USING (status = 'active' OR seller_id = current_setting('app.user_id', true));--> statement-breakpoint

-- The public API has no session, so it sees exactly what a stranger may see.
CREATE POLICY listings_select_public ON "app"."listings"
  FOR SELECT TO app_readonly
  USING (status = 'active');--> statement-breakpoint

CREATE POLICY listings_insert_own ON "app"."listings"
  FOR INSERT TO app_web
  WITH CHECK (seller_id = current_setting('app.user_id', true));--> statement-breakpoint

-- USING decides which rows may change, WITH CHECK decides what they may become: without the
-- second, a seller could hand their listing to somebody else.
CREATE POLICY listings_update_own ON "app"."listings"
  FOR UPDATE TO app_web
  USING (seller_id = current_setting('app.user_id', true))
  WITH CHECK (seller_id = current_setting('app.user_id', true));--> statement-breakpoint

-- Only a draft can be deleted outright. Anything that has been live is withdrawn instead, so
-- an order pointing at it still has something to point at.
CREATE POLICY listings_delete_own_draft ON "app"."listings"
  FOR DELETE TO app_web
  USING (seller_id = current_setting('app.user_id', true) AND status = 'draft');--> statement-breakpoint

REVOKE ALL ON "app"."listings" FROM PUBLIC, app_web, app_worker, app_readonly;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "app"."listings" TO app_web;--> statement-breakpoint
GRANT SELECT ON "app"."listings" TO app_readonly;--> statement-breakpoint
GRANT SELECT, UPDATE ON "app"."listings" TO app_worker;--> statement-breakpoint
CREATE POLICY listings_worker ON "app"."listings"
  FOR ALL TO app_worker
  USING (true) WITH CHECK (true);--> statement-breakpoint

-- ===========================================================================================
-- orders: the table where the database refuses to be talked into anything.
-- ===========================================================================================
ALTER TABLE "app"."orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."orders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY orders_select_party ON "app"."orders"
  FOR SELECT TO app_web
  USING (
    buyer_id = current_setting('app.user_id', true)
    OR seller_id = current_setting('app.user_id', true)
  );--> statement-breakpoint

-- A buyer opens their own order and nobody else's. `created` only: an order cannot be born
-- already paid.
CREATE POLICY orders_insert_as_buyer ON "app"."orders"
  FOR INSERT TO app_web
  WITH CHECK (
    buyer_id = current_setting('app.user_id', true)
    AND status = 'created'
  );--> statement-breakpoint

/*
 * The important one.
 *
 * A party to the order may move it, and may move it only into a status a person is allowed to
 * cause: `shipped` (the seller posted it), `cancelled` (either side, before postage),
 * `disputed` (the buyer escalates). `created` is permitted so an unrelated update — tracking,
 * say — does not have to change the status to be allowed.
 *
 * `paid`, `refunded`, `delivered` and `completed` are absent on purpose. The first two mean
 * money moved and come from a verified webhook on the worker role. The second two release a
 * payout and come from the carrier or an admin, never from the seller who benefits.
 *
 * This is the same rule as `@gth/core`'s transition table, written a second time in a place
 * application code cannot reach around. If the two ever disagree, this one wins, and a test
 * says so.
 */
CREATE POLICY orders_update_party ON "app"."orders"
  FOR UPDATE TO app_web
  USING (
    buyer_id = current_setting('app.user_id', true)
    OR seller_id = current_setting('app.user_id', true)
  )
  WITH CHECK (
    (buyer_id = current_setting('app.user_id', true)
     OR seller_id = current_setting('app.user_id', true))
    AND status IN ('created', 'shipped', 'cancelled', 'disputed')
  );--> statement-breakpoint

REVOKE ALL ON "app"."orders" FROM PUBLIC, app_web, app_worker, app_readonly;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "app"."orders" TO app_web;--> statement-breakpoint
-- No DELETE for anybody. An order is a financial record; it ends in a terminal status, not in
-- nothing.
GRANT SELECT, INSERT, UPDATE ON "app"."orders" TO app_worker;--> statement-breakpoint
CREATE POLICY orders_worker ON "app"."orders"
  FOR ALL TO app_worker
  USING (true) WITH CHECK (true);--> statement-breakpoint

-- ===========================================================================================
-- order_events: what happened, in a table that cannot be edited afterwards.
-- ===========================================================================================
ALTER TABLE "app"."order_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."order_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Visible to the two people it is about. The subquery reads `orders`, which has its own
-- policies, so this cannot be used to look at somebody else's order sideways.
CREATE POLICY order_events_select_party ON "app"."order_events"
  FOR SELECT TO app_web
  USING (
    EXISTS (
      SELECT 1 FROM "app"."orders" o
       WHERE o.id = order_id
         AND (o.buyer_id = current_setting('app.user_id', true)
              OR o.seller_id = current_setting('app.user_id', true))
    )
  );--> statement-breakpoint

CREATE POLICY order_events_insert_party ON "app"."order_events"
  FOR INSERT TO app_web
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "app"."orders" o
       WHERE o.id = order_id
         AND (o.buyer_id = current_setting('app.user_id', true)
              OR o.seller_id = current_setting('app.user_id', true))
    )
  );--> statement-breakpoint

REVOKE ALL ON "app"."order_events" FROM PUBLIC, app_web, app_worker, app_readonly;--> statement-breakpoint
-- SELECT and INSERT, and nothing else, for anyone. This is the record two parties reach for
-- when they disagree; a history the application can rewrite is not evidence (SR-4.1's
-- reasoning, applied to money).
GRANT SELECT, INSERT ON "app"."order_events" TO app_web;--> statement-breakpoint
GRANT SELECT, INSERT ON "app"."order_events" TO app_worker;--> statement-breakpoint
CREATE POLICY order_events_worker ON "app"."order_events"
  FOR ALL TO app_worker
  USING (true) WITH CHECK (true);--> statement-breakpoint

-- ===========================================================================================
-- webhook_events: not a session's business at all.
-- ===========================================================================================
REVOKE ALL ON "app"."webhook_events" FROM PUBLIC, app_web, app_worker, app_readonly;--> statement-breakpoint
-- The worker handles webhooks and nothing else touches this table. No RLS policy, because
-- there is no user to key one on — the grant is the whole access control.
GRANT SELECT, INSERT, UPDATE ON "app"."webhook_events" TO app_worker;
