CREATE TYPE "app"."collection_visibility" AS ENUM('private', 'unlisted', 'public');--> statement-breakpoint
CREATE TABLE "app"."collection_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"card_variant_id" uuid NOT NULL,
	"condition" "app"."card_condition" DEFAULT 'nm' NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"acquired_price_cents" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"acquired_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_items_quantity_positive" CHECK ("app"."collection_items"."quantity" >= 1),
	CONSTRAINT "collection_items_quantity_sane" CHECK ("app"."collection_items"."quantity" <= 100000),
	CONSTRAINT "collection_items_price_non_negative" CHECK ("app"."collection_items"."acquired_price_cents" is null or "app"."collection_items"."acquired_price_cents" >= 0),
	CONSTRAINT "collection_items_notes_length" CHECK ("app"."collection_items"."notes" is null or length("app"."collection_items"."notes") <= 500),
	CONSTRAINT "collection_items_currency_iso" CHECK ("app"."collection_items"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "app"."collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"visibility" "app"."collection_visibility" DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collections_name_not_blank" CHECK (length(btrim("app"."collections"."name")) > 0),
	CONSTRAINT "collections_name_length" CHECK (length("app"."collections"."name") <= 80)
);
--> statement-breakpoint
ALTER TABLE "app"."collection_items" ADD CONSTRAINT "collection_items_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "app"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."collection_items" ADD CONSTRAINT "collection_items_card_variant_id_card_variants_id_fk" FOREIGN KEY ("card_variant_id") REFERENCES "app"."card_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."collections" ADD CONSTRAINT "collections_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_items_collection_idx" ON "app"."collection_items" USING btree ("collection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_items_unique_line" ON "app"."collection_items" USING btree ("collection_id","card_variant_id","condition");--> statement-breakpoint
CREATE INDEX "collections_owner_idx" ON "app"."collections" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "collections_public_idx" ON "app"."collections" USING btree ("visibility") WHERE "app"."collections"."visibility" = 'public';