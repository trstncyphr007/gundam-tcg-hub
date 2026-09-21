CREATE TABLE "app"."pull_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"break_pull_id" uuid NOT NULL,
	"offset_seconds" integer NOT NULL,
	"vod_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_evidence_break_pull_id_unique" UNIQUE("break_pull_id"),
	CONSTRAINT "pull_evidence_offset_range" CHECK ("app"."pull_evidence"."offset_seconds" between 0 and 86400),
	CONSTRAINT "pull_evidence_vod_url_https" CHECK ("app"."pull_evidence"."vod_url" is null or "app"."pull_evidence"."vod_url" like 'https://%')
);
--> statement-breakpoint
ALTER TABLE "app"."breaks" ADD COLUMN "vod_url" text;--> statement-breakpoint
ALTER TABLE "app"."pull_evidence" ADD CONSTRAINT "pull_evidence_break_pull_id_break_pulls_id_fk" FOREIGN KEY ("break_pull_id") REFERENCES "app"."break_pulls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pull_evidence_pull_key" ON "app"."pull_evidence" USING btree ("break_pull_id");--> statement-breakpoint
ALTER TABLE "app"."breaks" ADD CONSTRAINT "breaks_vod_url_https" CHECK ("app"."breaks"."vod_url" is null or "app"."breaks"."vod_url" like 'https://%');