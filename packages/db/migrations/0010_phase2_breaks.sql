CREATE TYPE "app"."break_status" AS ENUM('draft', 'live', 'ended');--> statement-breakpoint
CREATE TABLE "app"."break_pulls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"break_id" uuid NOT NULL,
	"card_variant_id" uuid,
	"label" text,
	"value_cents_at_pull" integer DEFAULT 0 NOT NULL,
	"seq" integer NOT NULL,
	"pulled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "break_pulls_seq_positive" CHECK ("app"."break_pulls"."seq" >= 1),
	CONSTRAINT "break_pulls_value_non_negative" CHECK ("app"."break_pulls"."value_cents_at_pull" >= 0),
	CONSTRAINT "break_pulls_identified" CHECK ("app"."break_pulls"."card_variant_id" is not null or length(btrim(coalesce("app"."break_pulls"."label", ''))) > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."breaks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" text NOT NULL,
	"title" text NOT NULL,
	"sealed_product_id" uuid,
	"cost_cents" integer,
	"status" "app"."break_status" DEFAULT 'draft' NOT NULL,
	"overlay_token_hash" text NOT NULL,
	"overlay_token_version" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "breaks_title_not_blank" CHECK (length(btrim("app"."breaks"."title")) > 0),
	CONSTRAINT "breaks_title_length" CHECK (length("app"."breaks"."title") <= 120),
	CONSTRAINT "breaks_cost_non_negative" CHECK ("app"."breaks"."cost_cents" is null or "app"."breaks"."cost_cents" >= 0),
	CONSTRAINT "breaks_timestamps_follow_status" CHECK (("app"."breaks"."status" = 'draft' and "app"."breaks"."started_at" is null and "app"."breaks"."ended_at" is null)
       or ("app"."breaks"."status" = 'live' and "app"."breaks"."started_at" is not null and "app"."breaks"."ended_at" is null)
       or ("app"."breaks"."status" = 'ended' and "app"."breaks"."started_at" is not null and "app"."breaks"."ended_at" is not null
           and "app"."breaks"."ended_at" >= "app"."breaks"."started_at"))
);
--> statement-breakpoint
ALTER TABLE "app"."break_pulls" ADD CONSTRAINT "break_pulls_break_id_breaks_id_fk" FOREIGN KEY ("break_id") REFERENCES "app"."breaks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."break_pulls" ADD CONSTRAINT "break_pulls_card_variant_id_card_variants_id_fk" FOREIGN KEY ("card_variant_id") REFERENCES "app"."card_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."breaks" ADD CONSTRAINT "breaks_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."breaks" ADD CONSTRAINT "breaks_sealed_product_id_sealed_products_id_fk" FOREIGN KEY ("sealed_product_id") REFERENCES "app"."sealed_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "break_pulls_break_idx" ON "app"."break_pulls" USING btree ("break_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "break_pulls_break_seq_key" ON "app"."break_pulls" USING btree ("break_id","seq");--> statement-breakpoint
CREATE INDEX "breaks_creator_idx" ON "app"."breaks" USING btree ("creator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "breaks_overlay_token_key" ON "app"."breaks" USING btree ("overlay_token_hash");