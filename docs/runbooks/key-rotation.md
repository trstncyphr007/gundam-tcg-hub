# Runbook: Key Rotation

Plan SR-0.15. Routine rotation every **180 days**, and immediately on any suspected
exposure.

Rotating is cheap. Deciding whether a key was _really_ exposed is expensive and you will
get it wrong under pressure — so when in doubt, rotate.

---

## The inventory

| Secret                      | Where it lives                                   | Rotating it costs                                   | Routine     |
| --------------------------- | ------------------------------------------------ | --------------------------------------------------- | ----------- |
| `BETTER_AUTH_SECRET`        | SOPS / `.env`                                    | **Every session ends.** Users sign in again         | 180d        |
| `TOKEN_PEPPER`              | SOPS / `.env`                                    | **Every API key and overlay token dies.** See below | 180d        |
| `DATA_ENCRYPTION_KEYS`      | SOPS / `.env`                                    | Nothing, if done in order. See below                | 365d        |
| `DATABASE_URL_*` (4 roles)  | SOPS / `.env`                                    | A restart                                           | 180d        |
| `VALKEY_URL`                | SOPS / `.env`                                    | Cache and rate-limit counters reset                 | 180d        |
| `DISCORD_CLIENT_SECRET`     | SOPS                                             | Nothing visible                                     | 180d        |
| `DISCORD_BOT_TOKEN`         | SOPS                                             | Bot reconnects                                      | 180d        |
| `DISCORD_ALERT_WEBHOOK_URL` | SOPS                                             | Nothing visible                                     | 180d        |
| `SMTP_URL`                  | SOPS                                             | Nothing visible                                     | 180d        |
| API keys (`gth_live_…`)     | Hashed in DB; plaintext only with the holder     | That scanner stops until re-keyed                   | on exposure |
| Overlay tokens              | Hashed in DB                                     | That overlay URL dies                               | on exposure |
| age key (SOPS)              | `/root/.config/sops/age/keys.txt` + offline copy | Re-encrypt every secrets file                       | 365d        |
| SSH keys                    | `~/.ssh/id_ed25519`                              | Re-add to GitHub and the VPS                        | 365d        |
| Tailscale auth key          | GitHub environment secret                        | New ephemeral key                                   | 90d         |

---

## `TOKEN_PEPPER` — read this before rotating it

The pepper is mixed into every stored hash. Change it and **every existing API key and
overlay token stops matching, permanently** — the plaintexts are gone, so they cannot be
re-hashed.

That is the correct behaviour for a compromised pepper. It is a bad surprise for a routine
rotation.

Before rotating:

1. Tell whoever runs the scanner — it will stop ingesting until re-keyed
2. Rotate
3. Mint a new key: `pnpm keys:create scanner ingest:write`, give it to the scanner
4. Every creator with a live overlay must regenerate it from their break page

For a _routine_ rotation, prefer doing this between streams rather than mid-break.

---

## `DATA_ENCRYPTION_KEYS` — add, switch, re-encrypt, then remove

This key ring encrypts fields that must stay secret even in a backup: break server seeds
before reveal, and live-sale buyer handles (ADR-029). Every value records which key wrote
it, so rotation has an order, and skipping ahead makes data unreadable.

1. **Add** a new key next to the old one, and make it active:

   ```
   DATA_ENCRYPTION_KEYS='{"k1":"<old>","k2":"<openssl rand -base64 32>"}'
   DATA_ENCRYPTION_ACTIVE_KID=k2
   ```

2. **Deploy.** New writes now use `k2`; old values still read with `k1`.
3. **Re-encrypt** everything written with the old key. Dry run first:

   ```bash
   pnpm keys:rotate --dry-run    # counts per key, and which keys are still needed
   pnpm keys:rotate              # does it; safe to run again
   ```

   It ends by saying which keys are **safe to remove**. If it reports any `FAILED` values,
   stop: those were written with a key that is not in the ring, and removing anything now
   loses them for good. It exits non-zero in that case.

4. **Remove** the old key only when that line names it, and deploy again.

**What to do with the removed key depends on why it was removed.**

- **Routine rotation:** keep the old key **offline** (password manager, not SOPS) until the
  oldest backup written before the rotation has aged out, which is 12 months on the
  schedule in `backups.md`. A restored backup needs it to reveal a break it holds.
- **Suspected exposure:** destroy it once step 3 is clean. Old backups then hold seeds and
  handles nobody can read. For buyer handles that's the right outcome. For an unrevealed
  seed in an old backup, it means that break could never be revealed from the backup. That's
  a smaller loss than a leaked key that still unlocks every backup.

## Rotating a SOPS-managed secret

```bash
# On your workstation, with the age key present.
sops infra/secrets/prod.sops.env          # opens decrypted; edit the value; save

# Generate replacements with real entropy — never invent one by hand:
openssl rand -base64 32

git add infra/secrets/prod.sops.env
git commit -m "chore(secrets): rotate <name>"
```

Then redeploy so the server picks it up: the deploy decrypts to tmpfs on every run
([`deploy.md`](deploy.md)). **A rotated secret that has not been deployed has not been
rotated.**

Verify afterwards:

```bash
curl -sI https://<host>/v1/me | head -n 1     # 401 — auth still works
curl -sf https://<host>/v1/games > /dev/null && echo "catalog ok"
```

## Rotating the age key

The one with a real failure mode: lose it and production secrets cannot be decrypted at all.

1. Generate the new key: `age-keygen -o ~/.config/sops/age/keys-new.txt`
2. Add its **public** key to `.sops.yaml` alongside the old one
3. `sops updatekeys infra/secrets/prod.sops.env` — re-encrypts to both
4. Install the new private key on the VPS at `/root/.config/sops/age/keys.txt` (mode `0400`)
5. Deploy, and confirm it works
6. **Only then** remove the old public key and `updatekeys` again
7. Store the new private key offline, in a second place

Never skip step 5. Removing the old key before proving the new one works locks you out of
your own secrets.

## Rotating an API key without downtime

Keys are independent rows, so overlap them:

1. `pnpm keys:create scanner-v2 ingest:write`
2. Put the new key in the scanner's config and restart it
3. Confirm ingestion is flowing (`/v1/ingest/stock` returning 202)
4. `pnpm keys:revoke <old-prefix>`

---

## Emergency rotation

When something is known-exposed, order matters — start with what grants the most.

1. **age key** — if this leaked, every other secret is readable. Rotate it first, then
   everything it protects
2. **Database passwords** — direct data access
3. **`DATA_ENCRYPTION_KEYS`** — the full add → re-encrypt → remove sequence above, then
   destroy the old key. With the database _and_ this key leaked, every seed and handle is
   readable, backups included
4. **`BETTER_AUTH_SECRET`** — ends every session, including an attacker's
5. **`TOKEN_PEPPER`** — kills every API key and overlay token
6. **Third-party tokens** — Discord, SMTP
7. **SSH and Tailscale** — remove the old keys from GitHub and the tailnet, do not merely
   add new ones

Then go back to [`incident.md`](incident.md) §6 and notify.

## Record it

Add a line to `docs/data-sources.md` with the date. Rotation you cannot evidence is
rotation you will redo needlessly — or, worse, skip because you think you already did it.
