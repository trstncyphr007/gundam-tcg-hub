-- IP addresses at rest become hashes (SR-X.24, ADR-028).
--
-- Sessions written before this hold the raw address. They cannot be hashed here: the hash is
-- keyed by a secret the database never sees, and by the day it was taken. So they are
-- cleared — the rule is to keep addresses only in a form that cannot be reversed, and the
-- nearest compliant form of an address we already hold is none at all. Sessions live 30 days
-- at most, so this only touches what is still current.
--
-- (Added by hand above drizzle-kit's generated statement: the constraint would refuse the
-- existing rows otherwise.)
UPDATE "app"."sessions" SET "ip_address" = NULL
 WHERE "ip_address" IS NOT NULL
   AND "ip_address" !~ '^iph1:[0-9]{4}-[0-9]{2}-[0-9]{2}:[A-Za-z0-9_-]{22}$';
--> statement-breakpoint
ALTER TABLE "app"."sessions" ADD CONSTRAINT "sessions_ip_hashed" CHECK ("app"."sessions"."ip_address" is null or "app"."sessions"."ip_address" ~ '^iph1:[0-9]{4}-[0-9]{2}-[0-9]{2}:[A-Za-z0-9_-]{22}$');
