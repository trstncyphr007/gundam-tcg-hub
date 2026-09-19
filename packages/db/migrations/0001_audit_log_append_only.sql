-- Audit log is append-only (SR-X.21): the app roles may INSERT and SELECT, never UPDATE/DELETE.
-- Default privileges (init/01-roles.sh) grant full DML on new tables, so revoke here explicitly.
REVOKE UPDATE, DELETE, TRUNCATE ON "app"."audit_log" FROM app_web, app_worker;
--> statement-breakpoint
GRANT INSERT, SELECT ON "app"."audit_log" TO app_web, app_worker;
--> statement-breakpoint
-- Catalog is admin-managed: the worker ingests stock, it never edits reference data.
REVOKE INSERT, UPDATE, DELETE ON
  "app"."games", "app"."sets", "app"."cards", "app"."card_variants", "app"."sealed_products"
  FROM app_worker;
--> statement-breakpoint
-- Retailer configuration is admin-only; the worker reads it and writes snapshots.
REVOKE INSERT, UPDATE, DELETE ON "app"."retailers", "app"."retailer_products" FROM app_worker;
--> statement-breakpoint
-- Stock history is immutable: corrections are new rows.
REVOKE UPDATE, DELETE ON "app"."stock_snapshots" FROM app_web, app_worker;
--> statement-breakpoint
-- The web tier does not write stock data at all.
REVOKE INSERT ON "app"."stock_snapshots" FROM app_web;
