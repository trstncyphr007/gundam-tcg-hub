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

export const cardPricesSchema = z.object({
  cardId: z.uuid(),
  /**
   * Empty when the index has nothing to say. It is not a zero price and must not be shown
   * as one: fewer than three observations publishes nothing at all (ADR-018).
   */
  points: z.array(pricePointSchema),
});

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
