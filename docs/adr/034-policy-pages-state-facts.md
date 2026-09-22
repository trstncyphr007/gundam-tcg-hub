# ADR-034: The policy pages state only what the code enforces

- **Status:** Accepted
- **Date:** 2026-09-23
- **Plan reference:** §23, SR-X.24 to SR-X.26, SR-5.10

## Context

M4 asks for a privacy policy and terms of service before public launch, and §15.4 for a
`/.well-known/security.txt`. These are the last pre-launch items that don't need a server.

The easy version is boilerplate: a generated policy listing cookie categories, analytics
vendors and "legitimate interests" that this service has never had. That document would be
wrong in both directions — claiming processing that doesn't happen, and omitting the things
that do, such as the buyer handle in the live-sale logger.

## Decision

### Every claim is one that something in the repository enforces

The pages were written from the code, not from a template. Each retention period on `/privacy`
comes from a control that already exists:

| Claim on the page                                        | Where it is enforced                                            |
| -------------------------------------------------------- | --------------------------------------------------------------- |
| Sign-in links expire in 15 minutes, single use           | Better Auth magic-link config (SR-X.2)                          |
| Sessions last 30 days                                    | Session config (SR-1.7)                                         |
| Buyer handles are erased after 90 days                   | The retention job (SR-4.5)                                      |
| IP addresses are stored only as a daily-rotating hash    | `packages/auth/src/ip-hash.ts` (ADR-028)                        |
| No analytics, no ad networks, no third-party scripts     | The CSP has no third-party origins (ADR-031)                    |
| You can export or delete everything                      | `/account/data` (ADR-027)                                       |
| The index is CC BY 4.0; 60 requests a minute, 1000 a day | `lib/site.ts`, quoted by both the page and the OpenAPI document |

The numbers live in `apps/web/lib/site.ts` and are interpolated, so the page cannot quietly
disagree with the limit the server applies. `e2e/legal.spec.ts` asserts each of them in the
served HTML: changing a retention period without correcting the page fails the suite.

Where a control doesn't exist yet the page says so plainly — the audit log "is not yet pruned
automatically" — rather than promising a schedule nobody runs.

### `security.txt` is served only once there is a mailbox behind it

`CONTACT_EMAIL` is `null` until a domain and a role address exist. While it is null the route
returns 404, and both policy pages render "a contact address will be published here" instead.

A published `security.txt` naming an unread address is worse than none: a finder who mails it
believes they have disclosed responsibly, and the clock they think is running isn't. RFC 9116
also requires `Expires`, which is generated per request from a 180-day window, so the file
can't rot into an expired one on a server nobody redeploys.

Setting `CONTACT_EMAIL` is a checklist item in `docs/runbooks/vps-setup.md` §8, with the
`curl` that proves it.

### Not legal advice

The pages are accurate, not lawyered. §23 already requires a lawyer's review before Phase 5,
when money and a marketplace change what the terms have to cover. Being accurate first makes
that review cheap: the reviewer is checking claims against behaviour, not rewriting fiction.

## Consequences

- M4's "privacy policy and ToS" is done, and SR-5.10's `security.txt` contact is ready to
  switch on. Age gate (13+) is stated in the terms; the 18+ selling requirement is Stripe's
  and arrives with Phase 5.
- The footer now carries Methodology, Privacy, Terms and API docs on every page, along with
  the "not affiliated with Bandai" disclaimer §23 asks for.
- The pages inherit the site-wide `noindex` until launch. Removing it is part of going public,
  not part of this change.
- **A new retention period is now a two-file change.** That is the point, and the e2e suite
  enforces it.
