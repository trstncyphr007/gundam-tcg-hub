#!/usr/bin/env bash
# Rehearse the encryption-key rotation, exactly as the runbook writes it (SR-X.18, ADR-029).
#
#   bash scripts/key-rotation-drill.sh
#
# `docs/runbooks/key-rotation.md` gives a four-step procedure for `DATA_ENCRYPTION_KEYS`: add,
# switch, re-encrypt, remove. The pieces have unit tests. The **procedure** had never been run,
# and it is one of only two operations on this system that cannot be undone -- remove a key
# before the values it wrote have moved and those values are gone for good.
#
# So this runs the four steps against the development database, in order, and checks the one
# thing that matters at each: that every encrypted value still decrypts to exactly what it did
# before. It never prints a plaintext -- it compares fingerprints (`pnpm keys:fingerprint`).
#
# The live .env is never modified. Each step runs with the key ring passed in the environment,
# which is what a deploy does anyway.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31mDRILL FAILED\033[0m — %s\n' "$1"; exit 1; }

WORK="$(mktemp -d)"

# Put the database back under the key .env holds, on **every** exit path.
#
# This is here because the drill did it to me. A sabotaged run -- deliberately broken, to prove
# the drill catches a bad rotation -- aborted after the values had moved to k2 and before the
# step that moves them back. k2 lived only in that process, so when it exited the development
# database held a value nobody could read: exactly the loss this procedure exists to prevent,
# caused by the rehearsal for it.
#
# The restore therefore belongs in a trap rather than in the happy path. It runs after the
# fingerprint files are gone, so it re-reads nothing and simply rotates.
restore_k1() {
  local code=$?
  if [ "${ROTATED:-0}" = "1" ]; then
    printf '\n\033[1;36m== returning the database to the key in .env\033[0m\n'
    DATA_ENCRYPTION_KEYS="$BOTH" DATA_ENCRYPTION_ACTIVE_KID=k1 \
      pnpm -s keys:rotate > /dev/null 2>&1 \
      || printf '\033[1;31mcould not rotate back — the drill key is in %s\033[0m\n' "${WORK}/k2.txt"
  fi
  [ "$code" -eq 0 ] && rm -rf "$WORK"
  return "$code"
}
trap restore_k1 EXIT

# The live values, read once. K1 is whatever the workstation already uses.
DATABASE_URL_MIGRATOR="$(grep -m1 '^DATABASE_URL_MIGRATOR=' .env | cut -d= -f2-)"
K1_JSON="$(grep -m1 '^DATA_ENCRYPTION_KEYS=' .env | cut -d= -f2- | sed "s/^'//; s/'$//")"
export DATABASE_URL_MIGRATOR
K1_ONLY="$K1_JSON"
K2_SECRET="$(openssl rand -base64 32)"
# Both keys, k2 added beside k1 -- step 1 of the runbook.
BOTH="$(printf '%s' "$K1_JSON" | sed "s/}$/,\"k2\":\"${K2_SECRET//\//\\/}\"}/")"
K2_ONLY="{\"k2\":\"${K2_SECRET}\"}"

fingerprints() {
  DATA_ENCRYPTION_KEYS="$1" DATA_ENCRYPTION_ACTIVE_KID="$2" \
    pnpm -s keys:fingerprint 2>/dev/null
}
rotate() {
  DATA_ENCRYPTION_KEYS="$1" DATA_ENCRYPTION_ACTIVE_KID="$2" \
    pnpm -s keys:rotate ${3:-} 2>&1
}

step "what is encrypted right now, and can we read all of it?"
fingerprints "$K1_ONLY" k1 > "${WORK}/before.txt" || fail "could not read the current values"
sed 's/^/  /' "${WORK}/before.txt"
values=$(grep -cv '^#' "${WORK}/before.txt" || true)
[ "$values" -gt 0 ] || fail "nothing is encrypted in this database — the drill would prove nothing"
grep -q 'UNREADABLE' "${WORK}/before.txt" && fail "a value is already unreadable before we start"

step "step 1-2: add k2 beside k1 and make it active (the deploy)"
echo "  DATA_ENCRYPTION_KEYS now holds k1 and k2; DATA_ENCRYPTION_ACTIVE_KID=k2"

step "step 3: dry run first — it must change nothing"
rotate "$BOTH" k2 --dry-run | sed 's/^/  /'
after_dry=$(fingerprints "$BOTH" k2)
[ "$after_dry" = "$(cat "${WORK}/before.txt")" ] \
  || fail "the dry run changed something — that is the one thing it must never do"

step "step 3: re-encrypt"
# From here the database depends on k2, which exists only in this process. Write it down
# first, and tell the trap it has work to do.
printf '%s\n' "$K2_SECRET" > "${WORK}/k2.txt"
ROTATED=1
rotate "$BOTH" k2 | tee "${WORK}/rotate.out" | sed 's/^/  /'
grep -q 'safe to remove from DATA_ENCRYPTION_KEYS: k1' "${WORK}/rotate.out" \
  || fail "it did not say k1 is safe to remove — do not remove it"

step "did every value survive?"
fingerprints "$BOTH" k2 > "${WORK}/after.txt"
sed 's/^/  /' "${WORK}/after.txt"
grep -q 'UNREADABLE' "${WORK}/after.txt" && fail "a value cannot be read after rotation"

# The key ids must move and the plaintexts must not. Comparing the whole line would conflate
# the two; comparing the columns separately is what distinguishes "rotated" from "mangled".
plain_before=$(grep -v '^#' "${WORK}/before.txt" | awk -F'\t' '{print $1, $2, $4}')
plain_after=$(grep -v '^#' "${WORK}/after.txt" | awk -F'\t' '{print $1, $2, $4}')
[ "$plain_before" = "$plain_after" ] || fail "a plaintext changed — the rotation mangled a value"
kids_after=$(grep -v '^#' "${WORK}/after.txt" | awk -F'\t' '{print $3}' | sort -u | tr '\n' ' ')
[ "$kids_after" = "k2 " ] || fail "values are still written under ${kids_after}— k1 is still needed"
echo "  plaintexts identical; every value now written under k2"

step "step 4: remove k1, and prove the data is still readable without it"
fingerprints "$K2_ONLY" k2 > "${WORK}/without-k1.txt"
grep -q 'UNREADABLE' "${WORK}/without-k1.txt" \
  && fail "removing k1 loses data — the rotation did not finish"
plain_without=$(grep -v '^#' "${WORK}/without-k1.txt" | awk -F'\t' '{print $1, $2, $4}')
[ "$plain_before" = "$plain_without" ] || fail "the values differ once k1 is gone"
echo "  all ${values} values still readable with k2 alone"

step "put the database back where it was"
rotate "$BOTH" k1 > "${WORK}/restore.out" 2>&1 || fail "could not rotate back to k1"
ROTATED=0
fingerprints "$K1_ONLY" k1 > "${WORK}/restored.txt"
grep -q 'UNREADABLE' "${WORK}/restored.txt" && fail "the database is not readable with .env's key"
plain_restored=$(grep -v '^#' "${WORK}/restored.txt" | awk -F'\t' '{print $1, $2, $4}')
[ "$plain_before" = "$plain_restored" ] || fail "the database did not come back as it was"
echo "  back under k1, plaintexts unchanged — .env still works"

step "what this run actually covered"
# Said out loud, because a drill that quietly exercises one of two paths and reports a single
# green line is how a broken path stays green. Coverage depends on what the database happens
# to hold, so it is reported rather than assumed.
for kind in break_seed buyer_handle; do
  n=$(grep -c "^${kind}	" "${WORK}/before.txt" || true)
  if [ "$n" -gt 0 ]; then
    printf '  %-14s %s value(s) — rotated and verified here\n' "$kind" "$n"
  else
    printf '  %-14s none in this database — NOT exercised by this run; the path has unit\n' "$kind"
    printf '  %-14s cover in packages/db/src/queries/key-rotation.test.ts\n' ''
  fi
done

printf '\n\033[1;32mKEY ROTATION DRILL PASSED\033[0m — %s value(s) rotated k1→k2→k1, plaintexts identical throughout\n' "$values"
