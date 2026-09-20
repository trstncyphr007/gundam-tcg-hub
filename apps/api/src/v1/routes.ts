import {
  getCardById,
  listGames,
  listSealedProducts,
  listSets,
  priceHistoryForCard,
  priceSourceMix,
  searchCards,
} from '@gth/db';
import type { PublicRoute } from './registry.js';
import {
  cardDetailSchema,
  cardPageSchema,
  cardPricesSchema,
  cardQuery,
  cursorQuery,
  gamePageSchema,
  gameQuery,
  idParam,
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
];
