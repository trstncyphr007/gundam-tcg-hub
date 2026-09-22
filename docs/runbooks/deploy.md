# Runbook: Deploy

**Status: written and verified locally; unexercised against a real server.** The production
stack is proven end to end by `scripts/verify-prod-stack.sh`, but no VPS exists yet. Expect
the first real run to surface something; that is what staging is for.

## Before you can deploy at all

- A VPS, set up per [`vps-setup.md`](vps-setup.md)
- `/srv/gth/<env>/` holding `docker-compose.prod.yml`, `Caddyfile` and `secrets.sops.env`
- `/root/.config/sops/age/keys.txt` present, root-owned, mode `0400`
- Tailscale up, with SSH reachable only over the tailnet
- **The server can read the images** — see "Registry access" below. Today it cannot.

## Registry access — decide before the first deploy

The images (`ghcr.io/trstncyphr007/gth-api`, `gth-web`) are **private packages**. Checked
2026-09-23: an anonymous manifest read returns 403. The deploy _workflow_ now logs in with
its own short-lived token (ADR-032), but **the server** also pulls the images and verifies
their signatures, and nothing on it can read a private package. As things stand, step 1
below would fail on the server.

Pick one:

- **Make both packages public (recommended).** The repository is already public, so the
  images reveal nothing their source does not; they hold no secrets (those are decrypted
  on the server at deploy time). Pulls and signature checks then need no credential, so
  there is none to leak or rotate. GitHub → your profile → Packages → each package →
  Package settings → Change visibility → Public.
- **Keep them private.** Create a fine-grained token with only `read:packages`, store it in
  `secrets.sops.env` as `GHCR_READ_TOKEN`, and add a `docker login ghcr.io` to `deploy.sh`
  before the verify step. Add the token to the rotation inventory in `key-rotation.md`.

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
