-- Deleting an account, as one privileged step the web tier can ask for but not improvise
-- (SR-X.25, ADR-027).
--
-- Deleting a person means two different things for two kinds of row:
--
--   * rows that were only theirs go: every table that belongs to a person references `users`
--     with ON DELETE CASCADE, and foreign-key actions run as the table owner, so the cascade
--     reaches FORCE'd tables no application role could delete from directly;
--   * rows that became public stay, anonymised: an *approved* price report is part of the
--     published record, and the foreign key's SET NULL erases the reporter from it.
--
-- Price reports that were never approved — pending or rejected — are neither. They were the
-- person's own unpublished submissions, so they go too. But the web role must not be able to
-- delete price observations in general: a live account could then wipe its rejection history,
-- which is what reputation weighting reads (SR-3.5). So that deletion lives here, reachable
-- only as part of deleting the whole account.
--
-- The function also requires that the transaction has declared the account it deletes. The
-- route declares it from the session; a caller that has not said who it is acting for gets
-- nothing, rather than whatever id it passed.
CREATE FUNCTION app.delete_account(p_user_id text) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_email text;
BEGIN
  IF p_user_id IS NULL OR p_user_id IS DISTINCT FROM current_setting('app.user_id', true) THEN
    RAISE EXCEPTION 'delete_account: the transaction must declare the account it deletes'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM app.price_observations
   WHERE source = 'user_report'
     AND reporter_id = p_user_id
     AND approved_at IS NULL;

  DELETE FROM app.users WHERE id = p_user_id RETURNING email INTO v_email;
  RETURN v_email;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.delete_account(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.delete_account(text) TO app_web;
--> statement-breakpoint

-- And the plain statement is no longer needed by anything: the function above is now the only
-- way the web tier deletes a person, which is the point.
REVOKE DELETE ON "app"."users" FROM app_web;
