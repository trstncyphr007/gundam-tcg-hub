CREATE TABLE "app"."creator_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"bio" text,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creator_profiles_handle_format" CHECK ("app"."creator_profiles"."handle" ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'),
	CONSTRAINT "creator_profiles_display_name_length" CHECK (length(btrim("app"."creator_profiles"."display_name")) between 1 and 60),
	CONSTRAINT "creator_profiles_bio_length" CHECK ("app"."creator_profiles"."bio" is null or length("app"."creator_profiles"."bio") <= 280)
);
--> statement-breakpoint
CREATE TABLE "app"."pack_odds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sealed_product_id" uuid NOT NULL,
	"rarity" text NOT NULL,
	"numerator" integer NOT NULL,
	"denominator" integer NOT NULL,
	"source_url" text NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pack_odds_denominator_positive" CHECK ("app"."pack_odds"."denominator" >= 1),
	CONSTRAINT "pack_odds_numerator_range" CHECK ("app"."pack_odds"."numerator" between 1 and "app"."pack_odds"."denominator"),
	CONSTRAINT "pack_odds_source_https" CHECK ("app"."pack_odds"."source_url" like 'https://%')
);
--> statement-breakpoint
ALTER TABLE "app"."breaks" ADD COLUMN "packs_opened" integer;--> statement-breakpoint
ALTER TABLE "app"."creator_profiles" ADD CONSTRAINT "creator_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pack_odds" ADD CONSTRAINT "pack_odds_sealed_product_id_sealed_products_id_fk" FOREIGN KEY ("sealed_product_id") REFERENCES "app"."sealed_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "creator_profiles_user_key" ON "app"."creator_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "creator_profiles_handle_key" ON "app"."creator_profiles" USING btree ("handle");--> statement-breakpoint
CREATE UNIQUE INDEX "pack_odds_product_rarity_key" ON "app"."pack_odds" USING btree ("sealed_product_id","rarity");--> statement-breakpoint
CREATE INDEX "pack_odds_product_idx" ON "app"."pack_odds" USING btree ("sealed_product_id");--> statement-breakpoint
ALTER TABLE "app"."breaks" ADD CONSTRAINT "breaks_packs_opened_range" CHECK ("app"."breaks"."packs_opened" is null or "app"."breaks"."packs_opened" between 1 and 5000);