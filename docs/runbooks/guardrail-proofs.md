# Guardrail Proofs

**Last run: 2026-09-25 — 13 passed, 0 failed, 0 skipped.** The one that used to be skipped,
`cosign verify` against an unsigned image, now runs: cosign is installed on the workstation.

Every gate in this project claims to stop something. These proofs make each one actually
refuse, so the claim is evidence rather than assertion. A gate nobody has watched fire is a
gate nobody knows works.

```bash
bash scripts/guardrail-proofs.sh
```

Re-runnable and self-contained: everything happens in temporary directories and throwaway
git repos, and nothing is left behind. **Run it after changing any gate**, and record the
result here.

Plan §27 lists seven proofs. Two of them assume GitHub features this repo does not have, so
they test the compensating control from ADR-014 instead — noted below. Proofs 8–11 cover gates
this project added afterwards, which had been claims nobody had watched fire.

Proof 11 is the newest and the plainest example of why this file exists. Shell was the only
language here with no linter at all: the `run:` blocks in the workflows were covered by
actionlint, and the seventeen real scripts — the ones that deploy, back up, rotate keys and
decide whether the server is ready — by nothing.

---

## Results

| #   | What it tries to do                        | What stops it                            | Result   |
| --- | ------------------------------------------ | ---------------------------------------- | -------- |
| 1   | Commit a staged AWS access key id          | gitleaks (`.gitleaks.toml`)              | **PASS** |
| 1b  | Commit a staged `gth_live_` API key        | gitleaks, our own rule                   | **PASS** |
| 2   | Leave a secret in git history              | gitleaks in CI + GitHub push protection  | **PASS** |
| 3   | Add a dependency with a known CVE          | `osv-scanner`                            | **PASS** |
| 4   | Use `sql.raw` or `dangerouslySetInnerHTML` | Semgrep + `.semgrep.yml`                 | **PASS** |
| 5   | Ship a container running as root           | hadolint                                 | **PASS** |
| 6   | Deploy an unverified image                 | digest validation in `deploy.sh`         | **PASS** |
| 6b  | `cosign verify` an unsigned image          | cosign                                   | **PASS** |
| 7   | Push straight to `main`                    | pre-push hook **+ GitHub ruleset**       | **PASS** |
| 8   | Add a second outbound HTTP request         | Semgrep `gth-no-outbound-http`           | **PASS** |
| 8b  | Keep the one allowed outbound module       | the rule's exclusion, still matching     | **PASS** |
| 9   | Use a `style` prop in a component          | ESLint `no-restricted-syntax`            | **PASS** |
| 10  | Commit a shebang script as mode 644        | `scripts/check-exec-bits.sh` in CI       | **PASS** |
| 11  | `rm -rf $var/*` in a shell script          | shellcheck (SC2115) in CI and pre-commit | **PASS** |

---

## Two findings from the first run

Both were real, and both are now fixed rather than papered over.

### gitleaks did not catch a bare AWS key

Plan §27's first proof is "stage a fake `AKIA` key and commit". It **passed through
untouched**. The upstream default rule requires a secret access key nearby before it fires,
because the bare pattern is noisy in the wild — so a lone access key id, which is still half
a credential, was invisible.

`.gitleaks.toml` now carries a rule for it. Verified afterwards against the full history and
the working tree: no false positives.

Worth noting what _was_ already caught: GitHub PATs, Slack tokens, private key blocks, and
our own `gth_live_` format. The gap was specific, not general.

### The proof script was testing the wrong secret

The first version used AWS's own published documentation key — the one beginning
`AKIAIOSF…` — which scanners deliberately allowlist so that documentation does not set off
alarms. It would never have fired no matter how good the rule was.

The script now assembles fake secrets at run time from fragments, so it both exercises real
rules _and_ does not trip the scanner when the repo scans itself.

> That key is written truncated above on purpose. Spelled in full it matches the new rule,
> and CI caught **this very file** on the first push — a better demonstration that the rule
> works than anything else in this document. A doc carrying a live-matching credential shape
> is a doc that teaches people to ignore the scanner.

---

## Proofs 2 and 7 are now enforced by GitHub as well

These two originally tested only a local compensating control, because a **private repo on
GitHub Free** has no rulesets and no push protection (ADR-014):

```
$ gh api repos/trstncyphr007/gundam-tcg-hub/rules/branches/main
Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)
```

**The repo went public on 2026-09-20 and both are now server-side.** Verified by pushing an
empty commit straight at `main`, with the local hook deliberately overridden so the _server_
was what got tested:

```
$ ALLOW_MAIN_PUSH=1 git push origin main
remote: - 7 of 7 required status checks are expected.
 ! [remote rejected] main -> main (push declined due to repository rule violations)
```

`main` now requires a pull request, all seven checks (strict), signed commits and linear
history, and refuses force-pushes and deletion. Secret scanning and push protection are on.

The local guards stay, and the script still tests them. They fire a commit earlier than the
server does — at `git commit` rather than at `git push` — which is the cheaper place to
find a mistake. The difference now is that bypassing them with `--no-verify` no longer
bypasses anything that matters.

## The one that used to be skipped

`cosign` was not installed on the workstation until the deploy track needed it, so this proof
sat skipped through several runs. **It now runs and passes**, which matters more than it
sounds: a skipped proof and a passing one look identical in a summary line unless somebody
counts, and this file had been reporting "12 passed, 1 skipped" as though that were a clean
result.

What is also checked locally is the other half of the control: `deploy.sh` refuses anything
that is not a `sha256:` digest, so a mutable tag can never reach `cosign verify` in the
first place.

The signature check itself was exercised for real during the deploy track — release run 2
signed both images, and the deploy workflow verifies twice (in CI and again on the server)
before anything starts.

---

## The 2026-09-23 run

Nothing new was found: all twelve gates refused what they claim to refuse. The reason for
running it was that four gates had been added since the last run — the outbound-request rule
(ADR-030), the inline-style ban (ADR-031) and the exec-bit check (ADR-039) — and every one of
them was an untested claim until this run. Three of the four are now proofs 8–10.

Proof 8b is the one worth keeping in mind: it checks that the module which **is** allowed to
make an outbound request still passes. A rule that starts refusing its own exception gets
switched off by the next person who hits it, and then it refuses nothing at all.

## When to re-run

- After changing `.gitleaks.toml`, `.semgrep.yml`, `lefthook.yml`, `eslint.config.mjs`, a
  Dockerfile, or `deploy.sh`
- **After adding a gate** — a gate with no proof is a claim, and this file is where claims
  become evidence
- After upgrading any scanner — **a rule that silently stops matching looks exactly like a
  clean repo**, which is how the AWS gap above went unnoticed
- Before a release
