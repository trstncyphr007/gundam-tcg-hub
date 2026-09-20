# Guardrail Proofs

**Last run: 2026-09-20 — 8 passed, 0 failed, 1 skipped.**

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
they test the compensating control from ADR-014 instead — noted below.

---

## Results

| #   | What it tries to do                        | What stops it                    | Result                |
| --- | ------------------------------------------ | -------------------------------- | --------------------- |
| 1   | Commit a staged AWS access key id          | gitleaks (`.gitleaks.toml`)      | **PASS**              |
| 1b  | Commit a staged `gth_live_` API key        | gitleaks, our own rule           | **PASS**              |
| 2   | Leave a secret in git history              | gitleaks over full history in CI | **PASS**              |
| 3   | Add a dependency with a known CVE          | `osv-scanner`                    | **PASS**              |
| 4   | Use `sql.raw` or `dangerouslySetInnerHTML` | Semgrep + `.semgrep.yml`         | **PASS**              |
| 5   | Ship a container running as root           | hadolint                         | **PASS**              |
| 6   | Deploy an unverified image                 | digest validation in `deploy.sh` | **PASS**              |
| 6b  | `cosign verify` an unsigned image          | cosign                           | _skipped — see below_ |
| 7   | Push straight to `main`                    | pre-push hook                    | **PASS**              |

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

## The two that test a compensating control instead

This repo is **private on GitHub Free**, which has no branch rulesets and no push
protection (ADR-014). Confirmed directly:

```
$ gh api repos/trstncyphr007/gundam-tcg-hub/rules/branches/main
Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)
```

So:

- **Proof 2** (push protection blocks a secret) becomes: gitleaks scans the **full history**
  in CI, which catches the same secret one commit later. The pre-commit hook catches it one
  commit earlier. Both are proven above.
- **Proof 7** (ruleset blocks a push to main) becomes: the **pre-push hook** refuses it. The
  proof feeds the hook exactly what git feeds it on `git push origin HEAD:main`.

Be clear about what this does and does not buy. A local hook can be bypassed with
`--no-verify`, and it protects only this machine. It is a guard against mistakes, not
against an attacker who already has the repo. **The server-side guarantee does not exist
today** — it returns if the repo goes public or moves to an org on Team.

## The one that is skipped

`cosign` is not installed on the workstation; it runs in the release and deploy workflows.
What _is_ checked locally is the other half of the control: `deploy.sh` refuses anything
that is not a `sha256:` digest, so a mutable tag can never reach `cosign verify` in the
first place.

The signature check itself was exercised for real during the deploy track — release run 2
signed both images, and the deploy workflow verifies twice (in CI and again on the server)
before anything starts.

---

## When to re-run

- After changing `.gitleaks.toml`, `.semgrep.yml`, `lefthook.yml`, a Dockerfile, or
  `deploy.sh`
- After upgrading any scanner — **a rule that silently stops matching looks exactly like a
  clean repo**, which is how the AWS gap above went unnoticed
- Before a release
