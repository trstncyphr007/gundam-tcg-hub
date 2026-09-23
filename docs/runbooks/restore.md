# Runbook: Restore

Two different situations get called "restore". They need different things, so decide which
one you are in before touching anything.

| Situation                                                            | Go to                                                      |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| The host is gone, the disk failed, data was destroyed or encrypted   | [`backups.md`](backups.md) — full restore and host rebuild |
| A deploy or migration left the schema in a state the code cannot use | **this document**                                          |

`backups.md` is the canonical disaster-recovery document and holds the restic commands, the
monthly drill and the full-host rebuild. This one covers the narrower, more likely case.

---

## A migration failed halfway

`deploy.sh` runs migrations as a one-off container **before** swapping images, so the usual
outcome is: migration failed, nothing was swapped, the previous release is still serving.
That is the good case.

### 1. Find out what actually applied

```bash
ssh deploy@<vps>
sudo docker compose -p gth-production --profile migrate run --rm \
  --entrypoint psql migrator "$DATABASE_URL_MIGRATOR" \
  -c 'select * from drizzle.__drizzle_migrations order by created_at desc limit 5;'
```

Compare against `packages/db/migrations/meta/_journal.json`. Drizzle records each migration
as it completes, so the last recorded one is the last that finished.

A migration file can contain several statements separated by `--> statement-breakpoint`.
Postgres runs each in its own transaction, so a file can be **partly** applied. Check the
actual schema, not just the journal:

```bash
\d app.<table>
```

### 2. Decide: forward or back

**Prefer forward.** A corrective migration that finishes the job is usually safer than
undoing one, because the undo has to be written under pressure and has no test behind it.

Roll back the schema only if the half-applied change makes the old code unusable _and_ the
data is intact.

### 3. If you must undo

```bash
# Take a dump FIRST. Always. It costs a minute.
sudo docker compose -p gth-production --profile migrate run --rm \
  --entrypoint pg_dump migrator -Fc "$DATABASE_URL_MIGRATOR" > /root/pre-undo.dump
```

Then apply the reversing statements by hand, and immediately write them into a proper
migration so the repository matches reality. A schema that only exists on the server is a
schema nobody can reproduce.

### 4. Verify before serving traffic

```bash
sudo docker compose -p gth-production ps
curl -sf https://<host>/v1/games > /dev/null && echo "catalog ok"
curl -sI https://<host>/v1/me | head -n 1     # expect 401
```

---

## Restoring data into a live system

If rows were lost or corrupted by a release, **do not restore the whole database over a
running system**. Between the backup and now there is real user activity — watches, breaks,
stock history — and a wholesale restore throws it away.

1. Restore the snapshot into a **scratch** database (`backups.md` has the commands)
2. Compare, and copy back only the affected rows
3. If the damage is too broad for that, it is an incident: go to
   [`incident.md`](incident.md) and make the data-loss call deliberately, with the window
   written down

---

## After any restore: re-apply account deletions

When someone deletes their account, we tell them it is gone (SR-X.25, ADR-027). A backup
taken before that still has them in it, so **every** restore — full host, scratch copy
promoted to live, anything — brings deleted people back unless this step is run. Backups
themselves age out on the retention schedule in `backups.md`; that is what bounds how long a
deleted account survives _in a backup_, and it is why a restore must not undo the deletion.

Every deletion leaves one row in the audit log, which is append-only and holds no email —
exactly enough to repeat the deletion and nothing more. There is a command for this:

```bash
# What it would do. --since is the timestamp of the dump you restored.
pnpm db:reapply-deletions --since 2026-09-20T03:00:00Z

# Do it.
pnpm db:reapply-deletions --since 2026-09-20T03:00:00Z --apply
```

**Dry run by default**, because during an incident the first thing anyone wants is to see what
a command will do before it does it. It prints a line per account and ends with how many were
re-applied and how many were not in the snapshot at all.

By default it reads the list of deletions from the database it is repairing. When the newer
audit log is somewhere else — the usual case, since the restored one predates the deletions —
point it there:

```bash
pnpm db:reapply-deletions --since <dump time> --audit-url "postgres://..." --apply
```

Each account goes out through `app.delete_account`, the same function the account page uses, so
the cascade, the unpublished reports and the anonymised ones are all handled. A hand-written
`DELETE` under pressure would do the first and forget the rest — which is why this used to be
four lines of SQL in this runbook and is now a command with tests.

Then record in the incident notes how many were re-applied. If the live audit log is lost
too, say so there — it is the one case where a deletion cannot be honoured automatically,
and it is worth knowing it happened.

---

## Why expand/contract matters

Migrations are written as expand/contract — add nullable, backfill, then constrain — so the
previous release keeps working against the new schema. That is what makes a rollback a code
change rather than a restore.

Every time a migration is written the other way, this runbook becomes the only way out.
