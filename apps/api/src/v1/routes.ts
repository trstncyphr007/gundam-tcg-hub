import {
  browseListingsForCard,
  getBreakerProfile,
  getCardById,
  listGames,
  listPublishedProfiles,
  listSealedProducts,
  listSets,
  priceHistoryForCard,
  priceSourceMix,
  searchCards,
} from '@gth/db';
import type { PublicRoute } from './registry.js';
import {
  breakerPageSchema,
  breakerProfileSchema,
  cardDetailSchema,
  cardPageSchema,
  cardPricesSchema,
  cardQuery,
  cursorQuery,
  gamePageSchema,
  gameQuery,
  handleParam,
  idParam,
  listingsForSaleSchema,
  priceQuery,
  productPageSchema,
  setPageSchema,
} from './schemas.js';

/** Catalog data changes rarely and is identical for everyone: cache it at the edge. */
const CATALOG_CACHE = 'public, max-age=300';
/**
 * Prices change once a day when the rollup runs, but a stale price is a wrong price in a
 * way a stale card name is not, so this window is much shorter.
 */
const PRICE_CACHE = 'public, max-age=60';
/**
 * A profile is re-verified on every miss, which is the expensive part, so it is worth
 * caching — but only briefly. A creator who has just unpublished their page, or a chain that
 * has just been found broken, must not keep reading as fine for five minutes.
 */
const PROFILE_CACHE = 'public, max-age=30';
/**
 * A listing is the most perishable thing this API serves: a seller can change a price or
 * withdraw a card at any moment, and a buyer who clicks through to a listing that has gone gets
 * a 409 instead of a checkout. Thirty seconds is short enough that this is rare and long enough
 * that a card page being shared does not become a query per visitor.
 */
const MARKET_CACHE = 'public, max-age=30';

export const publicRoutes: readonly PublicRoute[] = [
  {
    path: '/v1/games',
    operationId: 'listGames',
    summary: 'List games',
    description: 'Every game in the catalog. There is one today.',
    tags: ['catalog'],
    query: cursorQuery,
    response: gamePageSchema,
    cache: CATALOG_CACHE,
    handler: async ({ db }) => ({ items: await listGames(db), nextCursor: null }),
  },
  {
    path: '/v1/sets',
    operationId: 'listSets',
    summary: 'List sets',
    description: 'Sets, oldest id first. Page with `cursor`.',
    tags: ['catalog'],
    query: gameQuery,
    response: setPageSchema,
    cache: CATALOG_CACHE,
    handler: ({ db, query }) =>
      listSets(db, {
        gameSlug: query['game'] as string | undefined,
        limit: query['limit'] as number | undefined,
        cursor: query['cursor'] as string | undefined,
      }),
  },
  {
    path: '/v1/cards',
    operationId: 'searchCards',
    summary: 'Search cards',
    description:
      'Substring match on name or number. Omit `q` to page the whole catalog. ' +
      'Results are ordered by id, which is stable but arbitrary — page with `cursor`, ' +
      'never by offset.',
    tags: ['catalog'],
    query: cardQuery,
    response: cardPageSchema,
    cache: CATALOG_CACHE,
    handler: ({ db, query }) =>
      searchCards(db, {
        q: query['q'] as string | undefined,
        setId: query['setId'] as string | undefined,
        limit: query['limit'] as number | undefined,
        cursor: query['cursor'] as string | undefined,
      }),
  },
  {
    path: '/v1/cards/:id',
    operationId: 'getCard',
    summary: 'Get one card',
    description: 'A card and every printing of it.',
    tags: ['catalog'],
    params: idParam,
    response: cardDetailSchema,
    cache: CATALOG_CACHE,
    handler: ({ db, params }) => getCardById(db, params['id'] as string),
  },
  {
    path: '/v1/cards/:id/listings',
    operationId: 'getCardListings',
    summary: 'What is for sale for a card',
    description:
      'Active listings for every printing of this card, cheapest first. This is the entry ' +
      'point to buying: the id of an item here is what `POST /v1/listings/:id/buy` takes. ' +
      'Drafts and withdrawn listings are not omitted by this route — the read-only database ' +
      'role it runs as cannot see them at all. A card with nothing for sale, and a card that ' +
      'does not exist, both answer with an empty list; `GET /v1/cards/{id}` is where you find ' +
      'out which.',
    tags: ['marketplace'],
    params: idParam,
    response: listingsForSaleSchema,
    cache: MARKET_CACHE,
    handler: async ({ db, params, presignView }) => {
      const items = await browseListingsForCard(db, params['id'] as string);
      return {
        // The key becomes a signed link here, where the credentials are, and never leaves the
        // database package as anything else. No storage configured means no picture rather
        // than no listings: photographs are optional at boot, and a shop window without them
        // is still a shop window.
        items: items.map(({ photoKey, ...listing }) => ({
          ...listing,
          photoUrl:
            photoKey === null || presignView === undefined ? null : presignView(photoKey).url,
        })),
      };
    },
  },
  {
    path: '/v1/cards/:id/prices',
    operationId: 'getCardPrices',
    summary: 'Price history for a card',
    description:
      'The published index for every printing of this card, one point per day. ' +
      '`points` is empty when the index has nothing to say — that means insufficient ' +
      'evidence, not a price of zero. Nothing is published below three observations; ' +
      'see /methodology for how the number is computed.',
    tags: ['prices'],
    params: idParam,
    query: priceQuery,
    response: cardPricesSchema,
    cache: PRICE_CACHE,
    handler: async ({ db, params, query }) => {
      const cardId = params['id'] as string;
      // 404 for a card that does not exist, rather than an empty series, so "no such card"
      // and "no prices yet" stay different answers to a client.
      const card = await getCardById(db, cardId);
      if (!card) return null;

      const window = {
        condition: query['condition'] as 'nm' | 'lp' | 'mp' | 'hp' | 'dmg' | undefined,
        days: query['days'] as number | undefined,
      };
      // The same window for both, or the mix would describe a different set of numbers from
      // the one being charted.
      const [points, sources] = await Promise.all([
        priceHistoryForCard(db, cardId, window),
        priceSourceMix(db, cardId, window),
      ]);
      return { cardId, points, sources };
    },
  },
  {
    path: '/v1/products',
    operationId: 'listProducts',
    summary: 'List sealed products',
    description: 'Booster boxes, decks and the rest.',
    tags: ['catalog'],
    query: gameQuery,
    response: productPageSchema,
    cache: CATALOG_CACHE,
    handler: ({ db, query }) =>
      listSealedProducts(db, {
        gameSlug: query['game'] as string | undefined,
        limit: query['limit'] as number | undefined,
        cursor: query['cursor'] as string | undefined,
      }),
  },
  {
    path: '/v1/breakers',
    operationId: 'listBreakers',
    summary: 'List published breaker profiles',
    description:
      'Creators who have published a profile. A profile is off by default and appears ' +
      'here only once its owner publishes it.',
    tags: ['breakers'],
    query: cursorQuery,
    response: breakerPageSchema,
    cache: PROFILE_CACHE,
    handler: async ({ db, query }) => ({
      items: await listPublishedProfiles(db, query['limit'] as number | undefined),
      nextCursor: null,
    }),
  },
  {
    path: '/v1/breakers/:handle',
    operationId: 'getBreaker',
    summary: 'A breaker profile',
    description:
      'Break counts, pull totals and hit rates by rarity against published pack odds ' +
      'where they exist (FR-4.3). Read `verdict` carefully: `insufficient` is the ' +
      'ordinary answer, because the packs needed to distinguish a real rate from luck ' +
      'run to the hundreds. Comparisons are made per product, never pooled across ' +
      'products whose odds differ, and the confidence interval is widened for the ' +
      'number of rarities compared at once.',
    tags: ['breakers'],
    params: handleParam,
    response: breakerProfileSchema,
    cache: PROFILE_CACHE,
    handler: ({ db, params }) => getBreakerProfile(db, params['handle'] as string),
  },
];
