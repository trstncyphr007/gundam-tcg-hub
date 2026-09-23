#!/usr/bin/env bash
# Rehearse the backup and restore, end to end, against the development stack (plan §21, T17).
#
#   bash scripts/restore-drill.sh
#
# The real drill runs on the VPS against real data. This one runs the **same commands** on a
# workstation, so the procedure is known to work before the night it is needed — and so that
# "restore from backup" stops being a paragraph nobody has executed.
#
# Everything happens in a temporary restic repository and a scratch database. The live
# development database is only ever read.
set -euo pipefail
cd "$(dirname "$0")/.."

PG_CONTAINER="${PG_CONTAINER:-gth-dev-postgres-1}"
PG_SUPERUSER="${PG_SUPERUSER:-gth_admin}"
PG_DATABASE="${PG_DATABASE:-gth}"
SCRATCH="gth_restore_drill"
RESTIC_IMAGE="restic/restic:0.18.1@sha256:39d9072fb5651c80d75c7a811612eb60b4c06b32ffe87c2e9f3c7222e1797e76"

WORK="$(mktemp -d)"
export RESTIC_REPOSITORY="${WORK}/repo"
RESTIC_PASSWORD="drill-only-$(date +%s)"
export RESTIC_PASSWORD
cleanup() {
  docker exec "$PG_CONTAINER" dropdb -U "$PG_SUPERUSER" --if-exists "$SCRATCH" > /dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }
# As this user, not root: otherwise the restored files come back owned by root and the very
# next step — reading what you just restored — fails with a permission error.
restic() {
  docker run --rm --user "$(id -u):$(id -g)" \
    -v "$WORK:$WORK" -e RESTIC_REPOSITORY -e RESTIC_PASSWORD -e HOME="$WORK" \
    "$RESTIC_IMAGE" "$@"
}

docker exec "$PG_CONTAINER" pg_isready -U "$PG_SUPERUSER" > /dev/null || {
  echo "No database in $PG_CONTAINER. Start the stack first (pnpm stack:up)." >&2
  exit 1
}

step "take the dump (what the nightly job does)"
DUMP="${WORK}/gth-$(date -u +%Y%m%dT%H%M%SZ).dump"
dump_start=$(date +%s)
docker exec "$PG_CONTAINER" pg_dump -Fc -U "$PG_SUPERUSER" "$PG_DATABASE" > "$DUMP"
dump_s=$(( $(date +%s) - dump_start ))
echo "dumped $(du -h "$DUMP" | cut -f1) in ${dump_s}s"

step "back it up, prune, and verify the repository"
restic init > /dev/null
restic backup --tag postgres --host gth-drill "$DUMP" | tail -n 2
restic forget --tag postgres --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune | tail -n 2
# A repository that only ever gets written to is one nobody has proved is readable.
restic check --read-data | tail -n 1

step "restore from the repository, not from the file on disk"
rm -f "$DUMP"
restore_start=$(date +%s)
restic restore latest --target "${WORK}/restored" > /dev/null
RESTORED=$(find "${WORK}/restored" -name 'gth-*.dump' | head -n 1)
[ -n "$RESTORED" ] || { echo "nothing restored" >&2; exit 1; }

step "load it into a scratch database, never over the live one"
docker exec "$PG_CONTAINER" createdb -U "$PG_SUPERUSER" "$SCRATCH"
docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_SUPERUSER" -d "$SCRATCH" < "$RESTORED" 2>&1 \
  | grep -vE '^$' | tail -n 3 || true
restore_s=$(( $(date +%s) - restore_start ))

step "does it hold what it should?"
query="select 'cards' t, count(*) n from app.cards
       union all select 'users', count(*) from app.users
       union all select 'watches', count(*) from app.watch_subscriptions
       union all select 'audit', count(*) from app.audit_log order by t"
live=$(docker exec "$PG_CONTAINER" psql -U "$PG_SUPERUSER" -d "$PG_DATABASE" -qAtX -c "$query")
restored=$(docker exec "$PG_CONTAINER" psql -U "$PG_SUPERUSER" -d "$SCRATCH" -qAtX -c "$query")
paste <(echo "live:"; echo "$live") <(echo "restored:"; echo "$restored") | column -t

# The controls have to survive a restore too: a database restored without its row-level
# security is a database that leaks, and it would look perfectly healthy.
policies=$(docker exec "$PG_CONTAINER" psql -U "$PG_SUPERUSER" -d "$SCRATCH" -qAtX \
  -c "select count(*) from pg_policies where schemaname = 'app'")
roles=$(docker exec "$PG_CONTAINER" psql -U "$PG_SUPERUSER" -d "$SCRATCH" -qAtX \
  -c "select count(*) from information_schema.role_table_grants
       where table_schema = 'app' and grantee = 'app_web'")
echo
echo "row-level security policies restored: ${policies}"
echo "grants to app_web restored:           ${roles}"

if [ "$live" = "$restored" ] && [ "$policies" -gt 0 ] && [ "$roles" -gt 0 ]; then
  printf '\n\033[1;32mDRILL PASSED\033[0m — dump %ss, restore %ss\n' "$dump_s" "$restore_s"
else
  printf '\n\033[1;31mDRILL FAILED\033[0m — the restored database does not match\n'
  exit 1
fi
