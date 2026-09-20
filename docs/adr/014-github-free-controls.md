# ADR-014: Compensating controls for GitHub Free + private repo

- Status: **Superseded 2026-09-20 — the repo is now public.** See the amendment at the end.
  The record below is kept because the controls it introduced are still in place and still
  doing work; what changed is that they are no longer the _only_ thing standing there.
- Original status: Accepted (2026-09-20)
- Context: On GitHub Free, a private repo gets none of the following:
  - branch protection or rulesets
  - secret scanning or push protection
  - CodeQL or code-scanning uploads
  - the dependency-review action
  - private deployment environments with reviewers

  The owner chose to stay private and on Free.

- Decision:
  | Missing feature                   | Compensating control                                                                                                                                                                                                                                  |
  | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Secret scanning + push protection | gitleaks pre-commit (lefthook) + gitleaks over full history in CI                                                                                                                                                                                     |
  | CodeQL                            | Semgrep (registry + `.semgrep.yml`) + type-aware ESLint security rules, blocking in CI                                                                                                                                                                |
  | Dependency review                 | OSV-Scanner + `pnpm audit` + license allowlist, blocking in CI                                                                                                                                                                                        |
  | Code-scanning UI                  | SARIF/SBOM uploaded as workflow artifacts                                                                                                                                                                                                             |
  | Branch protection                 | lefthook pre-push guard on `main` + ADR-012 merge discipline                                                                                                                                                                                          |
  | Environment reviewers             | Prod deploy is a manual `workflow_dispatch` (deploy track)                                                                                                                                                                                            |
  | (free, kept on)                   | Dependabot alerts + security updates + version updates                                                                                                                                                                                                |
  | GitHub build-provenance store     | Rejected for user-owned private repos, so that step is skipped unless the repo is public. **cosign keyless signatures and CycloneDX SBOM attestations still apply** — they live in the registry and are what CI and the server verify before a deploy |
- Consequences: Local hooks can be bypassed with `--no-verify`, but CI re-runs every gate.
  Upgrade path: make the repo public, or move it to an org on Team with GitHub Secret
  Protection / Code Security, which restores SR-0.1, SR-0.2 and SR-0.4.

## Amendment, 2026-09-20: OpenSSF Scorecard is not run

Plan §18.5 asks for `scorecard.yml` at a target score of ≥7. It is not implemented, on
purpose.

On a **private** repo Scorecard needs a classic PAT with `repo` scope to read the metadata
most of its checks depend on. That is a long-lived, broadly-scoped credential, which is
exactly what SR-0.14 says not to create ("no long-lived cloud keys, OIDC where supported").
Several of its checks also cannot pass here regardless of the token, because they measure
branch protection and code scanning — the very features this ADR exists to work around.

Minting a powerful credential to compute a score we can already predict is a bad trade. The
checks that carry real signal are enforced directly and **blockingly** instead:

| Scorecard check     | Enforced here by                                                     |
| ------------------- | -------------------------------------------------------------------- |
| Pinned-Dependencies | Actions pinned by SHA, tool images by digest; zizmor fails the build |
| Token-Permissions   | `permissions: {}` at the top level; zizmor fails the build           |
| Dangerous-Workflow  | zizmor fails the build                                               |
| Vulnerabilities     | OSV-Scanner + `pnpm audit`, blocking (guardrail proof 3)             |
| Security-Policy     | `SECURITY.md` present                                                |
| CI-Tests            | Seven required jobs on every PR                                      |

Revisit if the repo becomes public: there Scorecard needs no PAT, publishes results, and
costs nothing to add.

Recorded in `docs/asvs-checklist.md` as a known gap rather than a silent omission.

## Amendment, 2026-09-20 (later the same day): the repo went public

The decision above was the right one for a private repo on Free. It is no longer the
situation. The repo is public, which restores every feature this ADR was working around —
at the cost of the source being readable, which was never a control we relied on.

### What is now enforced by GitHub rather than by discipline

| Was                                   | Is now                                                                                                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A local pre-push hook guarding `main` | A **ruleset**: pull request required, all 7 status checks required and strict, signed commits, linear history, no force-push, no deletion. Verified by pushing an empty commit straight at `main` and being refused: _"7 of 7 required status checks are expected"_ |
| gitleaks only                         | gitleaks **plus** GitHub secret scanning **and push protection**                                                                                                                                                                                                    |
| OSV + `pnpm audit` only               | ...plus Dependabot alerts and automated security updates                                                                                                                                                                                                            |
| No Scorecard (needed a PAT)           | `scorecard.yml`, publishing results, no stored credential                                                                                                                                                                                                           |
| No provenance attestation             | Available again — `release.yml` already re-enables it for public repos                                                                                                                                                                                              |

### What was cleaned up first

History was rewritten before publishing: 15 squash-merge commits carried the maintainer's
real email address, because GitHub uses the account address when squashing unless
"Keep my email addresses private" is on. Every commit was re-signed in the same pass, so
all 16 commits on `main` remain verified. Content is byte-identical — only metadata changed.

### What still is not enforced

- **CodeQL default setup is not enabled.** The API refuses without the `security_events`
  token scope; it is two clicks in Settings → Code security. Semgrep still runs and blocks.
- **A second reviewer.** Still one maintainer, so the ruleset requires a pull request but
  zero approvals (ADR-012). It enforces _process_, not review. Worth tightening the moment
  a second contributor appears.

### What publishing costs

Anyone can read the code, the threat model and the ASVS checklist. That is deliberate: the
security of this system rests on keys, grants and policies, not on the source being secret.
Publishing it is what lets the claims in `docs/asvs-checklist.md` be checked at all.

The licence position is stated in the README: **all rights reserved**. Public source is not
a grant of permission to use it.
