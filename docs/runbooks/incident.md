# Runbook: Incident Response

Plan §22. Written for one person under pressure, so it is short and ordered.

**First: write down the time and what you noticed.** Everything after this is easier with a
timeline, and you will not reconstruct it later.

---

## 1. Classify

| Severity | Means                                                         | Response             |
| -------- | ------------------------------------------------------------- | -------------------- |
| **SEV1** | Personal data exposed, money lost, or production down         | Drop everything      |
| **SEV2** | Degraded service, or a vulnerability being actively exploited | Same day             |
| **SEV3** | Everything else                                               | Next working session |

If you are unsure between two, take the higher one. Downgrading later is free.

## 2. Contain before you investigate

The instinct is to understand it first. Resist that — stop the bleeding, then investigate
with the clock stopped.

**Kill switches** — go to **`/admin/switches`** and flip one. Each needs a reason, is written
to the audit log, and takes effect everywhere within ten seconds (ADR-039).

| Switch                   | Stops                                  | Still works                       |
| ------------------------ | -------------------------------------- | --------------------------------- |
| `alerts.enabled`         | Alerts being **sent**                  | Restocks are still recorded       |
| `api.public.enabled`     | The public catalog and price API (503) | Sign-in, this console, `/healthz` |
| `scanner.ingest.enabled` | New stock reports (503)                | Nobody's API key is revoked       |

**You cannot lock yourself out.** Switching off the public API deliberately leaves sign-in and
the console up: a switch that shuts the door on the room it lives in is a trap, not a control.

**To stop one shop only**, disable that retailer in the catalog instead — these three are
all-or-nothing by design.

**Nothing turns itself back on.** The watchdog reminds you once a day that something is still
off, quoting the reason you typed when you pulled it.

**Revoke sessions globally** — rotate `BETTER_AUTH_SECRET` and redeploy. Every session
becomes invalid immediately. Users sign in again; that is a small price.

**Revoke a leaked API key:**

```bash
pnpm keys:revoke <prefix>     # takes effect on the next request
```

**Revoke a leaked overlay token:** regenerate it from the break page. The old one is dead
immediately and live viewers are dropped.

**Take the site off the internet** if you need to and nothing gentler will do:

```bash
ssh deploy@<vps>
sudo docker compose -p gth-production stop caddy
```

The databases have no published ports, so stopping Caddy removes every route in.

## 3. Assess

- **What was reachable?** Check `audit_log` — it is append-only, so it can be trusted even
  if the application was compromised:

  ```sql
  select at, actor_id, action, target_type, target_id, diff
    from app.audit_log
   where at > now() - interval '48 hours'
   order by at desc;
  ```

- **What ran?** `docker compose -p gth-production logs --since 48h`
- **Which release?** `cat /srv/gth/production/last-good.env`
- **Was it us or a dependency?** Check for advisories published since the last green CI run

## 4. Eradicate and recover

1. Fix it, with a test that fails without the fix
2. Let CI run — do not hand-build an image for production
3. Deploy to staging, verify, promote
4. If data was damaged: [`restore.md`](restore.md)
5. If the host itself is suspect, **rebuild it** rather than cleaning it: Ansible plus the
   latest backup ([`backups.md`](backups.md)). You cannot prove a compromised box is clean

## 5. Rotate anything that was exposed

Anything the attacker could have read is burned, even if you think they did not read it.
[`key-rotation.md`](key-rotation.md) has the order and the commands.

## 6. Notify

| Who            | When                                                | What                                                              |
| -------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| Affected users | Within 72h of confirming personal data was involved | What happened, what data, what you have done, what they should do |
| Discord        | If the bot token leaked                             | Reset the token in the developer portal                           |
| Stripe         | Any payment involvement (Phase 5)                   | Through their support channel                                     |

Say what you know and what you do not. A short honest notice beats a polished late one.

## 7. Postmortem — within 5 days

Blameless, and written even for a near miss. Four headings:

1. **What happened** — timeline, in plain language
2. **Why it was possible** — the condition, not the person
3. **Why it was not caught** — this is the valuable part. Which gate should have fired?
4. **What changes** — as GitHub issues labelled `security`, with owners

A postmortem that produces no issue has not finished.

---

## Contacts and access

- Server: `ssh deploy@<vps>` **over Tailscale only** — SSH is not exposed publicly
- Secrets: `sops -d /srv/gth/<env>/secrets.sops.env`, needs the age key at
  `/root/.config/sops/age/keys.txt`
- **If you lose the age key you cannot decrypt production secrets.** It must exist in a
  second place, offline

## Standing risks worth remembering mid-incident

- `main` has **no server-side protection** (GitHub Free + private, ADR-014). An attacker
  with repo write access can push directly to it. If credentials are suspected compromised,
  check `main`'s history, not just the deployed images
- Local hooks can be bypassed with `--no-verify`; CI is the real gate
