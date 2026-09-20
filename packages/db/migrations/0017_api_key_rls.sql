-- Self-serve API keys: row and column privileges (FR-3.7, SR-3.1, SR-X.8).
--
-- Two kinds of key share this table, and the difference is the whole point of these rules:
-- the scanner's first-party key has no owner and is issued at the CLI, while a self-serve key
-- belongs to the account that made it and may only ever read.
--
-- RLS is ENABLED but not FORCED: the CLI runs as the table owner and legitimately creates
-- keys that belong to nobody, which no session may do. Forcing policies onto the owner would
-- not add protection, it would mean the scanner could never be issued a credential.
ALTER TABLE "app"."api_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- A session sees its own keys and nothing else. NULL = owner_id is never true, so an
-- un-scoped connection sees none at all -- including every first-party key.
CREATE POLICY api_keys_select_own ON "app"."api_keys"
  FOR SELECT
  TO app_web
  USING (owner_id = current_setting('app.user_id', true));
--> statement-breakpoint

-- A forged owner_id in the payload fails here, and so does an attempt to mint a key that
-- can write. The same rule is a CHECK constraint on the table: one of them is the control,
-- the other is the proof that the control cannot be bypassed by a different code path.
CREATE POLICY api_keys_insert_own ON "app"."api_keys"
  FOR INSERT
  TO app_web
  WITH CHECK (
    owner_id = current_setting('app.user_id', true)
    AND NOT ('ingest:write' = ANY(scopes))
  );
--> statement-breakpoint

-- Revoking is an UPDATE of revoked_at; the column grant below is what limits it to that.
CREATE POLICY api_keys_update_own ON "app"."api_keys"
  FOR UPDATE
  TO app_web
  USING (owner_id = current_setting('app.user_id', true))
  WITH CHECK (owner_id = current_setting('app.user_id', true));
--> statement-breakpoint

-- Verifying a presented key means reading the hash of whichever row it claims to be, so the
-- role that authenticates requests can read every row. It is the only role that can.
CREATE POLICY api_keys_verify ON "app"."api_keys"
  FOR SELECT
  TO app_worker
  USING (true);
--> statement-breakpoint
CREATE POLICY api_keys_touch ON "app"."api_keys"
  FOR UPDATE
  TO app_worker
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint

-- Column privileges, which are the part worth reading twice.
--
-- **app_web can never SELECT key_hash.** It writes one at creation and can never read one
-- back, so a SQL-injection bug or a careless join in the web tier cannot exfiltrate the
-- material that would let someone forge a key. The web tier has no legitimate reason to read
-- it: verification happens on the worker role.
REVOKE ALL ON "app"."api_keys" FROM app_web;
--> statement-breakpoint
GRANT SELECT (id, owner_id, name, prefix, scopes, tier, last_used_at, revoked_at, created_at)
  ON "app"."api_keys" TO app_web;
--> statement-breakpoint
-- INSERT is granted on the whole table, not a column list: the ORM names every column and
-- passes DEFAULT for the ones it is not setting, so a narrow grant fails on `id`. The
-- control that matters is the SELECT list above -- being able to write a hash you can never
-- read back is exactly the asymmetry we want.
GRANT INSERT ON "app"."api_keys" TO app_web;
--> statement-breakpoint
GRANT UPDATE (revoked_at) ON "app"."api_keys" TO app_web;
--> statement-breakpoint

-- The worker verifies keys, so it reads everything -- but it may only ever write the "last
-- used" stamp. A compromised worker cannot re-scope a key or un-revoke one.
REVOKE UPDATE ON "app"."api_keys" FROM app_worker;
--> statement-breakpoint
GRANT UPDATE (last_used_at) ON "app"."api_keys" TO app_worker;
--> statement-breakpoint

-- The public read-only role serves catalog and price data. It has no business reading
-- credentials, and saying so costs nothing.
REVOKE ALL ON "app"."api_keys" FROM app_readonly;
