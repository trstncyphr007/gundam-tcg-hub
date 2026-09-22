-- Remembering what has already been said (SR-X.22).
--
-- The watchdog runs every quarter of an hour. Without memory it would repeat "the scanner has
-- stopped reporting" ninety-six times a day, and the ninety-seventh would be ignored along
-- with everything else in the channel. An alert nobody reads is worse than no alert, because
-- it is believed to be working.
--
-- One row per alert kind. `claim_ops_alert` below is the whole protocol: it returns true at
-- most once per interval for a key, and does it in a single statement, so two watchdog runs
-- that overlap cannot both decide they are the one that gets to speak.
CREATE TABLE "app"."ops_alert_state" (
  "key" text PRIMARY KEY,
  "last_sent_at" timestamptz NOT NULL,
  -- What was said, for an operator reading the table directly. Never part of the decision.
  "detail" text
);
--> statement-breakpoint

-- The one write the worker makes here. An UPDATE that only matches when the interval has
-- passed, falling back to an INSERT for a key nobody has seen: `ON CONFLICT DO UPDATE ...
-- WHERE` returns no row when the WHERE fails, which is exactly "somebody already said this".
CREATE FUNCTION app.claim_ops_alert(p_key text, p_interval_s integer, p_detail text)
  RETURNS boolean
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO app.ops_alert_state (key, last_sent_at, detail)
  VALUES (p_key, now(), p_detail)
  ON CONFLICT (key) DO UPDATE
    SET last_sent_at = now(), detail = excluded.detail
    WHERE app.ops_alert_state.last_sent_at < now() - make_interval(secs => p_interval_s)
  RETURNING true;
$$;
--> statement-breakpoint

REVOKE ALL ON "app"."ops_alert_state" FROM PUBLIC, app_web, app_worker, app_readonly;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.claim_ops_alert(text, integer, text) FROM PUBLIC;
--> statement-breakpoint
-- The watchdog runs as the worker, and reaches the table only through the function: it may
-- claim the right to speak, and cannot rewrite the history of what was already said.
GRANT EXECUTE ON FUNCTION app.claim_ops_alert(text, integer, text) TO app_worker;
--> statement-breakpoint
-- Reading it is useful ("what has been alerting lately?") and harmless: no personal data,
-- and the operations page is admin-only anyway.
GRANT SELECT ON "app"."ops_alert_state" TO app_web, app_worker;
