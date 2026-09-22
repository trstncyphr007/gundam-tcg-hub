# ADR-028: IP addresses at rest are same-day hashes

- **Status:** Accepted
- **Date:** 2026-09-22
- **Plan reference:** SR-X.24 ("IPs as salted hashes, daily-rotating salt, except in the
  short-lived rate-limit store"), SR-X.23; the open item in ADR-026 and ADR-027

## Context

Better Auth records the address of every sign-in in `sessions.ip_address`, in full. A
comment in our schema said it was truncated, but it wasn't. The probe in ADR-026 returned
whole addresses. ADR-026 stopped showing them on any page, and ADR-027 put them in the owner's
export, but they were still at rest in the database. A database leak would have leaked every
member's address history. That's a list of where people live and work, with dates.

A survey of where else addresses end up:

- **API request logs:** our pino serializer already writes only id, method and URL.
- **Caddy:** configured with no access log at all.
- **Rate limiters:** Better Auth's and Fastify's both hold addresses in memory for a minute
  or an hour. That's the exception the plan allows.
- **The audit log:** has an `ip_hash` column that nothing writes yet.

So `sessions` was the one place that mattered.

## Decision

### 1. Hash at the only place the address is written

Better Auth writes the IP in exactly one place, `createSession`, which I checked in its
source. Our `session.create.before` hook already sets `authMethod`, and now it also replaces
`ipAddress` with `hashIp(ip, secret)`.

### 2. The hash

```
iph1:<YYYY-MM-DD>:<22 base64url chars>
dayKey = HMAC-SHA256(BETTER_AUTH_SECRET, "gth:ip-hash:v1:<day>")
value  = HMAC-SHA256(dayKey, normalised address)[0..16]
```

- **Same day, same network, same value.** The only question the stored value exists to
  answer is "were these two sign-ins from the same place?". Answering it is also what makes
  a new-device email or an incident review make sense.
- **Different day, different value.** There's no way to follow an address, or a person,
  across days, which is the part of an IP log that makes it a tracking log. The salt rotates
  without anything being stored or rotated by hand: each day's key is derived, and yesterday's
  can't be recovered from today's.
- **Keyed by the server secret.** All of IPv4 is only four billion guesses, so an unkeyed
  hash would be reversible from a database copy alone. With the key it isn't.
- **Normalised first.** An IPv4-mapped IPv6 address is unwrapped and IPv6 is lowercased, so
  one network doesn't hash several ways. Anything that isn't an address is stored as null,
  not hashed.
- **The day in the value** says which values may be compared. It reveals nothing that the
  session's own `created_at` doesn't.

### 3. The database refuses anything else

The check `sessions_ip_hashed` accepts only null or the exact `iph1:` format. A future bug, a
Better Auth upgrade that starts writing somewhere new, or a hand-run script fails loudly
instead of quietly storing an address. A test tries it from the web role.

### 4. Existing raw addresses are cleared, not hashed

Migration 0034 sets every non-conforming `ip_address` to null before adding the check. They
can't be hashed in SQL, because the database never sees the secret and the day is part of the
key. Sessions last 30 days at most, so only current sessions lose their origin, and "no
address" is the nearest compliant form of an address already held.

### 5. The export says what it is

The owner's export (ADR-027) now carries `ipHash`, not `ipAddress`. It's what we hold, named
for what it is. A test checks the raw address appears nowhere in the file.

## Consequences

- SR-X.24 is met for data at rest. The only raw addresses left are in the in-memory rate
  limiters, which the plan exempts.
- **Changing `BETTER_AUTH_SECRET` changes every future hash.** That doesn't matter for
  correctness, since values only compare within a day anyway, but a rotation mid-day makes
  "same network" read as "different" for that one day.
- **Test change:** `sessions.test.ts` now runs with `API_TRUST_PROXY=true`, as production does
  behind Caddy. With everything arriving from 127.0.0.1, the file's growing number of sign-ins
  had started to trip the API's own per-IP limit.
