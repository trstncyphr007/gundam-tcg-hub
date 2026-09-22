-- Retention for the rows nobody deletes by hand (SR-X.21, SR-X.23, SR-X.24).
--
-- Three kinds of row outlive their purpose and nothing removes them today:
--
--   * `audit_log` entries. Kept for a year by the plan, and append-only by migration 0001 —
--     which means no application role can prune them either.
--   * expired `sessions` and `verifications`. A session row past `expires_at` cannot be used
--     to sign in, but still carries that day's IP hash and a user-agent string. A used or
--     lapsed magic-link row still carries its token hash.
--   * `sign_in_devices` nobody has signed in from for a year. The table exists to answer "is
--     this device new?"; a device not seen in a year is new again, and the whole row is
--     personal data being kept for a question nobody is asking.
--
-- All three are done here rather than in the application, for two reasons.
--
-- **Append-only has to keep meaning.** The point of 0001 is that the application cannot
-- rewrite history. Granting DELETE on `audit_log` to a role the application uses would undo
-- that for the sake of a nightly job. So the deletion lives in one function the worker may
-- call and cannot steer.
--
-- **The retention period is a control, not a parameter.** The function takes no arguments.
-- A caller — including a compromised worker — cannot ask it to prune "everything up to now"
-- and erase the evidence of what it just did. Changing a period means a migration and a
-- review, which is the right amount of friction for a deletion schedule.
--
-- Everything deleted here is already dead: a session that cannot authenticate, a token that
-- cannot be redeemed, a device that would be treated as new anyway, an audit entry past the
-- retention the policy publishes. Pruning a device row fails safe — the next sign-in from it
-- is announced as new, rather than silently accepted.
-- `sign_in_devices` forces row-level security, so even the role the function below runs as is
-- subject to its policies, and the table has no DELETE policy at all. Rather than exempt that
-- role, give it two policies that *are* the retention rule: it may see and delete a device
-- row only once the row is past the period. The floor then lives on the table, where it holds
-- for the function, for a migration run by hand, and for anything else that ever gets DELETE.
--
-- This matters because of what the table is for (ADR-026): deleting a recent device row is how
-- someone would suppress the "new device" email announcing their own sign-in.
--
-- Two policies, not one, because `DELETE ... WHERE` has to *read* the rows it deletes, and
-- that read goes through the SELECT policies. With only a DELETE policy the sweep matches
-- nothing and reports success — a retention job that quietly deletes zero rows for ever.
--
-- Both are scoped `TO app_migrator`, the role that owns the schema and runs the function.
-- Written without that clause they would widen the SELECT policy for `app_web` as well, and
-- one account could then read another account's old devices.
CREATE POLICY sign_in_devices_retention_select ON "app"."sign_in_devices"
  FOR SELECT TO app_migrator
  USING (last_seen_at < now() - interval '365 days');
--> statement-breakpoint
CREATE POLICY sign_in_devices_retention_delete ON "app"."sign_in_devices"
  FOR DELETE TO app_migrator
  USING (last_seen_at < now() - interval '365 days');
--> statement-breakpoint

CREATE FUNCTION app.run_retention()
  RETURNS TABLE (what text, deleted bigint)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_audit_cutoff CONSTANT timestamptz := now() - interval '365 days';
  v_count bigint;
BEGIN
  -- Sessions that expired more than a day ago. The day of slack is deliberate: a session is
  -- refreshed on use, and a job that deletes rows the moment they lapse would race with a
  -- browser mid-refresh for no benefit.
  DELETE FROM app.sessions WHERE expires_at < now() - interval '1 day';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  what := 'expired_sessions'; deleted := v_count; RETURN NEXT;

  -- Magic-link and verification tokens, same reasoning. Single-use already, and hashed.
  DELETE FROM app.verifications WHERE expires_at < now() - interval '1 day';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  what := 'expired_verifications'; deleted := v_count; RETURN NEXT;

  DELETE FROM app.sign_in_devices WHERE last_seen_at < now() - interval '365 days';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  what := 'stale_devices'; deleted := v_count; RETURN NEXT;

  DELETE FROM app.audit_log WHERE at < v_audit_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  what := 'audit_entries'; deleted := v_count; RETURN NEXT;

  -- The prune leaves a footprint in the log it pruned. History that can be shortened silently
  -- is history that can be shortened; this row says how much went, and how far back.
  IF v_count > 0 THEN
    INSERT INTO app.audit_log (actor_id, action, target_type, target_id, diff)
    VALUES (NULL, 'audit_log.pruned', 'audit_log', NULL,
            jsonb_build_object('deleted', v_count, 'before', v_audit_cutoff));
  END IF;

  RETURN;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.run_retention() FROM PUBLIC;
--> statement-breakpoint
-- The worker runs the nightly retention command, and is the only caller.
GRANT EXECUTE ON FUNCTION app.run_retention() TO app_worker;
