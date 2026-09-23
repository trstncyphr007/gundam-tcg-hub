# Runbook: backups and restore

Plan reference: §21. Targets: **RPO ≤ 24h** (nightly dump), **RTO ≤ 4h**.
A backup that has never been restored is not a backup, so the drill below is the point of
this document.

## What is backed up

| Data                    | How                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------- |
| Postgres (all app data) | `pg_dump -Fc` nightly, inside the database container                               |
| ~~Valkey~~              | Gone (ADR-042). It held nothing; this row described counters it never stored       |
| Caddy certificates      | Volume included in the restic snapshot (cheap to re-issue, but avoids rate limits) |
| Everything else         | In git: compose files, Caddyfile, deploy script, encrypted secrets                 |

## Install (on the VPS, as root)

```bash
apt -y install restic
install -d -m 0700 /etc/gth
# Repository + credentials (Cloudflare R2 or Backblaze B2), mode 0400:
cat > /etc/gth/restic.env <<'ENV'
RESTIC_REPOSITORY=s3:https://<account>.r2.cloudflarestorage.com/gth-backups
RESTIC_PASSWORD=<generate: openssl rand -base64 32 — store in your password manager>
AWS_ACCESS_KEY_ID=<write-only key>
AWS_SECRET_ACCESS_KEY=<secret>
ENV
chmod 0400 /etc/gth/restic.env

# Where a failure is reported. Separate file, because it is not a restic credential and the
# job timers read it too (docs/runbooks/scheduled-jobs.md).
cat > /etc/gth/ops.env <<'ENV'
DISCORD_OPS_WEBHOOK_URL=https://discord.com/api/webhooks/...
ENV
chmod 0400 /etc/gth/ops.env

set -a; . /etc/gth/restic.env; set +a
restic init
```

**Do not skip `ops.env`.** Until ADR-036 the failure alert read the webhook only from
`restic.env`, which this template never contained — so a by-the-book install had an alert unit
that exited 0 every time and told nobody. A backup that fails silently is worse than no
backup, because it is believed.

**The backup credentials must not be able to delete.** Create a write-only key for the server
and keep a separate admin key offline for pruning, so ransomware on the VPS cannot wipe the
backups it can write to. Enable object lock/versioning on the bucket if available.

## Nightly job

`/usr/local/bin/gth-backup.sh` (0750, root):

Installed by Ansible (`roles/backups`); this is what it contains.

```bash
#!/usr/bin/env bash
set -euo pipefail
set -a; . /etc/gth/restic.env; set +a

# The database superuser is not a restic credential: it comes from the encrypted production
# secrets, decrypted to tmpfs for the length of this script. See "What went wrong" below.
install -d -m 0700 /run/gth
trap 'rm -f /run/gth/backup.env "${DUMP:-}"' EXIT
SOPS_AGE_KEY_FILE=/root/.config/sops/age/keys.txt \
  sops -d /srv/gth/production/secrets.sops.env > /run/gth/backup.env
PG_SUPERUSER=$(grep -E '^PG_SUPERUSER=' /run/gth/backup.env | cut -d= -f2-)

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DUMP=/var/backups/gth-${STAMP}.dump
install -d -m 0700 /var/backups

docker exec gth-production-postgres-1 \
  pg_dump -Fc -U "$PG_SUPERUSER" gth > "$DUMP"

restic backup --tag postgres "$DUMP"
restic forget --tag postgres --keep-daily 7 --keep-weekly 4 --keep-monthly 12
rm -f "$DUMP"
restic check --read-data-subset=5%
```

Schedule with systemd (not cron, so failures are visible in `systemctl status`):

```ini
# /etc/systemd/system/gth-backup.service
[Service]
Type=oneshot
ExecStart=/usr/local/bin/gth-backup.sh

# /etc/systemd/system/gth-backup.timer
[Timer]
OnCalendar=*-*-* 03:00:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
```

```bash
systemctl daemon-reload && systemctl enable --now gth-backup.timer
systemctl list-timers gth-backup
```

Alert on failure: the deploy/ops Discord webhook receives a message from an `OnFailure=` unit
(see §20 alerting).

## What went wrong (found 2026-09-23, fixed)

The script above used to read `$PG_SUPERUSER` straight from `/etc/gth/restic.env`, which has
never contained it — it is a database setting and lives in the encrypted production secrets.
With `set -u`, that meant **the nightly backup died on an unbound variable before dumping
anything**. Every night. For ever. The failure would at least have been audible since ADR-036,
but a host that had been "backing up" for a month would have had nothing to restore.

It is the same shape as the nightly jobs in ADR-036: a script that had never been run,
describing something that could not work. The fix decrypts the production secrets the same way
the job runner does, and the rehearsal below is how it stops being theoretical.

## Rehearse it here first

```bash
bash scripts/restore-drill.sh
```

Runs the whole cycle against the development stack: dump, back up, prune, verify the
repository, restore from it, load into a **scratch** database, and compare row counts with the
live one. The live database is only ever read.

It also checks something easy to miss: that the **row-level security policies and grants**
came back. A database restored without them looks perfectly healthy and leaks everything.

| Date       | Where       | Dump | Restore | Row counts | Policies / grants | Result     |
| ---------- | ----------- | ---- | ------- | ---------- | ----------------- | ---------- |
| 2026-09-23 | workstation | 0 s  | 2 s     | identical  | 53 / 91           | **PASSED** |

A workstation with three cards is not a server with real data — what this proves is that the
**procedure** works, not how long it takes with a real database.

## Restore drill on the server — run monthly, record the result here

```bash
set -a; . /etc/gth/restic.env; set +a
# PG_SUPERUSER comes from the production secrets, as in the backup script:
SOPS_AGE_KEY_FILE=/root/.config/sops/age/keys.txt \
  sops -d /srv/gth/production/secrets.sops.env > /run/gth/drill.env
PG_SUPERUSER=$(grep -E '^PG_SUPERUSER=' /run/gth/drill.env | cut -d= -f2-)
trap 'rm -f /run/gth/drill.env' EXIT
restic snapshots --tag postgres | tail -5
restic restore latest --target /tmp/restore

# Restore into a scratch database, never over the live one.
docker exec -i gth-production-postgres-1 createdb -U "$PG_SUPERUSER" gth_restore_test
docker exec -i gth-production-postgres-1 \
  pg_restore -U "$PG_SUPERUSER" -d gth_restore_test < /tmp/restore/var/backups/gth-*.dump

# Integrity checks: do the tables and row counts look right?
docker exec -i gth-production-postgres-1 psql -U "$PG_SUPERUSER" -d gth_restore_test -c \
  "select 'cards' t, count(*) from app.cards
   union all select 'users', count(*) from app.users
   union all select 'watches', count(*) from app.watch_subscriptions
   union all select 'events', count(*) from app.restock_events;"

docker exec -i gth-production-postgres-1 dropdb -U "$PG_SUPERUSER" gth_restore_test
rm -rf /tmp/restore
```

| Date                                   | Snapshot | Restore time | Row counts sane? | By  |
| -------------------------------------- | -------- | ------------ | ---------------- | --- |
| _(first drill after the first deploy)_ |          |              |                  |     |

## Full-host rebuild

1. New VPS → `docs/runbooks/vps-setup.md` (steps 1–8).
2. Restore the latest dump into the fresh database before starting the app.
3. **Re-apply account deletions made since that dump** — see
   [`restore.md`](restore.md#after-any-restore-re-apply-account-deletions). A backup is older
   than the promises made since it was taken.
4. Deploy the last-known-good digests (`/srv/gth/<env>/last-good.env`, also in the deploy
   workflow's history).
5. Repoint DNS.
