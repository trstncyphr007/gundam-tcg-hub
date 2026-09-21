# Architecture Decision Records

ADR-001 to ADR-011 are recorded in the build plan (§2.2, table form) and are not duplicated here.
New decisions get their own file.

| ADR | Decision                                                                                                        | Status                   |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 001 | pnpm workspaces + Turborepo monorepo                                                                            | Accepted, amended by 013 |
| 002 | Code in the WSL2 filesystem, not OneDrive                                                                       | Accepted                 |
| 003 | Postgres + Drizzle                                                                                              | Accepted                 |
| 004 | Valkey 8 + BullMQ                                                                                               | Accepted                 |
| 005 | Better Auth (Discord OAuth, passkeys, TOTP)                                                                     | Accepted                 |
| 006 | Fastify API separate from Next.js                                                                               | Accepted                 |
| 007 | SOPS + age for secrets                                                                                          | Accepted                 |
| 008 | Caddy reverse proxy                                                                                             | Accepted                 |
| 009 | Tailscale-only admin access                                                                                     | Accepted                 |
| 010 | cosign keyless signing + SBOM + provenance                                                                      | Accepted                 |
| 011 | Stripe Connect Express for payments                                                                             | Accepted                 |
| 012 | [Solo merge model](012-solo-merge-model.md)                                                                     | Accepted                 |
| 013 | [Scanner stays Python in its own repo](013-scanner-stays-python.md)                                             | Accepted                 |
| 014 | [GitHub Free/private compensating controls](014-github-free-controls.md)                                        | Accepted                 |
| 015 | [TypeScript 6.x until typescript-eslint supports 7](015-typescript-6.md)                                        | Accepted                 |
| 016 | [The scanner reports product + shop + URL; the platform resolves the listing](016-listing-resolution-by-url.md) | Accepted                 |
| 017 | [Overlay tokens as a database credential, and SSE without compression](017-overlay-tokens-and-streaming.md)     | Accepted                 |
| 018 | [How the price index is computed](018-price-index-methodology.md)                                               | Accepted                 |
| 019 | [What a collection is worth, and where its CSV is parsed](019-collection-valuation.md)                          | Accepted                 |
| 020 | [Generate OpenAPI from zod; publish the index under CC BY 4.0](020-openapi-without-swagger.md)                  | Accepted                 |
| 021 | [Comparing pull rates to published odds](021-comparing-pull-rates-to-published-odds.md)                         | Accepted                 |
