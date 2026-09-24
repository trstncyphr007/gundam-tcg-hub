#!/usr/bin/env bash
# Every scheduled job is defined in three places, and they have to agree (ADR-036).
#
#   bash scripts/check-jobs.sh
#
#   1. `jobs_schedule` in infra/vps/ansible/roles/jobs/defaults/main.yml — what gets a timer
#   2. the allowlist in gth-job.sh (same role) — what the runner will accept
#   3. the `jobs` profile in infra/compose/docker-compose.prod.yml — what can actually run
#   4. the tsup entry list in apps/api/tsup.config.ts — what is in the image at all
#   5. the timer list in infra/vps/preflight.sh — what is checked before a deploy
#
# Miss one and the failure is silent in the worst way: a job that exists, is documented, has
# tests, and never runs. That is precisely what happened — `alert-retry` was added to the
# compose file and the image and to nothing else, so on a real host it would have sat there
# owing people alerts that nothing was going to send.
#
# Run in CI alongside the other config checks.
set -euo pipefail
cd "$(dirname "$0")/.."

DEFAULTS=infra/vps/ansible/roles/jobs/defaults/main.yml
TASKS=infra/vps/ansible/roles/jobs/tasks/main.yml
COMPOSE=infra/compose/docker-compose.prod.yml
TSUP=apps/api/tsup.config.ts
PREFLIGHT=infra/vps/preflight.sh

fail() { printf '\033[1;31mjobs: %s\033[0m\n' "$1" >&2; exit 1; }

# 1. Timers.
scheduled=$(grep -oE '^  - name: [a-z-]+' "$DEFAULTS" | awk '{print $3}' | sort)
[ -n "$scheduled" ] || fail "no jobs found in $DEFAULTS"

# 2. What the runner accepts: the `case` line listing job names.
allowed=$(grep -oE 'case "\$job" in [a-z|-]+' "$TASKS" | sed 's/.* in //' | tr '|' '\n' | sort)
[ -n "$allowed" ] || fail "could not read the job allowlist from $TASKS"

# 3. Compose services carrying `profiles: [jobs]`. Read by walking the file: a service name is
#    at two spaces, and the profile line belongs to whichever it last appeared under.
profiled=$(awk '
  /^  [a-z][a-z0-9-]*:$/ { name = $1; sub(":", "", name) }
  /profiles: \[jobs\]/   { print name }
' "$COMPOSE" | sort)
[ -n "$profiled" ] || fail "no services with profiles: [jobs] in $COMPOSE"

# 4. Entry points bundled into the image.
entries=$(grep -oE "src/job-[a-z-]+\.ts" "$TSUP" | sed -E 's|src/job-(.*)\.ts|\1|' | sort)

# 5. The timers preflight.sh looks for on the server before a deploy is attempted. `backup`
#    belongs to the backups role rather than this one, so it is not expected here.
preflighted=$(grep -oE 'gth-[a-z-]+\.timer' "$PREFLIGHT" | sed -E 's/gth-(.*)\.timer/\1/' |
  grep -v '^backup$' | sort -u)
[ -n "$preflighted" ] || fail "could not read the timer list from $PREFLIGHT"

# `migrator` runs from the migrate entry point and on demand from deploy.sh, never on a timer.
profiled_timed=$(printf '%s\n' "$profiled" | grep -v '^migrator$' | sort)

check() {
  local label="$1" left="$2" right="$3" left_name="$4" right_name="$5"
  local missing
  missing=$(comm -23 <(printf '%s\n' "$left") <(printf '%s\n' "$right"))
  [ -z "$missing" ] || fail "$label: in $left_name but not $right_name: $(echo "$missing" | tr '\n' ' ')"
}

check "timer with nothing to run" "$scheduled" "$profiled_timed" "jobs_schedule" "the compose jobs profile"
check "job the runner would refuse" "$scheduled" "$allowed" "jobs_schedule" "the gth-job.sh allowlist"
check "compose job with no timer" "$profiled_timed" "$scheduled" "the compose jobs profile" "jobs_schedule"
check "job missing from the image" "$scheduled" "$entries" "jobs_schedule" "the tsup entry list"
# The one that runs on launch day. It had drifted to two of the four jobs, so it would have
# reported a clean bill of health on a host where the watchdog — the dead man's switch itself —
# and the retry job had no timers at all.
check "timer preflight never looks for" "$scheduled" "$preflighted" "jobs_schedule" "the preflight.sh timer list"
check "timer preflight checks but nothing schedules" "$preflighted" "$scheduled" "the preflight.sh timer list" "jobs_schedule"

printf '\033[1;32mjobs: %s scheduled, all five lists agree\033[0m — %s\n' \
  "$(printf '%s\n' "$scheduled" | wc -l)" "$(printf '%s' "$scheduled" | tr '\n' ' ')"
