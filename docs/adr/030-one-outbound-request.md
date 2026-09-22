# ADR-030: The platform makes one outbound request, and CI keeps it that way

- **Status:** Accepted
- **Date:** 2026-09-22
- **Plan reference:** SR-1.1, SR-1.2, ASVS 1.12, threat T2

## Context

ASVS 1.12 (SSRF) was Partial, with the gap "no DNS-rebinding check on resolved IPs — lands
with the first user-supplied URL". Before building that check, I looked at what this
repository actually fetches.

- **Exactly one outbound HTTP request exists in server code:** the restock alert's post to a
  Discord webhook (`packages/alerts/src/transports.ts`). It's guarded by an exact-host
  allowlist (`discord.com`, `discordapp.com`, `ptb.discord.com`), https only, on the webhook
  path. Tests cover lookalike hosts, loopback and cloud metadata addresses.
- **Every user-supplied URL is stored, never fetched:**
  - price-report evidence
  - break and pull VOD links
  - live-sale stream references
  - listing URLs reported by the scanner

  The server never requests any of them. They're validated as `https` links and rendered for
  a person to click.

- **The fetching of attacker-influenced pages lives in the scanner**, which is Python in its
  own repository (ADR-013). That's where retailer pages are requested, and where a
  resolved-address check belongs.

DNS rebinding works by getting a server to resolve an _attacker-chosen name_ twice: once to
pass a check, and again to connect somewhere internal. An exact allowlist of names only
Discord controls leaves no attacker-chosen name to rebind. Building a resolver check here
would have guarded a door that doesn't exist, while the real one stayed in another repo.

## Decision

### 1. Refuse redirects on the one request

The allowlist checks where a request _starts_. `fetch` follows redirects by default, which
would let the response decide where it _ends_, unchecked. SR-1.1 requires redirects to be
re-validated. A webhook post never legitimately redirects, so the transport sets
`redirect: 'error'` and a 3xx becomes an ordinary failed delivery. Both are tested.

### 2. Make "one outbound request" a CI failure to break

A new Semgrep rule, `gth-no-outbound-http`, fails the build if server code (`apps/api`,
`packages/*`) calls `fetch`, imports `node:http`, `https`, `http2` or `dgram`, or imports an
HTTP client library, anywhere but the transport module. Tests are exempt.

The rule's message says what a new outbound request needs: an allowlist, a redirect policy,
and resolved-address checks if a user can choose the host. The day someone adds one, the
build explains the work instead of silently widening the attack surface.

I checked the rule both ways: the tree passes, and a planted `fetch` in the API plus a
planted `node:http` import in `packages/db` both fail it.

## Consequences

- ASVS 1.12 is **Met for this repository**. The checklist records that the resolved-address
  check is owed by the scanner repo, where attacker-influenced pages are actually fetched.
- **When a feature first needs the server to fetch a user-supplied URL,** Semgrep will stop
  it. The resolver check (resolve, reject private/loopback/link-local/metadata ranges, connect
  to _that_ address, re-check on every redirect) gets built then, against a real caller.
