## What & why

<!-- One or two sentences. Link the plan section / issue. -->

## Security checklist (plan §18.6)

- [ ] New inputs are validated with zod (HTTP, jobs, webhooks, env, CSV)
- [ ] New routes declare authorization and have IDOR tests
- [ ] No secrets in code, logs, fixtures, or screenshots
- [ ] New dependencies are justified (purpose, maintainer health, license, install scripts)
- [ ] Migrations are backward-compatible (expand/contract)
- [ ] Threat model / ADR updated if a trust boundary or big decision changed
- [ ] If this adds or changes a **gate**: `bash scripts/guardrail-proofs.sh` re-run and
      `docs/runbooks/guardrail-proofs.md` updated — a gate with no proof is a claim

## Verification

<!-- Commands run and results, e.g. pnpm test, pnpm sec:scan -->
