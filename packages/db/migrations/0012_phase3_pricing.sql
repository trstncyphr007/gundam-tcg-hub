CREATE TYPE "app"."card_condition" AS ENUM('nm', 'lp', 'mp', 'hp', 'dmg');--> statement-breakpoint
CREATE TYPE "app"."price_sale_type" AS ENUM('sold', 'listed');--> statement-breakpoint
CREATE TYPE "app"."price_source" AS ENUM('break_pull', 'live_sale', 'user_report', 'ebay_api', 'walmart_api');--> statement-breakpoint
CREATE TABLE "app"."price_index_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_variant_id" uuid NOT NULL,
	"condition" "app"."card_condition" NOT NULL,
	"day" date NOT NULL,
	"median_cents" integer NOT NULL,
	"p25_cents" integer NOT NULL,
	"p75_cents" integer NOT NULL,
	"low_cents" integer NOT NULL,
	"high_cents" integer NOT NULL,
	"observation_count" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_index_daily_ordered" CHECK ("app"."price_index_daily"."p25_cents" <= "app"."price_index_daily"."median_cents" and "app"."price_index_daily"."median_cents" <= "app"."price_index_daily"."p75_cents"),
	CONSTRAINT "price_index_daily_range" CHECK ("app"."price_index_daily"."low_cents" <= "app"."price_index_daily"."p25_cents" and "app"."price_index_daily"."p75_cents" <= "app"."price_index_daily"."high_cents"),
	CONSTRAINT "price_index_daily_min_observations" CHECK ("app"."price_index_daily"."observation_count" >= 3)
);
--> statement-breakpoint
CREATE TABLE "app"."price_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_variant_id" uuid NOT NULL,
	"source" "app"."price_source" NOT NULL,
	"sale_type" "app"."price_sale_type" DEFAULT 'sold' NOT NULL,
	"condition" "app"."card_condition" DEFAULT 'nm' NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence_ref" text,
	"reporter_id" text,
	"break_pull_id" uuid,
	"approved_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"flagged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_observations_price_non_negative" CHECK ("app"."price_observations"."price_cents" >= 0),
	CONSTRAINT "price_observations_price_sane" CHECK ("app"."price_observations"."price_cents" <= 100000000),
	CONSTRAINT "price_observations_currency_iso" CHECK ("app"."price_observations"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "price_observations_not_both_decisions" CHECK ("app"."price_observations"."approved_at" is null or "app"."price_observations"."rejected_at" is null),
	CONSTRAINT "price_observations_reporter_required" CHECK ("app"."price_observations"."source" <> 'user_report' or "app"."price_observations"."reporter_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "app"."price_index_daily" ADD CONSTRAINT "price_index_daily_card_variant_id_card_variants_id_fk" FOREIGN KEY ("card_variant_id") REFERENCES "app"."card_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."price_observations" ADD CONSTRAINT "price_observations_card_variant_id_card_variants_id_fk" FOREIGN KEY ("card_variant_id") REFERENCES "app"."card_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."price_observations" ADD CONSTRAINT "price_observations_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."price_observations" ADD CONSTRAINT "price_observations_break_pull_id_break_pulls_id_fk" FOREIGN KEY ("break_pull_id") REFERENCES "app"."break_pulls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "price_index_daily_key" ON "app"."price_index_daily" USING btree ("card_variant_id","condition","day","currency");--> statement-breakpoint
CREATE INDEX "price_index_daily_history_idx" ON "app"."price_index_daily" USING btree ("card_variant_id","day");--> statement-breakpoint
CREATE INDEX "price_observations_rollup_idx" ON "app"."price_observations" USING btree ("card_variant_id","condition","observed_at");--> statement-breakpoint
CREATE INDEX "price_observations_reporter_idx" ON "app"."price_observations" USING btree ("reporter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "price_observations_break_pull_key" ON "app"."price_observations" USING btree ("break_pull_id") WHERE "app"."price_observations"."break_pull_id" is not null;