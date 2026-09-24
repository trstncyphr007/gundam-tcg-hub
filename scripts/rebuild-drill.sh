#!/usr/bin/env bash
# Rehearse the *full-host rebuild*, not just the restore (plan §21, T17, backups.md).
#
#   bash scripts/rebuild-drill.sh
#
# `restore-drill.sh` proves a dump can be read back. It does it by loading into an empty
# scratch database inside the running container -- where the four roles already exist, and
# nothing else does.
#
# A rebuilt host is not that. There, `docker compose up postgres` initialises a brand-new
# volume, which runs `packages/db/init/01-roles.sh`: it creates the roles, the extensions, the
# `app` schema and the default privileges *before* the dump is loaded. So the real restore
# lands on a database that is already partly furnished, and a `pg_dump` archive that carries
# the same objects.
#
# This drill runs that path: a genuinely fresh container, initialised the way production's
# would be, then the dump. It exists because the difference between those two situations is
# exactly the kind of thing a drill is supposed to find before the night it matters.
set -euo pipefail
cd "$(dirname "$0")/.."

PG_CONTAINER="${PG_CONTAINER:-gth-dev-postgres-1}"
PG_SUPERUSER="${PG_SUPERUSER:-gth_admin}"
PG_DATABASE="${PG_DATABASE:-gth}"
PG_IMAGE="${PG_IMAGE:-postgres:17-bookworm@sha256:639ab7ceb90e13123085b741fb31ef493fba25463002f6da665352e7b534b652}"
REBUILT="gth-rebuild-drill"

WORK="$(mktemp -d)"
cleanup() {
  docker rm -f "$REBUILT" > /dev/null 2>&1 || true
  docker volume rm -f "${REBUILT}-data" > /dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31mDRILL FAILED\033[0m — %s\n' "$1"; exit 1; }
on_new() { docker exec -i "$REBUILT" psql -U "$PG_SUPERUSER" -d "$PG_DATABASE" -qAtX "$@"; }

docker exec "$PG_CONTAINER" pg_isready -U "$PG_SUPERUSER" > /dev/null 2>&1 \
  || fail "no database in $PG_CONTAINER — start the stack first (pnpm stack:up)"

step "take the dump the nightly job takes"
DUMP="${WORK}/gth.dump"
docker exec "$PG_CONTAINER" pg_dump -Fc -U "$PG_SUPERUSER" "$PG_DATABASE" > "$DUMP"
echo "dumped $(du -h "$DUMP" | cut -f1)"

step "build a host that has never seen this data"
# The same image, the same init script, the same environment compose would supply. Passwords
# are per-drill: a rebuilt host gets new ones from SOPS, and the dump must not depend on them.
docker volume create "${REBUILT}-data" > /dev/null
docker run -d --name "$REBUILT" \
  -v "${REBUILT}-data:/var/lib/postgresql/data" \
  -v "$(pwd)/packages/db/init:/docker-entrypoint-initdb.d:ro" \
  -e POSTGRES_USER="$PG_SUPERUSER" \
  -e POSTGRES_PASSWORD="drill-super-$(date +%s)" \
  -e POSTGRES_DB="$PG_DATABASE" \
  -e POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 \
  -e PG_MIGRATOR_PASSWORD="drill-migrator" \
  -e PG_WEB_PASSWORD="drill-web" \
  -e PG_WORKER_PASSWORD="drill-worker" \
  -e PG_READONLY_PASSWORD="drill-readonly" \
  "$PG_IMAGE" > /dev/null

for _ in $(seq 1 60); do
  if docker exec "$REBUILT" pg_isready -U "$PG_SUPERUSER" -d "$PG_DATABASE" > /dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$REBUILT" pg_isready -U "$PG_SUPERUSER" -d "$PG_DATABASE" > /dev/null 2>&1 \
  || fail "the rebuilt database never came up"
echo "roles created by init: $(on_new -c "select count(*) from pg_roles where rolname like 'app\_%'")"

step "restore onto it, exactly as the runbook says"
# Errors are captured rather than hidden. An operator following the runbook sees whatever this
# prints, and needs to know which lines are expected and which mean the restore did not work.
set +e
docker exec -i "$REBUILT" pg_restore -U "$PG_SUPERUSER" -d "$PG_DATABASE" < "$DUMP" \
  > "${WORK}/restore.out" 2>&1
restore_rc=$?
set -e
errors=$(grep -c '^pg_restore: error' "${WORK}/restore.out" || true)
printf 'exit status %s, %s error line(s)\n' "$restore_rc" "$errors"

# **This is the finding this drill exists for.** The restore succeeds completely and reports
# failure: exit 1, with an error for each schema the init script already created. An operator
# reading that at three in the morning concludes the restore did not work and starts doing
# something more dangerous instead.
#
# The two lines are expected and harmless. Anything else is not, so they are named here rather
# than the count being waved through -- a drill that tolerates "some errors" would tolerate the
# one that mattered.
unexpected=$(grep '^pg_restore: error' "${WORK}/restore.out" \
  | grep -vE 'schema "(app|drizzle)" already exists' || true)
if [ -n "$unexpected" ]; then
  echo '--- errors that are NOT the known, harmless ones ---'
  printf '%s\n' "$unexpected" | sed 's/^/  /' | head -n 10
  fail "the restore reported something this drill does not recognise"
fi
if [ "$errors" -gt 0 ]; then
  echo "expected: the init script and the dump both create schemas app and drizzle."
  echo "a non-zero exit here does NOT mean the restore failed — the checks below are what decide."
fi

step "is the data there?"
query="select 'cards' t, count(*) n from app.cards
       union all select 'users', count(*) from app.users
       union all select 'watches', count(*) from app.watch_subscriptions
       union all select 'audit', count(*) from app.audit_log order by t"
live=$(docker exec "$PG_CONTAINER" psql -U "$PG_SUPERUSER" -d "$PG_DATABASE" -qAtX -c "$query")
rebuilt=$(on_new -c "$query")
paste <(echo "live:"; echo "$live") <(echo "rebuilt:"; echo "$rebuilt") | column -t
[ "$live" = "$rebuilt" ] || fail "the rebuilt database does not hold the same rows"

step "are the controls there?"
policies=$(on_new -c "select count(*) from pg_policies where schemaname = 'app'")
grants=$(on_new -c "select count(*) from information_schema.role_table_grants
                     where table_schema = 'app' and grantee = 'app_web'")
forced=$(on_new -c "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'app' and c.relforcerowsecurity")
printf 'policies: %s   grants to app_web: %s   tables with FORCE row security: %s\n' \
  "$policies" "$grants" "$forced"
[ "$policies" -gt 0 ] || fail "row-level security did not survive: a restored database that leaks"
[ "$grants" -gt 0 ] || fail "the app roles have no grants: the application cannot read anything"
[ "$forced" -gt 0 ] || fail "FORCE row security did not survive"

step "can the application's own roles still do their jobs, and only their jobs?"
# The real question is not "did rows arrive" but "is this a working, least-privileged
# database". A restore that brings the data and loses the privileges looks healthy and is not.
as_role() {
  docker exec -i -e PGPASSWORD="drill-$1" "$REBUILT" \
    psql -U "app_$1" -h 127.0.0.1 -d "$PG_DATABASE" -qAtX -c "$2" 2>&1
}
check() {
  local label="$1" expectation="$2" output="$3" pattern="$4"
  if printf '%s' "$output" | grep -qE "$pattern"; then
    printf '  ok    %-42s %s\n' "$label" "$expectation"
  else
    printf '  FAIL  %-42s got: %s\n' "$label" "$(printf '%s' "$output" | head -n 1)"
    return 1
  fi
}
result=0
check "app_readonly reads the catalogue" "some rows" \
  "$(as_role readonly 'select count(*) from app.cards')" '^[0-9]+$' || result=1
check "app_readonly cannot write" "refused" \
  "$(as_role readonly "insert into app.games (slug, name) values ('x','x')")" \
  'read-only|permission denied' || result=1
check "app_web cannot read a key hash" "refused" \
  "$(as_role web 'select key_hash from app.api_keys limit 1')" 'permission denied' || result=1
check "app_web can read the catalogue" "some rows" \
  "$(as_role web 'select count(*) from app.cards')" '^[0-9]+$' || result=1
check "app_worker can read a key hash" "allowed" \
  "$(as_role worker 'select count(key_hash) from app.api_keys')" '^[0-9]+$' || result=1
check "nobody may update the audit log" "refused" \
  "$(as_role web "update app.audit_log set action = 'tampered'")" 'permission denied' || result=1
[ "$result" -eq 0 ] || fail "the restored database is not the least-privileged one we backed up"

printf '\n\033[1;32mREBUILD DRILL PASSED\033[0m — a host that never saw this data now serves it, with its privileges intact\n'
