# ADR-017: Overlay tokens as a database credential, and SSE without compression

- Status: Accepted (2026-09-20). Implements plan §11 (Phase 2).

## Context

The OBS overlay is opened by a URL pasted into a browser source. There is no account, no
session and no cookie: **the URL is the credential**. It has to work before the break starts
(you wire up OBS first), it has to stop working the instant it is regenerated, and it must
never show anything the creator did not type for display.

## Decisions

### 1. The overlay token is checked by Postgres, not just by application code

`breaks` has row-level security. The obvious approach — exempt the overlay lookup from RLS
because it has no user — would have made the one un-policied path the one reachable without
authentication.

Instead the token's HMAC is presented to the database for the transaction
(`set_config('app.overlay_token', <hash>, true)`) and a policy admits exactly the row whose
stored hash matches:

```sql
CREATE POLICY breaks_select_by_overlay_token ON app.breaks
  FOR SELECT USING (overlay_token_hash = current_setting('app.overlay_token', true));
```

Consequences:

- A draft break is readable **only** by its creator or by the holder of its token. A test
  asserts that an unscoped connection counting that row gets zero.
- Revocation needs no revocation list: rotation overwrites the hash, so the old token matches
  nothing. "Deleted" and "never existed" are the same state.
- The setting holds the hash, never the token, so the secret is not in the session either.
- `set_local` semantics mean a pooled connection cannot carry one viewer's access into the
  next request.

### 2. Server-sent events, not websockets or polling

One direction, reconnects by itself, and OBS's browser source handles it with no extra
machinery. The connection is capped at 5 per token, heartbeats every 15s, and closes after an
idle timeout.

**A rotated token drops live viewers**: the poll notices the break is gone, emits `revoked`
and closes. A credential that has been revoked should not keep working for whoever already
had it open.

### 3. Nothing compresses the stream

This cost an afternoon, so it is written down.

Next gzips responses by default, including proxied ones. A compressor holds bytes back until
it has a full block — so the overlay connected, got `200` and the right `content-type`, and
then received **nothing** until the connection closed. `EventSource.readyState` was 1 the whole
time. It looks exactly like a broken application.

Both layers are now configured not to compress event streams: `compress: false` in
`next.config.ts` (Caddy compresses at the edge, so Next doing it again bought nothing), and an
explicit content-type allowlist in the Caddyfile. Caddy's default is `text/*`, which **includes
`text/event-stream`**, and its response matchers have no negation — hence a list.

### 4. Two root layouts, via route groups

The overlay must render with a transparent background and no navigation: OBS composites the
page over video, so any chrome or background colour appears on stream as a grey box. Next
applies the root layout to everything, so the app is split into `(site)` and `(overlay)` route
groups, each with its own root layout. URLs are unchanged.

### 5. Pull logs are append-only from the start

`UPDATE` and `DELETE` on `break_pulls` are revoked from the app roles now, before there is any
data, because Phase 4 hash-chains this table and that only means something if the history was
never rewritable. A correction will be a new row.

## Consequences

- The creator role is granted by CLI only (`pnpm role:set`), and every change writes the
  previous and new role to the audit log. It is `input: false` in Better Auth, so no session
  can grant it to itself.
- Values are frozen at the moment of the pull. A break log is a record of what it was worth
  then; a later price move must not silently rewrite it.
- The public view returns no creator id, name or email at all — stream-safe is enforced by
  what the query selects, not by what the template happens to render.
