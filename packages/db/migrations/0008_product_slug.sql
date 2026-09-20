-- Expand/contract: add the column nullable, backfill existing rows, then enforce NOT NULL.
-- Adding a NOT NULL column with no default fails outright on a table that already has rows.
ALTER TABLE "app"."sealed_products" ADD COLUMN "slug" text;
--> statement-breakpoint
UPDATE "app"."sealed_products"
   SET "slug" = 'legacy-' || substr(replace("id"::text, '-', ''), 1, 12)
 WHERE "slug" IS NULL;
--> statement-breakpoint
ALTER TABLE "app"."sealed_products" ALTER COLUMN "slug" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "sealed_products_slug_key" ON "app"."sealed_products" USING btree ("slug");
--> statement-breakpoint
ALTER TABLE "app"."sealed_products" ADD CONSTRAINT "sealed_products_slug_format" CHECK ("app"."sealed_products"."slug" ~ '^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$');
