# Data Sources and Third-Party Integrations

**Required by SR-X.30:** every integration, what it can reach, where its credential lives,
when it was last rotated, and what data crosses the boundary.

**Reviewed: 2026-09-20.**

The point of this file is that nobody has to read the code to answer "what does this system
talk to, and what would leak if that thing were compromised".

---

## 1. Live integrations

### Postgres 17

|             |                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What it is  | System of record                                                                                                                                          |
| Credentials | Four roles — `app_migrator`, `app_web`, `app_worker`, `app_readonly` — in `.env` locally, SOPS-encrypted for prod                                         |
| Scope       | Each role has only what it needs: `app_readonly` cannot write, `app_web` cannot run DDL, `app_worker` cannot read a creator's breaks, nobody is superuser |
| Data        | Everything. Accounts, watches, break logs, stock history                                                                                                  |
| Rotation    | Generated per machine by `pnpm env:init`; prod rotates per SR-0.15                                                                                        |
| Network     | Internal Docker network, **no published ports** in production                                                                                             |

### Valkey 8 — removed 2026-09-24

Listed here as "queues, cache and rate limits", and doing none of it: nothing in the repository
ever opened a connection to it. Rate limits and the flag cache live in process memory, the
daily API quota lives in Postgres, and the scheduled jobs are one-shot containers rather than a
queue. Removed from both stacks — see [ADR-042](adr/042-the-quota-outlives-the-process.md),
which also records what brings it back.

### SMTP (Mailpit locally; a provider in production)

|                 |                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| What it is      | Sign-in links and restock alert emails                                                                                               |
| Credentials     | `SMTP_URL`                                                                                                                           |
| Data leaving us | Recipient address, product name, price, shop link. **Never** a session token — sign-in links are single-use and expire in 15 minutes |
| Rotation        | On provider signup, then per SR-0.15 (180 days)                                                                                      |
| Status          | **Not yet configured for production.** The API refuses to boot in production without it                                              |

### Discord (planned, not yet wired)

|                 |                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| What it is      | OAuth sign-in, and alert delivery by DM or channel webhook                                                                                  |
| Credentials     | `DISCORD_CLIENT_ID`/`SECRET`, `DISCORD_BOT_TOKEN`, `DISCORD_ALERT_WEBHOOK_URL`                                                              |
| Scope           | OAuth `identify` only, plus `email` **only if** the user opts into email alerts. Gateway intents: `Guilds` only — no message-content intent |
| Data leaving us | Product name, price, shop link, and the recipient's Discord id                                                                              |
| Rotation        | Per SR-0.15; immediately on suspected exposure                                                                                              |
| Status          | **Credentials not issued.** Alert transports exist and fall back to "unsupported"                                                           |

### GitHub

|             |                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------ |
| What it is  | Source, CI, and the container registry (GHCR)                                                    |
| Credentials | Per-run `GITHUB_TOKEN`, `permissions: {}` by default; a Tailscale ephemeral auth key for deploys |
| Data        | Source code, build artifacts, SBOMs, signatures                                                  |
| Notes       | Private on Free, so no rulesets, push protection or code scanning (ADR-014)                      |

---

## 2. Retailers the scanner reads

Full evidence, per shop, is in
[`gundam-scanner/docs/sources.md`](https://github.com/trstncyphr007/gundam-scanner-bot/blob/main/SOURCES.md)
(published so the shops themselves can check it). The platform's own copy is
`packages/db/src/seed/sources.json`, and the database refuses to enable a retailer until its
review is recorded.

**Nothing here involves an account, a login, a cart or a checkout.** The scanner reads the
same product pages any visitor sees: name, price, in stock or not.

| Shop                                         | Status      | Basis                                                                          |
| -------------------------------------------- | ----------- | ------------------------------------------------------------------------------ |
| Troll and Toad                               | on          | Shopify, `Allow: /`                                                            |
| 401 Games                                    | on          | Shopify, `Allow: /`                                                            |
| Face to Face Games                           | on          | Shopify, `Allow: /`                                                            |
| Miniature Market                             | on          | `Crawl-delay: 10`, honoured                                                    |
| CoolStuffInc                                 | **off**     | Robots permits the page, but results load from `/ajax`, which robots disallows |
| Premium Bandai                               | **off**     | Serves an anti-bot challenge rather than a storefront                          |
| eBay, Walmart, Star City Games, Bandai Store | **blocked** | `robots.txt` disallows the search path                                         |
| Amazon, TCGplayer                            | **blocked** | Dropped on terms-of-service grounds, 2026-09-20                                |

The scanner identifies itself as
`GundamScanner/1.0 (+https://github.com/trstncyphr007/gundam-scanner-bot; …)`, and that page
tells any operator what it does and how to make it stop.

**Outreach in flight:** a request to Bandai for a feed, an API, or permission to read
p-bandai.com with an identified bot. Drafted in `TCG Market Project/docs/bandai-api-outreach.md`.

---

## 3. Not integrated, deliberately

|                              | Why                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| TCGplayer                    | Terms restrict automated use, and it is the incumbent this project differentiates from                                                               |
| Amazon                       | Conditions of Use bar automated data gathering outright                                                                                              |
| eBay / Walmart **web**       | `robots.txt` disallows the search paths. Official APIs (`ebay_api`, `walmart_api`) are the sanctioned route and are implemented but need credentials |
| Analytics                    | None. If ever added it must be self-hosted and cookieless (SR-X.16)                                                                                  |
| Third-party scripts or fonts | None. The CSP has no external script or font origins, so there is nothing to subvert                                                                 |

---

## 4. Planned, with obligations attached

| Phase | Integration                        | Obligation to honour                                                    |
| ----- | ---------------------------------- | ----------------------------------------------------------------------- |
| 3     | eBay Browse / Marketplace Insights | Approval required; display and attribution terms apply                  |
| 5     | Stripe Connect                     | PCI SAQ-A — card data never touches our servers                         |
| 5     | S3-compatible object storage       | Private bucket, presigned uploads, served through processed copies only |
| 5     | ClamAV                             | Local container, nothing leaves                                         |

---

## 5. Review

Re-read this file when adding any integration, and at the start of every phase. For each
one, answer three questions in writing: **what can it reach, where does its credential live,
and what leaves us.** An integration whose row cannot be filled in is not ready to ship.
