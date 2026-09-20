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

## Why expand/contract matters

Migrations are written as expand/contract — add nullable, backfill, then constrain — so the
previous release keeps working against the new schema. That is what makes a rollback a code
change rather than a restore.

Every time a migration is written the other way, this runbook becomes the only way out.
