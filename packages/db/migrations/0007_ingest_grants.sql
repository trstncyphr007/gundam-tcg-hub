-- Least privilege for the ingestion/alerting tables (plan §7 "DB roles").

-- API keys are machine credentials: only the worker (which authenticates the scanner)
-- may read them, and nobody but the migrator/admin CLI may write them.
REVOKE ALL ON "app"."api_keys" FROM app_web, app_readonly;
--> statement-breakpoint
REVOKE INSERT, DELETE ON "app"."api_keys" FROM app_worker;
--> statement-breakpoint
-- The worker updates last_used_at only.
GRANT SELECT, UPDATE ON "app"."api_keys" TO app_worker;
--> statement-breakpoint

-- Restock history is append-only: corrections are new rows, never edits.
REVOKE UPDATE, DELETE ON "app"."restock_events" FROM app_web, app_worker;
--> statement-breakpoint
REVOKE INSERT ON "app"."restock_events" FROM app_web;
--> statement-breakpoint

-- Delivery records: the worker creates and updates them; the web tier only reads
-- (so a user can see their own alert history later).
REVOKE INSERT, UPDATE, DELETE ON "app"."alert_deliveries" FROM app_web;
--> statement-breakpoint
REVOKE DELETE ON "app"."alert_deliveries" FROM app_worker;
--> statement-breakpoint

-- Auth tables are owned by the web tier. The worker only needs the email address to
-- deliver an alert, and must never modify identities.
REVOKE INSERT, UPDATE, DELETE ON
  "app"."users", "app"."sessions", "app"."accounts", "app"."verifications"
  FROM app_worker;
--> statement-breakpoint
-- Session tokens and OAuth material must not be readable by the public read-only role.
REVOKE ALL ON "app"."sessions", "app"."accounts", "app"."verifications" FROM app_readonly;
--> statement-breakpoint
REVOKE ALL ON "app"."users" FROM app_readonly;
