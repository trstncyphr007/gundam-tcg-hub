# Runbook: Hostinger VPS setup

Plan reference: §15. Follow this once, when the VPS is bought. Everything before this point
runs locally, so nothing here is urgent.

Host configuration is **Ansible**, not a list of commands to paste
(`infra/vps/ansible/`). That matters for one reason: rebuilding this host after a failure
should be a command, not an afternoon of following a document (threat T17). It is also
reviewable, lintable and re-runnable — a second run reports no changes.

## Status

| Step                                                    | State                                                                                                                                                           |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production compose stack, Caddy config, hardened images | ✅ built and **verified locally** (`bash scripts/verify-prod-stack.sh`)                                                                                         |
| Release pipeline (build, scan, SBOM, sign, push)        | ✅ written; runs on merge to `main`                                                                                                                             |
| Deploy workflow + server-side deploy script             | ✅ **rehearsed end to end** on a workstation against the real signed images (`scripts/deploy-rehearsal.sh`, 2026-09-23); the workflow half still needs a server |
| Preflight check (`infra/vps/preflight.sh`)              | ✅ written; exercised against fake `/srv/gth` trees, not a real host                                                                                            |
| Image packages public (ADR-032)                         | ✅ done 2026-09-23; anonymous pull + signature + SBOM verified                                                                                                  |
| Host hardening playbook                                 | ✅ written; lint + syntax clean, **container-smoked**, not host-tested                                                                                          |
| VPS provisioned and hardened                            | ⬜ waiting on the VPS                                                                                                                                           |
| Domain, TLS, backups                                    | ⬜ waiting on the domain                                                                                                                                        |

**What "container-smoked" means.** `infra/vps/ansible/smoke.sh` runs the playbook twice
against a throwaway Ubuntu 24.04 container and fails if the second run changes anything. That
exercises the package, file, template and download tasks — and it is how four real bugs were
found before any server existed. It does **not** exercise systemd, sysctl, ufw or Tailscale,
because a container has none of them. Those remain unproven until step 4.

## 1. Buy the VPS

Hostinger → KVM plan, **≥2 vCPU / 8 GB RAM / 100 GB NVMe**, US region, **Ubuntu 24.04 LTS**,
no control panel. Add your SSH public key during setup.

## 2. Make yourself reachable (by hand, as root, once)

The playbook cannot bootstrap the account it connects as, and it will refuse to close port 22
until Tailscale is up — so these three things happen first.

```bash
apt update && apt -y install curl

# The account Ansible and CI connect as.
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
install -d -m 700 /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh

# Tailscale, before the firewall closes public SSH.
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --ssh --advertise-tags=tag:vps
```

**Confirm you can reach the host over Tailscale from another terminal before continuing.**
The firewall role asserts `tailscale0` exists precisely because "I'll set that up afterwards"
has exactly one outcome.

In the Tailscale admin console: create an **OAuth client** (scope `auth_keys`, tag `tag:ci`)
for the deploy workflow, and an ACL allowing only your devices and `tag:ci` to reach
`tag:vps:22`.

## 3. Run the playbook (from your workstation)

```bash
cd infra/vps/ansible
cp inventory.example.ini inventory.ini    # then edit: the Tailscale hostname
pipx install ansible-core ansible-lint
ansible-galaxy collection install -r requirements.yml

ansible-playbook site.yml --check --diff   # dry run, always, first
ansible-playbook site.yml --diff
ansible-playbook site.yml --diff           # again: it must report zero changes
```

What it does, in order — `base` (packages, UTC, unattended security upgrades, chrony),
`users` (the deploy account and a sudo rule for exactly one script), `kernel` (sysctl
hardening), `ssh` (keys only, modern algorithms, no root), `firewall` (deny inbound except
80/443 and Tailscale), `docker` (engine with `userns-remap`), `crowdsec`, `audit` (auditd
rules on the files that decide who may do what, plus Lynis), `app` (directory layout, compose
and Caddy files, checksum-verified cosign and sops), `backups` (restic, nightly timer,
failure alert).

## 4. Prove the parts a container could not

```bash
# From another machine: only 80 and 443 should answer.
nmap -Pn <public-ip>

# On the host:
sshd -T | grep -E 'permitrootlogin|passwordauthentication|allowusers'
sysctl kernel.kptr_restrict fs.protected_regular
ufw status verbose
systemctl is-enabled gth-backup.timer
lynis audit system --quick | tail -n 20    # record the index below; target ≥ 75
```

| Date | Lynis hardening index | `nmap` result | By  |
| ---- | --------------------- | ------------- | --- |
|      |                       |               |     |

## 5. Secrets

The playbook creates `/root/.config/sops/age/` but never puts a key in it — a secret that
passes through CI is not a secret. Copy the age private key there yourself (mode `0400`).

On your workstation, create `infra/secrets/production.sops.env` (encrypted to your age key
**and** the server's), containing the variables from `.env.example` plus:

```
SITE_ADDRESS=<domain>          # or :80 before there is one — see below
ACME_EMAIL=<you@domain>
API_BASE_URL=https://<domain>
APP_BASE_URL=https://<domain>
SMTP_URL=smtp://<provider>
DATA_ENCRYPTION_KEYS='{"k1":"<openssl rand -base64 32>"}'
DATA_ENCRYPTION_ACTIVE_KID=k1
WEBAUTHN_RP_ID=<domain>
WEBAUTHN_ORIGIN=https://<domain>
```

**`SITE_ADDRESS` must be a domain or `:80`.** Caddy publishes ports 80 and 443 and nothing
else, so a bare port like `:8088` produces a stack that starts, reports every container
healthy, and cannot be reached — the deploy then fails its own smoke test and rolls back a
release that was fine. Found by rehearsing the deploy (`scripts/deploy-rehearsal.sh`), which is
exactly the sort of thing that is obvious afterwards.

`WEBAUTHN_RP_ID` is the domain every passkey is bound to (ADR-025). The API refuses to
start if it is an IP address or if `WEBAUTHN_ORIGIN` is not on it, and compose refuses to
start without either. **Choose it once.** Changing it later orphans every passkey already
enrolled, and admins — who can only use the console with a passkey — are locked out until
they enrol again. Use the bare domain, not `www.`, so a later move to a subdomain still
works.

Once the site is up, the first admin enrols a passkey at `/account/security` straight
after a fresh email sign-in, **before anyone else could have used that inbox**. That first
enrolment is the one step that email alone can do.

`DATA_ENCRYPTION_KEYS` encrypts fields that must stay secret even in a backup: a break's
server seed, and buyer handles from the live-sale logger. **Losing it makes those fields
unrecoverable**, so it belongs in the password manager alongside the age key. For the buyer
handles that is the intended property rather than a risk — they are somebody else's name and
are erased after 90 days anyway — but a lost key also means no break committed before the
loss can ever be revealed. The API refuses to start in production while it, the token pepper
or the auth secret still hold their development defaults.

Copy the encrypted file to `/srv/gth/production/secrets.sops.env`. It is safe in git and safe
on disk; only the age key decrypts it, into tmpfs, at deploy time.

Backups need `/etc/gth/restic.env` as well — see `docs/runbooks/backups.md`. The playbook
warns rather than fails when it is missing, so a fresh host still converges.

One more root-only file, mode 0400: `/etc/gth/ops.env`, holding `DISCORD_OPS_WEBHOOK_URL=…`.
Without it a failed backup or a failed nightly job alerts nobody — the alert unit exits
quietly rather than failing on top of the failure it was reporting. `preflight.sh` checks
for it.

**The same webhook belongs in GitHub**, as a repository secret of the same name
(`DISCORD_OPS_WEBHOOK_URL`). Without it a failed nightly scan or a failed release tells nobody,
which is precisely what happened for three nights in September before anyone thought to look.
The workflows run either way and log that no webhook is set.

The nightly jobs themselves need nothing: the playbook installs their units and timers
(`roles/jobs`), and one of them deletes personal data on a clock, so it is not optional.

## 6. GitHub secrets for the deploy workflow

| Name                                     | Value                                    |
| ---------------------------------------- | ---------------------------------------- |
| `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` | Tailscale OAuth client (tag `tag:ci`)    |
| `DEPLOY_SSH_KEY`                         | Private key of a deploy-only SSH keypair |
| `DEPLOY_HOST`                            | The VPS's Tailscale hostname             |
| `BASE_URL` (variable, not secret)        | `https://<domain>`                       |

## 7. First deploy

1. Merge to `main` → the **release** workflow builds, scans, signs, attests and pushes
   images, verifies their provenance, and prints the digests in its summary.
2. **Preflight, on the server:** `sudo /srv/gth/preflight.sh staging <api-digest> <web-digest>`.
   Fix every FAIL before going on — each one is a deploy that would fail, or worse, succeed
   wrongly. (See `deploy.md` → Preflight.)
3. Run the **deploy** workflow, pasting those digests, environment `staging` first.
4. Check the smoke test passed. Then preflight `production`, and deploy it.

The smoke test goes through Caddy the way a visitor does — over HTTPS to the domain once
there is one — and allows a minute for Caddy's first certificate, so a brand-new domain does
not roll back a good release.

The server verifies the signatures again before anything starts, so an image this repository
did not build and sign cannot be deployed even by someone with SSH access.

## 8. After the first deploy

- [ ] Point the domain at the VPS via Cloudflare (proxied, SSL mode **Full (strict)**).
- [ ] Restrict inbound 80/443 to Cloudflare IP ranges, or switch to a Cloudflare Tunnel.
- [ ] Run a restore drill (`docs/runbooks/backups.md`) and record the time.
- [ ] Record the Lynis score and `nmap` output in the table above.
- [ ] **Publish the contact address** (see below).
- [ ] Add a **CAA** record so only your certificate issuer can issue for the domain, and set up
      SPF, DKIM and DMARC for the role mailbox before any mail is sent from it.

### Publishing the contact address

Create the role mailbox — `security@<domain>`, or one address that also covers privacy and
takedown requests — then set `CONTACT_EMAIL` in `apps/web/lib/site.ts` and redeploy.

Until it is set, `/privacy` and `/terms` say a contact is coming and
`/.well-known/security.txt` returns 404 rather than naming an address nobody reads (ADR-034).
Afterwards, `curl -sS https://<domain>/.well-known/security.txt` must list `Contact:` and an
`Expires:` date under six months away. The date is generated per request, so the file cannot
rot into an expired one on its own.
