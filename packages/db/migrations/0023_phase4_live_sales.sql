CREATE TABLE "app"."live_sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" text NOT NULL,
	"card_variant_id" uuid,
	"label" text,
	"condition" "app"."card_condition" DEFAULT 'nm' NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"sold_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stream_ref" text,
	"buyer_handle_encrypted" text,
	"has_buyer_handle" boolean DEFAULT false NOT NULL,
	"price_observation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_sales_price_observation_id_unique" UNIQUE("price_observation_id"),
	CONSTRAINT "live_sales_price_non_negative" CHECK ("app"."live_sales"."price_cents" >= 0),
	CONSTRAINT "live_sales_price_sane" CHECK ("app"."live_sales"."price_cents" <= 100000000),
	CONSTRAINT "live_sales_currency_iso" CHECK ("app"."live_sales"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "live_sales_identified" CHECK ("app"."live_sales"."card_variant_id" is not null or length(btrim(coalesce("app"."live_sales"."label", ''))) > 0),
	CONSTRAINT "live_sales_handle_encrypted" CHECK ("app"."live_sales"."buyer_handle_encrypted" is null or "app"."live_sales"."buyer_handle_encrypted" ~ '^v1:'),
	CONSTRAINT "live_sales_handle_flag_matches" CHECK ("app"."live_sales"."has_buyer_handle" = ("app"."live_sales"."buyer_handle_encrypted" is not null)),
	CONSTRAINT "live_sales_stream_ref_https" CHECK ("app"."live_sales"."stream_ref" is null or "app"."live_sales"."stream_ref" like 'https://%')
);
--> statement-breakpoint
ALTER TABLE "app"."live_sales" ADD CONSTRAINT "live_sales_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."live_sales" ADD CONSTRAINT "live_sales_card_variant_id_card_variants_id_fk" FOREIGN KEY ("card_variant_id") REFERENCES "app"."card_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."live_sales" ADD CONSTRAINT "live_sales_price_observation_id_price_observations_id_fk" FOREIGN KEY ("price_observation_id") REFERENCES "app"."price_observations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "live_sales_seller_sold_idx" ON "app"."live_sales" USING btree ("seller_id","sold_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "live_sales_pending_idx" ON "app"."live_sales" USING btree ("price_observation_id") WHERE "app"."live_sales"."price_observation_id" is null;--> statement-breakpoint
CREATE INDEX "live_sales_handle_retention_idx" ON "app"."live_sales" USING btree ("sold_at") WHERE "app"."live_sales"."has_buyer_handle";