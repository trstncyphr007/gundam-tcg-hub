CREATE SCHEMA IF NOT EXISTS "app";
--> statement-breakpoint
CREATE TYPE "app"."card_finish" AS ENUM('normal', 'parallel', 'alt_art', 'promo');--> statement-breakpoint
CREATE TYPE "app"."card_language" AS ENUM('en', 'ja');--> statement-breakpoint
CREATE TYPE "app"."sealed_kind" AS ENUM('booster_box', 'booster_pack', 'starter_deck', 'case', 'bundle', 'accessory');--> statement-breakpoint
CREATE TABLE "app"."card_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"finish" "app"."card_finish" DEFAULT 'normal' NOT NULL,
	"language" "app"."card_language" DEFAULT 'en' NOT NULL,
	"image_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"set_id" uuid NOT NULL,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"card_type" text,
	"color" text,
	"rarity" text,
	"text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "games_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "app"."retailer_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"retailer_id" uuid NOT NULL,
	"sealed_product_id" uuid NOT NULL,
	"url" text NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retailer_products_url_https" CHECK ("app"."retailer_products"."url" like 'https://%')
);
--> statement-breakpoint
CREATE TABLE "app"."retailers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"adapter_key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"robots_ok" boolean DEFAULT false NOT NULL,
	"tos_reviewed_at" timestamp with time zone,
	"min_interval_s" integer DEFAULT 900 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retailers_domain_unique" UNIQUE("domain"),
	CONSTRAINT "retailers_enabled_requires_review" CHECK (not "app"."retailers"."enabled" or ("app"."retailers"."tos_reviewed_at" is not null and "app"."retailers"."robots_ok")),
	CONSTRAINT "retailers_min_interval_positive" CHECK ("app"."retailers"."min_interval_s" >= 60)
);
--> statement-breakpoint
CREATE TABLE "app"."sealed_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"set_id" uuid,
	"kind" "app"."sealed_kind" NOT NULL,
	"name" text NOT NULL,
	"upc" text,
	"msrp_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sealed_products_msrp_nonneg" CHECK ("app"."sealed_products"."msrp_cents" is null or "app"."sealed_products"."msrp_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"release_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."stock_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"retailer_product_id" uuid NOT NULL,
	"in_stock" boolean NOT NULL,
	"price_cents" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"raw_hash" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_snapshots_price_nonneg" CHECK ("app"."stock_snapshots"."price_cents" is null or "app"."stock_snapshots"."price_cents" >= 0),
	CONSTRAINT "stock_snapshots_currency_iso" CHECK ("app"."stock_snapshots"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "app"."audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"ip_hash" text,
	"ua_hash" text,
	"diff" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."card_variants" ADD CONSTRAINT "card_variants_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "app"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."cards" ADD CONSTRAINT "cards_set_id_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "app"."sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."retailer_products" ADD CONSTRAINT "retailer_products_retailer_id_retailers_id_fk" FOREIGN KEY ("retailer_id") REFERENCES "app"."retailers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."retailer_products" ADD CONSTRAINT "retailer_products_sealed_product_id_sealed_products_id_fk" FOREIGN KEY ("sealed_product_id") REFERENCES "app"."sealed_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sealed_products" ADD CONSTRAINT "sealed_products_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "app"."games"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sealed_products" ADD CONSTRAINT "sealed_products_set_id_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "app"."sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sets" ADD CONSTRAINT "sets_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "app"."games"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_snapshots" ADD CONSTRAINT "stock_snapshots_retailer_product_id_retailer_products_id_fk" FOREIGN KEY ("retailer_product_id") REFERENCES "app"."retailer_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "card_variants_card_finish_lang_key" ON "app"."card_variants" USING btree ("card_id","finish","language");--> statement-breakpoint
CREATE UNIQUE INDEX "cards_set_number_key" ON "app"."cards" USING btree ("set_id","number");--> statement-breakpoint
CREATE INDEX "cards_name_trgm_idx" ON "app"."cards" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "retailer_products_retailer_url_key" ON "app"."retailer_products" USING btree ("retailer_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX "sealed_products_game_name_key" ON "app"."sealed_products" USING btree ("game_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "sets_game_code_key" ON "app"."sets" USING btree ("game_id","code");--> statement-breakpoint
CREATE INDEX "stock_snapshots_product_checked_idx" ON "app"."stock_snapshots" USING btree ("retailer_product_id","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "app"."audit_log" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "app"."audit_log" USING btree ("actor_id");