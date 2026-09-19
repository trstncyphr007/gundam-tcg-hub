#!/usr/bin/env bash
# Run the CI security gates locally (plan §18.2). Uses the CLIs installed by
# setup/bootstrap-wsl.sh. Exits non-zero if any gate fails.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p reports

status=0
run() {
  local name="$1"; shift
  printf '\n\033[1;36m== %s\033[0m\n' "$name"
  if "$@"; then echo "PASS $name"; else echo "FAIL $name"; status=1; fi
}

run "gitleaks (history)" gitleaks git . --redact --no-banner
run "osv-scanner" osv-scanner scan source --lockfile pnpm-lock.yaml
run "pnpm audit (prod, high+)" pnpm audit --prod --audit-level=high
run "semgrep" semgrep scan --metrics=off --error --quiet \
  --config p/typescript --config p/nodejs --config p/owasp-top-ten --config p/secrets \
  --config .semgrep.yml
run "licenses" node scripts/check-licenses.mjs
run "hadolint" bash -c 'for f in infra/docker/*.Dockerfile; do hadolint --failure-threshold warning "$f" || exit 1; done'
run "actionlint" actionlint
run "trivy config" trivy config --quiet --exit-code 1 --severity HIGH,CRITICAL .

echo
if [ "$status" -eq 0 ]; then echo "All security gates passed."; else echo "Some security gates FAILED."; fi
exit "$status"
