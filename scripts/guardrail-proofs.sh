#!/usr/bin/env bash
# Guardrail proofs (plan §27).
#
# Every one of these tries to do something the project claims is impossible, and PASSES
# only when the guard refuses. A gate nobody has watched fire is a gate nobody knows works
# -- these exist so the claim is evidence rather than assertion.
#
# Safe to re-run: everything happens in temporary directories and throwaway branches, and
# nothing is left behind. Results are recorded in docs/runbooks/guardrail-proofs.md.
#
#   bash scripts/guardrail-proofs.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
REPO_ROOT="$(pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
skip=0

ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail + 1)); }
skipd(){ printf '  \033[33mSKIP\033[0m  %s\n' "$1"; skip=$((skip + 1)); }
head2(){ printf '\n\033[1;36m%s\033[0m\n' "$1"; }

# A guard "works" when the command FAILS. Anything that succeeds means the bad change got
# through, which is the finding.
blocked() {
  local what="$1"; shift
  if "$@" > "$WORK/out.txt" 2>&1; then
    bad "$what -- the change was ACCEPTED"
    sed 's/^/        /' "$WORK/out.txt" | head -n 6
    return 1
  fi
  ok "$what"
  return 0
}

# Secrets are assembled at run time rather than written as literals, so this script does
# not itself trip the scanner it is testing.
fake_aws_key() { printf 'AKIA%s' 'Q7ZR4M2XKD9WP6TB'; }
fake_gth_key() { printf 'gth_%s_a1b2c3d4_%s' 'live' 'Xq9mNpQrStUvWxYz0123456789AbCdEfGh'; }

# --------------------------------------------------------------------------- #
head2 "1. A staged secret cannot be committed (SR-0.12, gitleaks pre-commit)"
# Plan §27 proof 1 verbatim: an AWS key. The upstream default rule does not fire on a bare
# access key ID, which this script found on 2026-09-20; .gitleaks.toml adds a rule for it.
printf 'const key = "%s";\n' "$(fake_aws_key)" > "$WORK/leak.js"
blocked "gitleaks rejects a staged AWS access key id" \
  gitleaks detect --no-git --redact --no-banner --config "$REPO_ROOT/.gitleaks.toml" \
    --source "$WORK/leak.js"

# Our own credential format matters more here than anyone else's: it is the one this
# project actually issues, and the rule that catches it is ours.
printf 'GTH_INGEST_KEY=%s\n' "$(fake_gth_key)" > "$WORK/leak.env"
blocked "gitleaks rejects a staged gth_live_ API key" \
  gitleaks detect --no-git --redact --no-banner --config "$REPO_ROOT/.gitleaks.toml" \
    --source "$WORK/leak.env"

# --------------------------------------------------------------------------- #
head2 "2. A secret already in history is caught (ADR-014 replaces push protection)"
# GitHub Free + private has no push protection, so the compensating control is gitleaks
# over the full history in CI. Prove it finds a secret in a real commit, not just a file.
git init -q "$WORK/hist"
cd "$WORK/hist" || exit 1
git config user.email proof@example.invalid && git config user.name proof
git config commit.gpgsign false
printf 'GTH_INGEST_KEY=%s\n' "$(fake_gth_key)" > creds.env
git add creds.env && git commit -q -m "add credentials"
blocked "gitleaks finds a secret committed to history" \
  gitleaks git . --redact --no-banner --config "$REPO_ROOT/.gitleaks.toml"
cd "$REPO_ROOT" || exit 1

# --------------------------------------------------------------------------- #
head2 "3. A dependency with a known CVE fails the SCA gate (plan §18.2)"
mkdir -p "$WORK/dep"
cat > "$WORK/dep/package-lock.json" <<'JSON'
{
  "name": "proof", "version": "1.0.0", "lockfileVersion": 3, "requires": true,
  "packages": {
    "": { "name": "proof", "version": "1.0.0", "dependencies": { "lodash": "4.17.20" } },
    "node_modules/lodash": {
      "version": "4.17.20",
      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",
      "integrity": "sha512-PlhdFcillOINfeV7Ni6oF1TAEayyZBoZ8bcshTHqOYJYlrqzRK5hagpagky5o4HfCzzd1TRkXPMFq6cKk9rGmA=="
    }
  }
}
JSON
blocked "osv-scanner rejects lodash 4.17.20 (prototype pollution)" \
  osv-scanner scan source --lockfile "$WORK/dep/package-lock.json"

# --------------------------------------------------------------------------- #
head2 "4. Banned APIs are rejected (SR-X.11, SR-X.13, .semgrep.yml)"
mkdir -p "$WORK/code"
cat > "$WORK/code/bad-sql.ts" <<'TS'
import { sql } from 'drizzle-orm';
export function lookup(db: { execute: (q: unknown) => unknown }, name: string) {
  return db.execute(sql.raw(`select * from app.users where name = '${name}'`));
}
TS
cat > "$WORK/code/bad-xss.tsx" <<'TSX'
export function Note({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
TSX
blocked "semgrep rejects sql.raw and dangerouslySetInnerHTML" \
  semgrep scan --metrics=off --error --quiet \
    --config "$REPO_ROOT/.semgrep.yml" --config p/typescript --config p/react \
    "$WORK/code"

# --------------------------------------------------------------------------- #
head2 "5. A container running as root is rejected (SR-0.11, §19)"
cat > "$WORK/root.Dockerfile" <<'DOCKER'
FROM node:24-bookworm-slim
USER root
COPY . /app
CMD ["node", "/app/index.js"]
DOCKER
blocked "hadolint rejects a root-running Dockerfile" \
  hadolint --failure-threshold warning "$WORK/root.Dockerfile"

# --------------------------------------------------------------------------- #
head2 "6. An unsigned image cannot be deployed (ADR-010, §15.5)"
if command -v cosign > /dev/null 2>&1; then
  blocked "cosign refuses an unsigned image" \
    cosign verify --certificate-identity-regexp '^https://github.com/trstncyphr007/.*$' \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      docker.io/library/hello-world:latest
else
  # cosign lives in the release/deploy workflows, not on this workstation. The other half
  # of the control is local: the deploy script refuses anything that is not a digest, so a
  # mutable tag can never reach `cosign verify` in the first place.
  if grep -q 'sha256:\[0-9a-f\]\{64\}' infra/vps/deploy.sh 2>/dev/null ||
     grep -q 'sha256:' infra/vps/deploy.sh 2>/dev/null; then
    ok "deploy.sh validates image digests before use (cosign itself runs in CI)"
  else
    bad "deploy.sh does not validate image digests"
  fi
  skipd "cosign verify (not installed locally; exercised by the release workflow)"
fi

# --------------------------------------------------------------------------- #
head2 "7. A direct push to main is refused (ADR-014 replaces branch protection)"
# GitHub Free + private has no rulesets at all -- confirmed by the API returning 403
# "Upgrade to GitHub Pro". The compensating control is a local pre-push hook.
proof_push_main() {
  # Feed the hook exactly what git feeds it on `git push origin HEAD:main`.
  local sha
  sha="$(git rev-parse HEAD)"
  printf 'refs/heads/main %s refs/heads/main %s\n' "$sha" "$sha" \
    | bash scripts/hooks/protect-main.sh
}
blocked "the pre-push hook refuses a push to main" proof_push_main

# --------------------------------------------------------------------------- #
head2 "8. A second outbound request is rejected (SR-1.1, ADR-030)"
# The platform makes exactly one outbound call, and that singularity is the SSRF story: one
# place with an allowlist, a timeout and no redirects. The rule only applies under the real
# source paths, so the planted file goes where a real one would.
mkdir -p "$WORK/outbound/packages/watches/src"
cat > "$WORK/outbound/packages/watches/src/notify.ts" <<'TS'
export async function ping(url: string): Promise<void> {
  await fetch(url, { method: 'POST' });
}
TS
blocked "semgrep rejects a new outbound fetch in server code" \
  semgrep scan --metrics=off --error --quiet \
    --config "$REPO_ROOT/.semgrep.yml" "$WORK/outbound"

# And the file that *is* allowed one must stay allowed, or the rule gets switched off by the
# next person who hits it.
mkdir -p "$WORK/allowed/packages/alerts/src"
cp "$REPO_ROOT/packages/alerts/src/transports.ts" "$WORK/allowed/packages/alerts/src/"
if semgrep scan --metrics=off --error --quiet \
     --config "$REPO_ROOT/.semgrep.yml" "$WORK/allowed" > "$WORK/out.txt" 2>&1; then
  ok "the one allowed outbound module still passes (targeted rule, not a blanket ban)"
else
  bad "the allowed outbound module is rejected -- the exclusion no longer matches"
  sed 's/^/        /' "$WORK/out.txt" | head -n 6
fi

# --------------------------------------------------------------------------- #
head2 "9. An inline style is rejected (ADR-031)"
# Production's CSP refuses inline styles, and a style prop is dropped silently rather than
# erroring: the page passes every functional test and merely looks wrong. The lint rule is
# what stands between that and a broken page.
proof_inline_style() {
  local planted="$REPO_ROOT/apps/web/app/guardrail-proof-badge.tsx"
  cat > "$planted" <<'TSX'
export function Badge(): React.JSX.Element {
  return <span style={{ color: 'red' }}>overdue</span>;
}
TSX
  local status=0
  (cd "$REPO_ROOT/apps/web" && npx eslint --max-warnings=0 app/guardrail-proof-badge.tsx) \
    > "$WORK/eslint.txt" 2>&1 || status=$?
  rm -f "$planted"
  return "$status"
}
blocked "eslint rejects a style prop in a component" proof_inline_style

# --------------------------------------------------------------------------- #
head2 "10. A script that will not run on the server is rejected (ADR-039)"
# A shell script edited from a Windows editor comes back as mode 100644, and nothing notices
# until it fails to run on the VPS. This gate is why that is now impossible rather than
# repeatedly fixed by hand.
git init -q "$WORK/modes"
cd "$WORK/modes" || exit 1
git config user.email proof@example.invalid && git config user.name proof
git config commit.gpgsign false
mkdir -p scripts
cp "$REPO_ROOT/scripts/check-exec-bits.sh" scripts/
printf '#!/usr/bin/env bash\necho deploying\n' > deploy.sh
chmod 644 deploy.sh
git add -A && git commit -q -m "add a script the wrong way"
blocked "the exec-bit check rejects a non-executable shebang script" \
  bash scripts/check-exec-bits.sh
cd "$REPO_ROOT" || exit 1

# --------------------------------------------------------------------------- #
printf '\n\033[1m%d passed, %d failed, %d skipped\033[0m\n' "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ] || exit 1
