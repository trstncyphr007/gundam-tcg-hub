CREATE TYPE "app"."alert_channel" AS ENUM('email', 'discord_dm', 'discord_webhook', 'web_push');--> statement-breakpoint
CREATE TABLE "app"."watch_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"sealed_product_id" uuid,
	"retailer_product_id" uuid,
	"channels" "app"."alert_channel"[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_subscriptions_exactly_one_target" CHECK (("app"."watch_subscriptions"."sealed_product_id" is null) <> ("app"."watch_subscriptions"."retailer_product_id" is null)),
	CONSTRAINT "watch_subscriptions_channels_not_empty" CHECK (array_length("app"."watch_subscriptions"."channels", 1) >= 1)
);
--> statement-breakpoint
ALTER TABLE "app"."watch_subscriptions" ADD CONSTRAINT "watch_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."watch_subscriptions" ADD CONSTRAINT "watch_subscriptions_sealed_product_id_sealed_products_id_fk" FOREIGN KEY ("sealed_product_id") REFERENCES "app"."sealed_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."watch_subscriptions" ADD CONSTRAINT "watch_subscriptions_retailer_product_id_retailer_products_id_fk" FOREIGN KEY ("retailer_product_id") REFERENCES "app"."retailer_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "watch_subscriptions_user_idx" ON "app"."watch_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "watch_subscriptions_user_product_key" ON "app"."watch_subscriptions" USING btree ("user_id","sealed_product_id") WHERE "app"."watch_subscriptions"."sealed_product_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "watch_subscriptions_user_listing_key" ON "app"."watch_subscriptions" USING btree ("user_id","retailer_product_id") WHERE "app"."watch_subscriptions"."retailer_product_id" is not null;