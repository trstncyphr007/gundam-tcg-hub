CREATE TABLE "app"."break_commitments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"break_id" uuid NOT NULL,
	"commitment" text NOT NULL,
	"server_seed_encrypted" text NOT NULL,
	"client_seed" text,
	"revealed_seed" text,
	"slot_count" integer NOT NULL,
	"algorithm_version" text NOT NULL,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revealed_at" timestamp with time zone,
	CONSTRAINT "break_commitments_slot_count" CHECK ("app"."break_commitments"."slot_count" between 2 and 1000),
	CONSTRAINT "break_commitments_commitment_hex" CHECK ("app"."break_commitments"."commitment" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "break_commitments_reveal_complete" CHECK (("app"."break_commitments"."revealed_seed" is null) = ("app"."break_commitments"."revealed_at" is null)),
	CONSTRAINT "break_commitments_client_seed_first" CHECK ("app"."break_commitments"."revealed_seed" is null or "app"."break_commitments"."client_seed" is not null)
);
--> statement-breakpoint
ALTER TABLE "app"."break_pulls" ADD COLUMN "prev_hash" text;--> statement-breakpoint
ALTER TABLE "app"."break_pulls" ADD COLUMN "row_hash" text;--> statement-breakpoint
ALTER TABLE "app"."break_commitments" ADD CONSTRAINT "break_commitments_break_id_breaks_id_fk" FOREIGN KEY ("break_id") REFERENCES "app"."breaks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "break_commitments_break_key" ON "app"."break_commitments" USING btree ("break_id");--> statement-breakpoint
ALTER TABLE "app"."break_pulls" ADD CONSTRAINT "break_pulls_chain_complete" CHECK (("app"."break_pulls"."prev_hash" is null) = ("app"."break_pulls"."row_hash" is null));