# ADR-020: Generate OpenAPI from zod, and publish the index under CC BY 4.0

**Status:** Accepted
**Date:** 2026-09-21
**Context:** Phase 3, FR-3.6 / FR-3.7, SR-3.1 / SR-3.2 / SR-3.7, open item O5

---

## Context

The plan (§5, §12) calls for a public `/v1` API documented with OpenAPI 3.1 at `/docs`, and
names `@fastify/swagger` plus `fastify-type-provider-zod` as the way to get there. It also
leaves the licence for the published price index open (O5).

Both need deciding before anyone can build on this.

## Decision

### 1. The document is generated from zod, without Swagger

**Deviation from the plan, taken knowingly.** Neither named package is used.

- **zod 4 emits JSON Schema draft 2020-12 natively** (`z.toJSONSchema`), and that dialect
  _is_ OpenAPI 3.1's schema language. The translation those packages exist to perform now
  lives in a library we already depend on for validation.
- **A hosted docs viewer would break our own CSP.** Swagger UI and Scalar both load script
  from a CDN, which SR-X.16 forbids; vendoring one means shipping and patching a megabyte of
  someone else's JavaScript to render six endpoints.
- **Fewer dependencies on the path that authenticates and serves everything** (SG3).

The cost is `apps/api/src/v1/openapi.ts`: roughly a hundred lines that have to track the
OpenAPI object shape. It is covered by tests that parse its output, and the trigger to
reconsider is a real need for request-body schemas across many methods — today every public
route is a GET.

### 2. One registry drives the routes and the document

`apps/api/src/v1/routes.ts` is a list of endpoint definitions. The router is built from it
and the document is generated from it, so the published contract cannot describe an endpoint
that does not exist, or miss one that does. A test asserts the two lists match, and a
contract test validates every real response against the schema the document was generated
from — without that, "the OpenAPI says so" is a claim about a file rather than about the
server.

### 3. Docs are server-rendered HTML with no JavaScript

`/docs` is generated from the spec at boot and served as plain HTML. It loads nothing from
anywhere, so it needs no exception to the API's locked-down policy, and it cannot be the
thing that introduces a script-injection bug into a security-relevant origin. The
machine-readable document is at `/docs/openapi.json`.

### 4. A key is optional; it buys you your own allowance

Anonymous requests are allowed and share the per-IP limit. A key gets 60 requests a minute
and 1,000 a day of its own, and exempts the caller from the IP bucket — which is fairer (an
office shares one address) and attributable (we know whose traffic it was).

An API you must sign up for is an API nobody tries. The incentive to take a key is a better
allowance, not a locked door.

### 5. Self-serve keys are read-only, enforced three times

A key minted from a session can hold only `catalog:read` and `prices:read`. That is checked
in the query layer, by a row-level security policy, and by a CHECK constraint on the table.
Three layers, because the consequence of a write-scoped self-serve key is someone else's
data.

The scanner's first-party key, which does hold `ingest:write`, has no owner and can only be
issued at the CLI by someone with database credentials.

### 6. The web tier cannot read a key hash — a column privilege, not a policy

`app_web` has `SELECT` on every column of `api_keys` **except `key_hash`**. It writes a hash
at creation and can never read one back. A SQL-injection bug or a careless join in the tier
that serves sessions therefore cannot exfiltrate the material that would let someone forge a
key. Verification happens on the worker role, which can read hashes and may write nothing but
`last_used_at`.

This is the control worth keeping if any other is dropped: it is enforced by Postgres, it
needs no application code to be correct, and there is a test that runs the query and expects
`permission denied`.

### 7. CORS is `*` with no credentials, on the public surface only

`GET`, `HEAD`, `OPTIONS`; `Access-Control-Allow-Origin: *`; **no credentials**. That
combination is what makes a wildcard safe — a page on another site can read public catalog
data and cannot make the browser attach anyone's session cookie while doing it.

Session routes get no CORS headers at all, so a cross-origin page cannot call them even with
`credentials: 'include'`. Which paths count as public is decided segment by segment, not by
prefix: a prefix check would make `/v1/collections/{id}/export` look like `/v1/collections`.

`'*'` rather than reflecting the request's `Origin`, because reflection makes the response
vary by caller and a shared cache has to be told so.

### 8. The published index is CC BY 4.0 (open item O5)

The price index is ours to license and the whole point is that other people use it. CC BY 4.0
asks for attribution and nothing else: it can be built on commercially, which is what makes a
benchmark spread, and the attribution requirement is what makes it a benchmark rather than
anonymous numbers.

This covers **our index**, not the catalog text and card names, which are the publisher's IP
(§23) and are not ours to relicense.

## Consequences

- The OpenAPI generator is ours to maintain. It is small, tested, and used by exactly one
  document.
- Quotas are in memory, like the IP limiter beside them. That is honest for one instance and
  wrong for two, so the trigger is written into the code: it moves to Valkey the day a second
  API container exists, because two processes each granting the full quota is not a quota.
- Keys are verified on the worker pool, so the public API now needs that pool wired in.
  `AppDeps.keysDb` names it, and the API-key plugin is not registered without it — meaning a
  misconfigured deployment serves anonymous traffic rather than silently accepting unverified
  keys.
- `/v1/cards/{id}/prices` returns an empty array when the index has nothing to say. Clients
  must not render that as a price of zero, and the documentation says so twice.
