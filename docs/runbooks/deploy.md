# Runbook: Deploy

**Status: written and verified locally; unexercised against a real server.** The production
stack is proven end to end by `scripts/verify-prod-stack.sh`, but no VPS exists yet. Expect
the first real run to surface something; that is what staging is for.

## Before you can deploy at all

- A VPS, set up per [`vps-setup.md`](vps-setup.md)
- `/srv/gth/<env>/` holding `docker-compose.prod.yml`, `Caddyfile` and `secrets.sops.env`
- `/root/.config/sops/age/keys.txt` present, root-owned, mode `0400`
- Tailscale up, with SSH reachable only over the tailnet
- **The images are public** — see "Registry access" below
- **`sudo /srv/gth/preflight.sh <env> <api-digest> <web-digest>` reports no FAIL**

## Registry access — decided: public

**Decision (2026-09-23): both image packages are public.** The repository is already public,
so the images reveal nothing their source does not, and they hold no secrets — those are
decrypted on the server at deploy time. The server then pulls and verifies with no registry
credential at all: nothing to leak, nothing to rotate.

**Done 2026-09-23.** Both packages are public, and the whole server-side gate was then proven
from a machine with no GitHub credentials at all: anonymous `docker pull`, `cosign verify`
against this repository's `release.yml` on `main`, and the CycloneDX SBOM attestation — every
check `deploy.sh` makes.

If a package is ever made private again, `preflight.sh` reports it as "not publicly readable"
and a deploy fails at its first pull. (To set visibility: your profile → **Packages** → the
package → **Package settings** → **Change visibility**.)

(The alternative was a `read:packages` token in SOPS and a `docker login` in `deploy.sh` —
one more long-lived secret on the box, for no confidentiality gained.)

## Preflight — before every first deploy, and whenever something changed

```bash
sudo /srv/gth/preflight.sh staging   <api-digest> <web-digest>
sudo /srv/gth/preflight.sh production <api-digest> <web-digest>
```

It checks, and changes nothing:

- **Tools and host:** docker and compose, cosign and sops present; SSH keys-only and no
  root; firewall active; Tailscale up; the clock synchronised (keyless signatures are
  short-lived certificates); `/run` in memory; disk free for images.
- **Files:** the compose file, Caddyfile, secrets and `deploy.sh`; the age key present, root's,
  mode `0400`.
- **Secrets:** that they decrypt with _this_ host's key; every setting compose requires is
  set; no placeholder was left in (`<domain>`, `generated-by-env-init`, …); and in
  production, that passkeys are bound to the real domain (it cannot change later) and the
  site has a domain for TLS. It names settings, never values, and removes the decrypted copy.
- **Images:** publicly readable; and with digests, signed by this repository's `release.yml`
  on `main` — the same check `deploy.sh` makes.

Every line is PASS, FAIL or SKIP; SKIP means a check could not run here, not that it passed.

## How a deploy happens

Nothing deploys automatically. `release.yml` builds, scans, signs and pushes images on merge
to `main`; **deploying is a separate manual step**, so a bad merge cannot reach production on
its own.

1. Find the digests from the release run — it prints `api` and `web` as `sha256:…`.
2. Actions → **deploy** → _Run workflow_:
   - `api_digest`, `web_digest` — the digests, not tags
   - `environment` — `staging` first, always
3. CI verifies both signatures **and both build-provenance attestations** (built by
   `release.yml` on `main` in this repository — ADR-032), then SSHes over Tailscale and runs
   `sudo /srv/gth/deploy.sh <env> <api-digest> <web-digest>`.

### What the server does

In order, stopping at the first failure:

1. **Verifies both signatures again.** The CI check is not trusted on its own: anyone who
   reached the box could have skipped it. Identity must be this repo's `release.yml` on
   `main`, issuer must be GitHub's OIDC.
2. Decrypts `secrets.sops.env` into `/run/gth/<env>.env` — **tmpfs**, mode `0400`, so it
   never touches disk.
3. Pulls both images by digest.
4. Runs migrations as a **one-off container** on the `app_migrator` role. This is the step
   most likely to fail, and it fails before anything is swapped.
5. Starts the new release and waits for healthchecks.
6. Smoke-tests `/` and `/v1/games` through Caddy.
7. Records the digests in `last-good.env`.

Any failure after step 4 rolls back automatically — see [`rollback.md`](rollback.md).

## After a staging deploy

```bash
curl -sI https://<staging-host>/ | grep -iE 'strict-transport|content-security|x-content-type'
curl -s  https://<staging-host>/v1/games | head -c 200
curl -sI https://<staging-host>/v1/me    # expect 401
```

Then walk one real path in a browser: sign in, watch a product, start a break, open the
overlay. Automation does not notice a page that renders but does not work — which is exactly
what the hydration bug in Phase 2 looked like.

## Promoting to production

Re-run the deploy workflow with `environment: production` and **the same digests**. Never
rebuild for production: a rebuild is a different artifact, and then staging proved nothing.

## Rules

- **Digests, never tags.** A tag moves; `deploy.sh` rejects anything that is not
  `sha256:<64 hex>`.
- **Migrations must be backward-compatible.** Expand/contract only: add nullable, backfill,
  then constrain. A rollback runs the _old_ code against the _new_ schema, so the new schema
  has to still work for it.
- **Staging first.** Every time, including for "obvious" changes.

## If the deploy fails

1. Read the output. The step that failed names what it was doing.
2. If it rolled back, the previous release is already running — confirm with
   `docker compose -p gth-<env> ps`.
3. If it did **not** roll back, it was the first deploy of that environment and there is no
   previous release. The stack is left as-is deliberately, for inspection.
4. Migration failures need attention before retrying; the schema may be half-applied.
   [`restore.md`](restore.md) covers getting back to a known state.
