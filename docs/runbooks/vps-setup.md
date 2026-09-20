# Runbook: Hostinger VPS setup

Plan reference: §15. Follow this once, when the VPS is bought. Everything before this point
runs locally, so nothing here is urgent.

## Status

| Step                                                    | State                                                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------- |
| Production compose stack, Caddy config, hardened images | ✅ built and **verified locally** (`bash scripts/verify-prod-stack.sh`) |
| Release pipeline (build, scan, SBOM, sign, push)        | ✅ written; runs on merge to `main`                                     |
| Deploy workflow + server-side deploy script             | ✅ written; **not yet exercised** (needs a server)                      |
| VPS provisioned and hardened                            | ⬜ waiting on the VPS                                                   |
| Domain, TLS, backups                                    | ⬜ waiting on the domain                                                |

## 1. Buy the VPS

Hostinger → KVM plan, **≥2 vCPU / 8 GB RAM / 100 GB NVMe**, US region, **Ubuntu 24.04 LTS**,
no control panel. Add your SSH public key during setup.

## 2. Base hardening (as root, once)

```bash
apt update && apt -y full-upgrade
apt -y install unattended-upgrades needrestart chrony curl ca-certificates

# A non-root user for deploys
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
install -d -m 700 /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh

# SSH: keys only, no root
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/;
        s/^#\?PasswordAuthentication.*/PasswordAuthentication no/;
        s/^#\?KbdInteractiveAuthentication.*/KbdInteractiveAuthentication no/' /etc/ssh/sshd_config
echo 'AllowUsers deploy' >> /etc/ssh/sshd_config
systemctl restart ssh
```

## 3. Tailscale, then close SSH to the internet

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --ssh --advertise-tags=tag:vps
```

Then in the Tailscale admin console: create an **OAuth client** (scope `auth_keys`, tag
`tag:ci`) for the deploy workflow, and an ACL allowing only your devices and `tag:ci` to reach
`tag:vps:22`.

```bash
apt -y install ufw
ufw default deny incoming && ufw default allow outgoing
ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw allow in on tailscale0
ufw --force enable
# Verify from another machine: only 80/443 answer.
```

## 4. Docker, with user namespaces

```bash
curl -fsSL https://get.docker.com | sh
cat > /etc/docker/daemon.json <<'JSON'
{
  "userns-remap": "default",
  "no-new-privileges": true,
  "live-restore": true,
  "icc": false,
  "log-driver": "local",
  "log-opts": { "max-size": "10m", "max-file": "5" }
}
JSON
systemctl restart docker
usermod -aG docker deploy
```

## 5. CrowdSec and an audit baseline

```bash
curl -s https://install.crowdsec.net | sh && apt -y install crowdsec
apt -y install crowdsec-firewall-bouncer-iptables
cscli collections install crowdsecurity/sshd crowdsecurity/base-http-scenarios
systemctl reload crowdsec

apt -y install lynis && lynis audit system --quick | tail -n 20
# Record the hardening index in this file; target >= 75.
```

## 6. Application layout

```bash
install -d -m 0755 /srv/gth /srv/gth/production /srv/gth/staging
install -d -m 0700 /root/.config/sops/age
# Copy the age private key from your password manager to
#   /root/.config/sops/age/keys.txt   (chmod 0400)

# From your workstation:
scp infra/compose/docker-compose.prod.yml deploy@<host>:/srv/gth/production/
scp infra/caddy/Caddyfile               deploy@<host>:/srv/gth/production/
scp infra/vps/deploy.sh                 deploy@<host>:/tmp/
ssh deploy@<host> 'sudo install -m 0750 -o root -g root /tmp/deploy.sh /srv/gth/deploy.sh'
```

Install cosign and sops on the server (the deploy script needs both):

```bash
curl -fsSL -o /usr/local/bin/cosign \
  https://github.com/sigstore/cosign/releases/download/v3.1.3/cosign-linux-amd64
curl -fsSL -o /tmp/cosign_checksums.txt \
  https://github.com/sigstore/cosign/releases/download/v3.1.3/cosign_checksums.txt
grep ' cosign-linux-amd64$' /tmp/cosign_checksums.txt | \
  sed 's|cosign-linux-amd64|/usr/local/bin/cosign|' | sha256sum -c -
chmod +x /usr/local/bin/cosign
```

Allow the deploy user to run only that one script as root:

```bash
echo 'deploy ALL=(root) NOPASSWD: /srv/gth/deploy.sh' > /etc/sudoers.d/40-gth-deploy
chmod 0440 /etc/sudoers.d/40-gth-deploy
visudo -cf /etc/sudoers.d/40-gth-deploy
```

## 7. Secrets

On your workstation, create `infra/secrets/production.sops.env` (SOPS + age, encrypted to your
age key **and** the server's), containing the variables from `.env.example` plus:

```
SITE_ADDRESS=<domain>
ACME_EMAIL=<you@domain>
API_BASE_URL=https://<domain>
APP_BASE_URL=https://<domain>
SMTP_URL=smtp://<provider>
```

Copy the encrypted file to `/srv/gth/production/secrets.sops.env`. It is safe in git and safe
on disk; only the age key decrypts it, into tmpfs, at deploy time.

## 8. GitHub secrets for the deploy workflow

| Name                                     | Value                                    |
| ---------------------------------------- | ---------------------------------------- |
| `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` | Tailscale OAuth client (tag `tag:ci`)    |
| `DEPLOY_SSH_KEY`                         | Private key of a deploy-only SSH keypair |
| `DEPLOY_HOST`                            | The VPS's Tailscale hostname             |
| `BASE_URL` (variable, not secret)        | `https://<domain>`                       |

## 9. First deploy

1. Merge to `main` → the **release** workflow builds, scans, signs and pushes images, and
   prints the digests in its summary.
2. Run the **deploy** workflow, pasting those digests, environment `staging` first.
3. Check the smoke test passed, then repeat with `production`.

The server verifies the signatures again before anything starts, so an image that this
repository did not build and sign cannot be deployed even by someone with SSH access.

## 10. After the first deploy

- [ ] Point the domain at the VPS via Cloudflare (proxied, SSL mode **Full (strict)**).
- [ ] Restrict inbound 80/443 to Cloudflare IP ranges, or switch to a Cloudflare Tunnel.
- [ ] Set up backups (`docs/runbooks/backups.md`) and run a restore drill.
- [ ] Record the Lynis score and `nmap` output in this file.
