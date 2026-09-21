-- Passkeys: who may touch a credential (SR-X.3, SR-1.10, ADR-025).
--
-- Default privileges give every new table full DML to both app_web and app_worker. For this
-- one that is too much. Better Auth manages passkeys through the web pool, and nothing else
-- in the system has any reason to read or write a user's credentials — not the scanner
-- ingestion, not the alert worker, not the public read-only API.
--
-- Reading is not the dangerous part (a public key is public). Writing is: a row added here is
-- a new way into somebody's account. So the worker and read-only roles get nothing at all,
-- and a compromised worker cannot plant a credential for anyone.
REVOKE ALL ON "app"."passkeys" FROM app_worker, app_readonly;
--> statement-breakpoint

-- The web role keeps what the auth library needs: register (INSERT), list and verify (SELECT),
-- advance the signature counter (UPDATE counter), rename (UPDATE name), and remove (DELETE).
-- Column-level UPDATE, so nothing can rewrite a credential's public key, owner or id in place —
-- a changed key is a new credential, and has to be registered as one.
REVOKE UPDATE ON "app"."passkeys" FROM app_web;
--> statement-breakpoint
GRANT UPDATE (counter, name) ON "app"."passkeys" TO app_web;
