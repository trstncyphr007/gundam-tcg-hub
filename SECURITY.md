# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue. Contact the maintainer directly on GitHub
(@trstncyphr007). A `security@` address and `/.well-known/security.txt` will be published when
the production domain goes live (plan §15.4).

We aim to acknowledge reports within **72 hours** and to ship fixes for High/Critical issues
within **14 days**.

## Supported versions

Only the latest deployment of `main` is supported.

## How this repo is protected

- Secrets: never committed. gitleaks runs pre-commit and in CI over full history; local secrets
  are generated per-machine (`pnpm env:init`); deploy secrets are SOPS+age encrypted.
- Supply chain: exact-pinned dependencies, 7-day minimum release age, install scripts blocked by
  default, actions pinned by SHA, images pinned by digest, SBOM for every image.
- CI gates (all blocking): lint (incl. security rules), typecheck, tests + coverage, Semgrep,
  OSV-Scanner, `pnpm audit`, license allowlist, hadolint, actionlint, zizmor, Trivy (config +
  image).
- Runtime: distroless non-root images, read-only filesystems, dropped capabilities,
  least-privilege Postgres roles, strict security headers, rate limiting.

Details: [`docs/devsecops-build-plan.md`](docs/devsecops-build-plan.md) §16–§19 and
[`docs/threat-model.md`](docs/threat-model.md).
