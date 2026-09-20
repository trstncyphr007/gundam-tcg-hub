# Runbook: backups and restore

Plan reference: §21. Targets: **RPO ≤ 24h** (nightly dump), **RTO ≤ 4h**.
A backup that has never been restored is not a backup, so the drill below is the point of
this document.

## What is backed up

| Data                    | How                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------- |
| Postgres (all app data) | `pg_dump -Fc` nightly, inside the database container                               |
| Valkey                  | Not backed up: it holds only caches and rate-limit counters, which rebuild         |
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
set -a; . /etc/gth/restic.env; set +a
restic init
```

**The backup credentials must not be able to delete.** Create a write-only key for the server
and keep a separate admin key offline for pruning, so ransomware on the VPS cannot wipe the
backups it can write to. Enable object lock/versioning on the bucket if available.

## Nightly job

`/usr/local/bin/gth-backup.sh` (0750, root):

```bash
#!/usr/bin/env bash
set -euo pipefail
set -a; . /etc/gth/restic.env; set +a
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

## Restore drill — run monthly, record the result here

```bash
set -a; . /etc/gth/restic.env; set +a
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
3. Deploy the last-known-good digests (`/srv/gth/<env>/last-good.env`, also in the deploy
   workflow's history).
4. Repoint DNS.
