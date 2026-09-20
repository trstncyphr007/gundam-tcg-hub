CREATE TYPE "app"."pull_value_source" AS ENUM('manual', 'index');--> statement-breakpoint
ALTER TABLE "app"."break_pulls" ADD COLUMN "value_source" "app"."pull_value_source" DEFAULT 'manual' NOT NULL;