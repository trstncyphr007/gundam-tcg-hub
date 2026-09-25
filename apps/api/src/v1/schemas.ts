import { z } from 'zod';

/**
 * The public API's contract, as zod.
 *
 * These schemas are the single source for three things: what the routes accept, what the
 * OpenAPI document says, and what the contract tests assert responses match. Written once,
 * so the published spec cannot drift from the running code — the usual failure of a
 * hand-maintained spec is that it is a description of last quarter's API.
 *
 * Money is integer cents plus an ISO currency code, everywhere, with no exceptions and no
 * floats. A published price that has been through a float is a price nobody can reconcile.
 */

export const cursorQuery = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('How many items to return. Defaults to 25, capped at 100.'),
    cursor: z.uuid().optional().describe('The `nextCursor` from a previous response.'),
  })
  .strict();

export const idParam = z.object({ id: z.uuid() }).strict();

export const cardQuery = cursorQuery
  .extend({
    q: z.string().trim().min(1).max(100).optional().describe('Match on card name or number.'),
    setId: z.uuid().optional().describe('Restrict to one set.'),
  })
  .strict();

export const gameQuery = cursorQuery
  .extend({
    game: z
      .string()
      .regex(/^[a-z0-9-]{1,40}$/u, 'slug must be lowercase letters, digits or dashes')
      .optional()
      .describe('Game slug, for example `gundam`.'),
  })
  .strict();

export const priceQuery = z
  .object({
    condition: z
      .enum(['nm', 'lp', 'mp', 'hp', 'dmg'])
      .optional()
      .describe('Restrict to one condition. All conditions are returned by default.'),
    days: z.coerce
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('How far back to read. Defaults to 30 days.'),
  })
  .strict();

// --------------------------------------------------------------------------- //
// Responses
// --------------------------------------------------------------------------- //

/** Paged responses all look the same, so a client writes the loop once. */
function page<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z
      .string()
      .nullable()
      .describe('Pass as `cursor` for the next page. `null` on the last page.'),
  });
}

export const gameSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
});

export const setSchema = z.object({
  id: z.uuid(),
  gameId: z.uuid(),
  code: z.string(),
  name: z.string(),
  releaseDate: z.string().nullable(),
});

export const cardSchema = z.object({
  id: z.uuid(),
  setId: z.uuid(),
  number: z.string(),
  name: z.string(),
  cardType: z.string().nullable(),
  color: z.string().nullable(),
  rarity: z.string().nullable(),
  text: z.string().nullable(),
});

export const variantSchema = z.object({
  id: z.uuid(),
  finish: z.enum(['normal', 'parallel', 'alt_art', 'promo']),
  language: z.enum(['en', 'ja']),
  /** A link to the publisher's image. We do not rehost card art (plan §23). */
  imageRef: z.string().nullable(),
});

export const cardDetailSchema = cardSchema.extend({
  variants: z.array(variantSchema),
});

/**
 * One listing on a public browse page (FR-5.2, FR-5.7).
 *
 * The registrar parses every response through its schema before sending it, so what is *not*
 * declared here cannot escape however the query changes. Two absences are deliberate:
 *
 * - **No seller id.** This route is public — CORS `*`, no session — and a user id here would
 *   hand a scraper a list of everyone selling anything. A buyer choosing between two listings
 *   needs the price, the condition and whether the seller can be trusted, none of which
 *   requires knowing which seller it is.
 * - **No notes.** Free text a seller typed, on a route that answers to anyone and is cached at
 *   the edge. It can come back when there is a reason for it and somebody moderating it.
 */
export const listingForSaleSchema = z.object({
  id: z.uuid(),
  cardVariantId: z.uuid(),
  finish: z.enum(['normal', 'parallel', 'alt_art', 'promo']),
  language: z.enum(['en', 'ja']),
  condition: z.enum(['nm', 'lp', 'mp', 'hp', 'dmg']),
  priceCents: z.int(),
  currency: z.string(),
  quantity: z.int(),
  seller: z.object({
    /**
     * The name this seller chose, or null.
     *
     * Still no id: a user id on a route with CORS `*` and no session is a directory of
     * everyone selling anything. A name somebody typed for display is a different thing from
     * an identifier that joins to the rest of their account, and only the first is published.
     */
    name: z.string().nullable(),
    /** Null, never zero, when nobody has rated them. Zero is a score, and it is not one. */
    average: z.number().nullable(),
    count: z.int(),
  }),
  /**
   * A short-lived signed link to the seller's own photograph of the card, or null.
   *
   * Null covers three different situations on purpose — no photograph, one still being
   * checked, one refused — because the difference is the seller's business and not a buyer's.
   * Null is also what a deployment with no object storage always answers.
   *
   * The link expires. Anything caching this response must not outlive it, which is what the
   * short `Cache-Control` on this route is for.
   */
  photoUrl: z.string().nullable(),
});

export const listingsForSaleSchema = z.object({ items: z.array(listingForSaleSchema) });

export const productSchema = z.object({
  id: z.uuid(),
  gameId: z.uuid(),
  setId: z.uuid().nullable(),
  kind: z.enum(['booster_box', 'booster_pack', 'starter_deck', 'case', 'bundle', 'accessory']),
  name: z.string(),
  slug: z.string(),
  upc: z.string().nullable(),
  msrpCents: z.int().nullable(),
});

export const pricePointSchema = z.object({
  cardVariantId: z.uuid(),
  finish: z.string(),
  language: z.string(),
  condition: z.enum(['nm', 'lp', 'mp', 'hp', 'dmg']),
  day: z.string().describe('The UTC day the index was computed for, as YYYY-MM-DD.'),
  medianCents: z.int().describe('Trimmed median, integer cents (see /methodology).'),
  p25Cents: z.int(),
  p75Cents: z.int(),
  lowCents: z.int().describe('Lowest observation, untrimmed.'),
  highCents: z.int().describe('Highest observation, untrimmed.'),
  observationCount: z
    .int()
    .describe('Real observations behind this point, never the weighted expansion of them.'),
  currency: z.string(),
});

export const sourceMixSchema = z.object({
  source: z.enum(['break_pull', 'live_sale', 'user_report', 'ebay_api', 'walmart_api']),
  observations: z.int().describe('Real observations, never the weighted expansion of them.'),
});

export const cardPricesSchema = z.object({
  cardId: z.uuid(),
  /**
   * Empty when the index has nothing to say. It is not a zero price and must not be shown
   * as one: fewer than three observations publishes nothing at all (ADR-018).
   */
  points: z.array(pricePointSchema),
  /**
   * What the numbers above were computed from, over the same window. A median is only worth
   * believing if you can see what went into it.
   */
  sources: z.array(sourceMixSchema),
});

// --------------------------------------------------------------------------- //
// Breaker profiles (FR-4.3)
// --------------------------------------------------------------------------- //

export const handleParam = z
  .object({
    handle: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/u, 'handle must be lowercase and url-safe'),
  })
  .strict();

export const publishedOddsSchema = z.object({
  numerator: z.int().describe('Cards of this rarity per `denominator` packs, as published.'),
  denominator: z.int(),
});

export const rarityComparisonSchema = z.object({
  rarity: z.string(),
  hits: z.int().describe('Cards of this rarity logged across the counted packs.'),
  packs: z.int(),
  observedRate: z.number().nullable(),
  published: publishedOddsSchema.nullable(),
  publishedRate: z.number().nullable(),
  lowRate: z.number().nullable().describe('Wilson lower bound; null when no comparison was made.'),
  highRate: z.number().nullable(),
  verdict: z
    .enum(['unpublished', 'insufficient', 'not_comparable', 'consistent', 'above', 'below'])
    .describe(
      'A statement about this sample, not about the breaker. `consistent` is the ordinary ' +
        'result; `insufficient` means the sample is too small to say anything, which is the ' +
        'common case and not a criticism. The interval is adjusted for the number of ' +
        'rarities compared at once.',
    ),
});

export const oddsReportSchema = z.object({
  sealedProductId: z.uuid(),
  productName: z.string(),
  breaks: z.int(),
  packs: z.int().describe('Packs opened across ended breaks of this product that recorded one.'),
  unidentifiedPulls: z.int().describe('Pulls with no catalogued card, so no rarity to count.'),
  rarities: z.array(rarityComparisonSchema),
  sources: z.array(
    z.object({
      rarity: z.string(),
      sourceUrl: z.string().describe('Where the publisher stated these odds.'),
      publishedAt: z.string().nullable(),
    }),
  ),
});

export const breakerProfileSchema = z.object({
  handle: z.string(),
  displayName: z.string().describe('Chosen by the creator. Never an account name or email.'),
  bio: z.string().nullable(),
  totals: z.object({
    breaks: z.int(),
    endedBreaks: z.int(),
    pulls: z.int(),
    totalValueCents: z.int(),
    packsOpened: z.int(),
    breaksWithoutPackCount: z
      .int()
      .describe('Ended breaks with no pack count, and so outside every odds comparison.'),
  }),
  fairness: z.object({
    committed: z.int(),
    revealed: z.int(),
    endedBreaks: z.int(),
    chainsChecked: z.int().describe('How many pull logs were re-hashed for this response.'),
    chainsValid: z.int(),
    chainsBroken: z.int(),
    chainsUnverifiable: z.int().describe('Logs predating the hash chain: unproven, not passing.'),
    badge: z.enum(['verified', 'none', 'broken']),
  }),
  rarityCounts: z.array(z.object({ rarity: z.string(), pulls: z.int() })),
  oddsReports: z.array(oddsReportSchema),
  recentBreaks: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      productName: z.string().nullable(),
      status: z.enum(['draft', 'live', 'ended']),
      packsOpened: z.int().nullable(),
      pulls: z.int(),
      totalCents: z.int(),
      endedAt: z.string().nullable(),
    }),
  ),
});

export const breakerSummarySchema = z.object({
  handle: z.string(),
  displayName: z.string(),
  bio: z.string().nullable(),
});

export const breakerPageSchema = page(breakerSummarySchema);

export const gamePageSchema = page(gameSchema);
export const setPageSchema = page(setSchema);
export const cardPageSchema = page(cardSchema);
export const productPageSchema = page(productSchema);

export const errorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  details: z
    .array(z.object({ field: z.string(), code: z.string() }))
    .optional()
    .describe('Field names and rule codes only — never the value that was rejected.'),
});
