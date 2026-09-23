# Architecture Decision Records

ADR-001 to ADR-011 are recorded in the build plan (§2.2, table form) and are not duplicated here.
New decisions get their own file.

| ADR | Decision                                                                                                        | Status                      |
| --- | --------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 001 | pnpm workspaces + Turborepo monorepo                                                                            | Accepted, amended by 013    |
| 002 | Code in the WSL2 filesystem, not OneDrive                                                                       | Accepted                    |
| 003 | Postgres + Drizzle                                                                                              | Accepted                    |
| 004 | Valkey 8 + BullMQ                                                                                               | **Superseded by 042**       |
| 005 | Better Auth (Discord OAuth, passkeys, TOTP)                                                                     | Accepted                    |
| 006 | Fastify API separate from Next.js                                                                               | Accepted                    |
| 007 | SOPS + age for secrets                                                                                          | Accepted                    |
| 008 | Caddy reverse proxy                                                                                             | Accepted                    |
| 009 | Tailscale-only admin access                                                                                     | Accepted                    |
| 010 | cosign keyless signing + SBOM + provenance                                                                      | Accepted                    |
| 011 | Stripe Connect Express for payments                                                                             | Accepted                    |
| 012 | [Solo merge model](012-solo-merge-model.md)                                                                     | Accepted                    |
| 013 | [Scanner stays Python in its own repo](013-scanner-stays-python.md)                                             | Accepted                    |
| 014 | [GitHub Free/private compensating controls](014-github-free-controls.md)                                        | Accepted, amended by 032    |
| 015 | [TypeScript 6.x until typescript-eslint supports 7](015-typescript-6.md)                                        | Accepted                    |
| 016 | [The scanner reports product + shop + URL; the platform resolves the listing](016-listing-resolution-by-url.md) | Accepted                    |
| 017 | [Overlay tokens as a database credential, and SSE without compression](017-overlay-tokens-and-streaming.md)     | Accepted                    |
| 018 | [How the price index is computed](018-price-index-methodology.md)                                               | Accepted                    |
| 019 | [What a collection is worth, and where its CSV is parsed](019-collection-valuation.md)                          | Accepted                    |
| 020 | [Generate OpenAPI from zod; publish the index under CC BY 4.0](020-openapi-without-swagger.md)                  | Accepted                    |
| 021 | [Comparing pull rates to published odds](021-comparing-pull-rates-to-published-odds.md)                         | Accepted                    |
| 022 | [Live sales, and what happens to a buyer's name](022-live-sales-and-buyer-handles.md)                           | Accepted                    |
| 023 | [VOD timestamps live outside the hash chain](023-vod-timestamps-outside-the-chain.md)                           | Accepted                    |
| 024 | [The admin moderation console, and step-up by freshness](024-admin-moderation-console.md)                       | Accepted, gap closed by 025 |
| 025 | [Passkeys, and what an admin session has to prove](025-passkeys.md)                                             | Accepted                    |
| 026 | [Seeing and ending your sessions, and hearing about new devices](026-sessions-and-new-device-notices.md)        | Accepted                    |
| 027 | [Downloading your data, and deleting your account](027-export-and-deletion.md)                                  | Accepted                    |
| 028 | [IP addresses at rest are same-day hashes](028-ip-addresses-as-daily-hashes.md)                                 | Accepted                    |
| 029 | [Retiring an encryption key, not just adding one](029-retiring-encryption-keys.md)                              | Accepted                    |
| 030 | [The platform makes one outbound request, and CI keeps it that way](030-one-outbound-request.md)                | Accepted                    |
| 031 | [No inline styles, so the CSP can refuse them](031-no-inline-styles.md)                                         | Accepted                    |
| 032 | [Provenance for every image, verified where it is used](032-provenance-for-every-image.md)                      | Accepted                    |
| 033 | [The operations dashboard judges the scanner by its reports](033-operations-dashboard.md)                       | Accepted                    |
| 034 | [The policy pages state only what the code enforces](034-policy-pages-state-facts.md)                           | Accepted                    |
| 035 | [The retention period is a database rule, not a job parameter](035-retention-the-database-decides.md)           | Accepted                    |
| 036 | [The nightly jobs ship in the image, and their failures are audible](036-the-nightly-jobs-can-actually-run.md)  | Accepted                    |
| 037 | [The attempts that failed are written down, without naming anyone](037-writing-down-what-failed.md)             | Accepted                    |
| 038 | [A watchdog that also says "all clear"](038-a-watchdog-that-says-all-clear.md)                                  | Accepted                    |
| 039 | [The kill switches the runbook already promised](039-kill-switches-that-exist.md)                               | Accepted                    |
| 040 | [Measure the speed promises, and leave the index alone](040-measure-before-optimising.md)                       | Accepted                    |
| 041 | [The overlay keeps polling, and here is what that costs](041-the-overlay-polls.md)                              | Accepted                    |
| 042 | [The quota outlives the process, and Valkey leaves the stack](042-the-quota-outlives-the-process.md)            | Accepted                    |
