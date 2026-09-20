# ADR-014: Compensating controls for GitHub Free + private repo

- Status: Accepted (2026-09-20)
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
