/**
 * What a free API key is allowed (FR-3.7), in one place.
 *
 * These numbers are both **enforced** by the quota plugin and **published** on `/terms` as a
 * statement to anybody building against the API. They were two independent literals — one in
 * `apps/api/src/plugins/quota.ts`, one in `apps/web/lib/site.ts` — with a comment on the second
 * claiming it matched the first, and nothing comparing them.
 *
 * Halving the enforced tier to check: three API tests failed, because they embed the numbers
 * themselves. Every web test passed. So the change is noticed, and what you are led to do about
 * it is update the literals in those three tests — away from the page that also needed
 * updating. `/terms` would have gone on promising a thousand requests a day while the server
 * refused at five hundred, and the first person to find out is a developer whose client starts
 * getting 429s at a limit we told them they had.
 *
 * Imported by both sides now, so they cannot disagree rather than being checked for agreeing.
 */
export interface ApiTier {
  perMinute: number;
  perDay: number;
}

export const FREE_TIER_LIMITS: ApiTier = { perMinute: 60, perDay: 1000 };
