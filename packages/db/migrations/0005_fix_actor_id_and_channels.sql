ALTER TABLE "app"."watch_subscriptions" DROP CONSTRAINT "watch_subscriptions_channels_not_empty";--> statement-breakpoint
ALTER TABLE "app"."audit_log" ALTER COLUMN "actor_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "app"."watch_subscriptions" ADD CONSTRAINT "watch_subscriptions_channels_not_empty" CHECK (cardinality("app"."watch_subscriptions"."channels") >= 1);