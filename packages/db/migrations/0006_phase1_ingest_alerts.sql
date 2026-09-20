CREATE TYPE "app"."api_key_scope" AS ENUM('ingest:write', 'catalog:read');--> statement-breakpoint
CREATE TYPE "app"."delivery_status" AS ENUM('pending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "app"."alert_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"channel" "app"."alert_channel" NOT NULL,
	"status" "app"."delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_deliveries_attempts_nonneg" CHECK ("app"."alert_deliveries"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" "app"."api_key_scope"[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_scopes_not_empty" CHECK (cardinality("app"."api_keys"."scopes") >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."restock_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"retailer_product_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"price_cents" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."alert_deliveries" ADD CONSTRAINT "alert_deliveries_event_id_restock_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "app"."restock_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."alert_deliveries" ADD CONSTRAINT "alert_deliveries_subscription_id_watch_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "app"."watch_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."restock_events" ADD CONSTRAINT "restock_events_retailer_product_id_retailer_products_id_fk" FOREIGN KEY ("retailer_product_id") REFERENCES "app"."retailer_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."restock_events" ADD CONSTRAINT "restock_events_snapshot_id_stock_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "app"."stock_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_deliveries_event_subscription_channel_key" ON "app"."alert_deliveries" USING btree ("event_id","subscription_id","channel");--> statement-breakpoint
CREATE INDEX "alert_deliveries_status_idx" ON "app"."alert_deliveries" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "app"."api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "restock_events_product_detected_idx" ON "app"."restock_events" USING btree ("retailer_product_id","detected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "restock_events_snapshot_key" ON "app"."restock_events" USING btree ("snapshot_id");