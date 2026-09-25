-- Seller reputation (Phase 5, FR-5.7).
--
-- A rating is a receipt. It exists only because a specific order completed, and the database is
-- what enforces that — not the route.
--
-- ## The policy is the feature
--
-- `order_ratings_insert_buyer` joins to `orders` and requires four things at once: the order is
-- yours, you are the **buyer** of it, it is `completed`, and the seller you are rating is the
-- seller on it. Every one of those is a way a reputation system gets gamed if it is left to
-- application code:
--
--   * not your order      → anybody reviews anybody, and competitors review each other
--   * you are the seller  → sellers rate themselves
--   * not completed       → a rating becomes a threat to be withdrawn mid-sale
--   * wrong seller        → a good order is used to rate a different account
--
-- A route can forget any of those. A policy cannot, and there is a test for each.
--
-- ## Ratings are public, deliberately
--
-- `SELECT` is open to `app_web` and `app_readonly` with no ownership test. That is the point of
-- reputation: it is for the person deciding whether to buy, who is by definition not a party to
-- the order being rated. What is *not* published is the rater — the public view selects stars
-- and comments, never `rater_id` (SR-3.8, the same rule public collections follow).
--
-- ## Note for the next person
--
-- A hand-written migration does nothing until it has an entry in `meta/_journal.json`. The
-- runner reads the journal, not the directory. Add the entry in the same commit as the file.

CREATE TABLE "app"."order_ratings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"seller_id" text NOT NULL,
	"rater_id" text NOT NULL,
	"stars" integer NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_ratings_stars_range" CHECK ("app"."order_ratings"."stars" between 1 and 5),
	CONSTRAINT "order_ratings_comment_length" CHECK ("app"."order_ratings"."comment" is null or length("app"."order_ratings"."comment") <= 500),
	CONSTRAINT "order_ratings_not_self" CHECK ("app"."order_ratings"."rater_id" <> "app"."order_ratings"."seller_id")
);
--> statement-breakpoint
ALTER TABLE "app"."order_ratings" ADD CONSTRAINT "order_ratings_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "app"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."order_ratings" ADD CONSTRAINT "order_ratings_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."order_ratings" ADD CONSTRAINT "order_ratings_rater_id_users_id_fk" FOREIGN KEY ("rater_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_ratings_order_key" ON "app"."order_ratings" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_ratings_seller_idx" ON "app"."order_ratings" USING btree ("seller_id","created_at" DESC NULLS LAST);--> statement-breakpoint

ALTER TABLE "app"."order_ratings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."order_ratings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Public, on purpose: reputation is for the person deciding whether to buy, who is not a party
-- to the order being rated. The *rater* is not published; that is the query layer's job and
-- `listSellerRatings` does not select the column.
CREATE POLICY order_ratings_select_all ON "app"."order_ratings"
  FOR SELECT TO app_web
  USING (true);--> statement-breakpoint

CREATE POLICY order_ratings_select_public ON "app"."order_ratings"
  FOR SELECT TO app_readonly
  USING (true);--> statement-breakpoint

-- The four conditions, together. Each one is a way this gets gamed if it is left to a route.
CREATE POLICY order_ratings_insert_buyer ON "app"."order_ratings"
  FOR INSERT TO app_web
  WITH CHECK (
    rater_id = current_setting('app.user_id', true)
    AND EXISTS (
      SELECT 1 FROM "app"."orders" o
       WHERE o.id = order_id
         AND o.buyer_id = current_setting('app.user_id', true)
         AND o.seller_id = "order_ratings".seller_id
         AND o.status = 'completed'
    )
  );--> statement-breakpoint

-- Changing your mind is allowed; changing whose rating it is, or which order it belongs to, is
-- not. The WITH CHECK repeats the ownership test because USING decides which rows may change
-- and WITH CHECK decides what they may become.
CREATE POLICY order_ratings_update_own ON "app"."order_ratings"
  FOR UPDATE TO app_web
  USING (rater_id = current_setting('app.user_id', true))
  WITH CHECK (rater_id = current_setting('app.user_id', true));--> statement-breakpoint

REVOKE ALL ON "app"."order_ratings" FROM PUBLIC, app_web, app_worker, app_readonly;--> statement-breakpoint
GRANT SELECT ON "app"."order_ratings" TO app_web;--> statement-breakpoint
GRANT SELECT ON "app"."order_ratings" TO app_readonly;--> statement-breakpoint

-- Column-level, the same control the rest of Phase 5 uses. A rater says which order, which
-- seller, how many stars and what they thought. They do not get to say who left it — `rater_id`
-- is in the INSERT grant because the policy pins it to the session, and is absent from UPDATE
-- so a rating cannot be reassigned afterwards.
GRANT INSERT (order_id, seller_id, rater_id, stars, comment)
  ON "app"."order_ratings" TO app_web;--> statement-breakpoint
GRANT UPDATE (stars, comment, updated_at) ON "app"."order_ratings" TO app_web;--> statement-breakpoint

-- No DELETE for anybody. A seller cannot make a bad review disappear, and neither can we
-- without leaving the row behind — which is the only version of a review system worth having.
-- Moderating one is a separate, audited action, and it is not this migration's business.
GRANT SELECT ON "app"."order_ratings" TO app_worker;
