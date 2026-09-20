CREATE TYPE "app"."api_key_tier" AS ENUM('free');--> statement-breakpoint
ALTER TYPE "app"."api_key_scope" ADD VALUE 'prices:read';--> statement-breakpoint
ALTER TABLE "app"."api_keys" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "app"."api_keys" ADD COLUMN "tier" "app"."api_key_tier" DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."api_keys" ADD CONSTRAINT "api_keys_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_owner_idx" ON "app"."api_keys" USING btree ("owner_id");--> statement-breakpoint
ALTER TABLE "app"."api_keys" ADD CONSTRAINT "api_keys_name_not_blank" CHECK (length(btrim("app"."api_keys"."name")) > 0);--> statement-breakpoint
ALTER TABLE "app"."api_keys" ADD CONSTRAINT "api_keys_name_length" CHECK (length("app"."api_keys"."name") <= 60);--> statement-breakpoint
ALTER TABLE "app"."api_keys" ADD CONSTRAINT "api_keys_owned_keys_are_read_only" CHECK ("app"."api_keys"."owner_id" is null or not ('ingest:write' = any("app"."api_keys"."scopes")));