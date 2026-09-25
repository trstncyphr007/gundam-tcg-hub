# ADR-043: The bucket has to say yes too

- **Status:** Accepted
- **Date:** 2026-09-26
- **Context:** SR-5.5 (photo uploads), FR-5.2

## Context

Listing photographs do not pass through the API. The browser asks for a presigned URL and then
**PUTs the file straight to object storage**, because ten megabytes per photo through our own
process would be a buffer to size and a denial-of-service surface to defend, and it would buy
nothing — the bytes are not trusted on arrival either way (ADR-030).

That design has a consequence nobody wrote down: the request is **cross-origin**, from the site
to the bucket, and it carries a `Content-Type`. So before sending it the browser sends a
preflight `OPTIONS` and obeys the answer.

A bucket with no CORS configuration answers that preflight with 404. The browser then refuses to
send the PUT at all, and `fetch` rejects with an opaque network error.

**This shipped.** `ensureBucket` was called only from tests, nothing ever set a CORS policy, and
the upload could not work in any browser on any deployment. Every server-side test passed
throughout, because a server never sends a preflight. The pre-launch security review
(`docs/security/phase-5-review.md`) examined CORS on _our_ routes, confirmed the storage server
enforces the signed content type and length, and did not think to ask whether a browser was
allowed to speak to the bucket at all.

## Decision

**1. The bucket carries a CORS policy, and applying it is part of standing the stack up.**

`storage.putCorsPolicy(origins)` writes it; `pnpm photos:bucket` creates the bucket and applies
it. CI runs that before the end-to-end suite. In production it is an operator's one-off against
R2 — the same call with different credentials.

**2. The allowed origins are the control. The allowed request headers are not.**

```xml
<AllowedOrigin>https://the.site</AllowedOrigin>
<AllowedMethod>PUT</AllowedMethod>
<AllowedMethod>GET</AllowedMethod>
<AllowedHeader>*</AllowedHeader>
```

`AllowedHeader: *` looks careless and is not. The first version of this policy allowed
`content-type` and nothing else, which seemed precise, and it **refused every upload**:

| Preflight from the site asking for | Answer  |
| ---------------------------------- | ------- |
| `content-type`                     | 200     |
| `content-length, content-type`     | **403** |

Chromium names `content-length` in `Access-Control-Request-Headers` even when the page never
sets it. A policy that enumerates header names is therefore a policy whose correctness depends
on which browser the buyer used, and whose failure appears only in a console.

A header name authorises nothing. The signature does, and it is computed over the headers that
are actually sent — a request that names a header it does not send, or sends one it did not
sign, fails signature verification at the storage server. What the origin list buys is different
and real: a page on somebody else's site cannot spend a signed URL it has somehow obtained.

**3. The client sends only the headers it is entitled to set.**

The API returns `requiredHeaders` including `content-length`, because the signature covers it.
The browser sets that itself, from the body, to the same number the API signed. The page now
filters it out rather than declaring it.

**4. A blocked upload says so.**

A cross-origin `fetch` that the browser refuses to send _rejects_; it does not resolve with a
status. That exception escaped the handler and the page simply stopped — no message, no error,
an upload that looked like it was still going. It is caught now.

## Consequences

- **Do not "tighten" `AllowedHeader`.** It reads like a loose wildcard and is the reason uploads
  work. `storage.test.ts` asserts the `content-length, content-type` preflight succeeds, so this
  regression fails a test rather than a customer.
- A new deployment has one more setup step. It is in `pnpm photos:bucket` and the runbook, and
  CI performs it every run, so the step is exercised rather than remembered.
- Extra origins (a second domain, a staging host) go in `PHOTO_CORS_ORIGINS`, comma separated.
- **The general lesson, which outlives this ADR:** a control the _browser_ enforces is invisible
  to every test that is not a browser. The CSP was the first instance — `connect-src` had to name
  the bucket for the same request to be allowed out of the page — and this is the second, on the
  same four lines of code. Both were found by writing an end-to-end test, and neither could have
  been found any other way.

## Alternatives considered

**Proxy the upload through the API.** Removes the cross-origin problem entirely, and reintroduces
every reason ADR-030 avoided it: buffering large bodies, a timeout to tune, and a cheap
denial-of-service surface.

**Enumerate the allowed headers exactly.** Tried first; see the table above. It fails per browser
and per browser version, which is the worst way for a security control to fail.

**`AllowedOrigin: *`.** Would also work and is what many examples show. Refused: it would let any
page on the internet spend a signed URL, and the signature is then the only thing between a
leaked link and the bucket. The origin restriction costs nothing and removes a class of abuse.
