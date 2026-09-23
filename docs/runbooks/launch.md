# Runbook: Launch day

Plan reference: M3 and M4 (§26). **Follow this in order.** Everything here exists and has been
rehearsed somewhere — what has _not_ been rehearsed is saying so at each step.

The ordering is the point. Three of these steps are one-line changes that are easy to make
early and dangerous to make early: publishing a contact address that reaches nobody, opening
the site to crawlers before it works, and giving the first admin a passkey after other people
could already reach the inbox.

---

## Before the server

- [ ] **Buy the VPS** — Hostinger KVM, ≥2 vCPU / 8 GB / 100 GB, Ubuntu 24.04, no control panel
      (`vps-setup.md` §1).
- [ ] **Buy the domain** and put it behind Cloudflare, proxied, SSL mode **Full (strict)**.
- [ ] **Create the Discord ops channel and its webhook.** One URL, used in three places (below).
      Everything built for alerting is inert without it.

## Set the server up

- [ ] Bootstrap the `deploy` account and Tailscale by hand (`vps-setup.md` §2) — the playbook
      cannot create the account it connects as, and refuses to close port 22 until Tailscale is
      up.
- [ ] Run the playbook twice; the second run must report **zero changes** (`vps-setup.md` §3).
- [ ] Prove what a container could not: `nmap` shows only 80/443, SSH is Tailscale-only, the
      backup timer is enabled, Lynis ≥ 75 (`vps-setup.md` §4). Record the numbers there.

## Secrets, in three files

- [ ] `/root/.config/sops/age/keys.txt` — the age private key, copied by hand, mode 0400. It
      never passes through CI.
- [ ] `/srv/gth/production/secrets.sops.env` — the application's settings, encrypted to that key
      **and** yours (`vps-setup.md` §5). `SITE_ADDRESS` must be the domain (or `:80` — never an
      arbitrary port; see the note there).
- [ ] `/etc/gth/restic.env` and `/etc/gth/ops.env` — backup credentials and the ops webhook
      (`backups.md`). Both root-only, mode 0400.
- [ ] **The same webhook as a GitHub repository secret** named `DISCORD_OPS_WEBHOOK_URL`, so a
      failed nightly scan or release reaches the same channel.
- [ ] `bash /srv/gth/preflight.sh` — it checks all of the above and changes nothing.

## First deploy

- [ ] Run the **deploy** workflow (`deploy.md`). It verifies signatures, migrates, starts, smoke
      tests, and rolls back on failure — all rehearsed locally (`scripts/deploy-rehearsal.sh`).
- [ ] Watch for `/`, `/v1/games` and `/docs` answering 200. The smoke test checks all three.

## The first admin, before anyone else exists

- [ ] Sign in by email **once**, then enrol a passkey immediately at `/account/security`.
      That first enrolment is the only step an inbox alone can do (ADR-025), and every admin
      action afterwards requires the passkey. Doing it before the site is public means nobody
      else could have been in that inbox.
- [ ] Grant yourself `admin` with the role CLI, then check `/admin/operations` opens.

## Then, and only then, go public

- [ ] **`CONTACT_EMAIL`** in `apps/web/lib/site.ts` — set it to the role address once that
      mailbox exists and somebody reads it. This publishes `/.well-known/security.txt`; until
      then it is deliberately a 404 (ADR-034).
- [ ] **`SITE_IS_PUBLIC`** in the same file — `true` opens the site to crawlers and switches
      `robots.txt` from "refuse everything" to "allow, except the private areas". Account,
      admin and overlay pages carry their own `noindex` and are unaffected.
- [ ] Deploy again so both take effect, and check: `curl https://<domain>/robots.txt` and
      `curl https://<domain>/.well-known/security.txt`.

## Domain hygiene, same day

- [ ] **CAA** record, so only your certificate issuer can issue for the domain.
- [ ] **SPF, DKIM, DMARC** for the mailbox that sends sign-in links — a magic-link email that
      lands in spam is a sign-in page that does not work.
- [ ] Cloudflare: WAF managed rules, Bot Fight Mode, a rate limit on `/api/auth/*`, Always Use
      HTTPS. Restrict inbound 80/443 to Cloudflare ranges once traffic is flowing.
- [ ] Submit HSTS preload only after 30 stable days (`vps-setup.md` §8).

## In the first week

- [ ] **Run the restore drill on the server** and record the timing (`backups.md`). The
      procedure is rehearsed locally; the numbers there are a workstation's.
- [ ] **Re-measure performance on the VPS** (`performance.md`). A 2-vCPU server is not a
      16-core workstation; only the shape of those numbers transfers.
- [ ] Check `pg_stat_user_indexes` after real traffic before acting on the unused-index list in
      `performance.md`.
- [ ] Confirm the daily "all clear" from the watchdog is arriving. **If it stops, that is the
      signal** (ADR-038).

---

## What is still not built when you launch

Stated here so it is a decision rather than a surprise:

- **Web push and Discord DM alerts.** Email works; those two channels are stubs. The Discord
  bot needs a token, and web push adds an outbound request to endpoints the client supplies —
  an SSRF surface worth building carefully rather than in a launch week.
- **The marketplace** (Phase 5) — and with it payments, uploads and their threat coverage.
- **A lawyer's review** of `/privacy` and `/terms`. They are accurate, which is not the same
  thing (ADR-034).
