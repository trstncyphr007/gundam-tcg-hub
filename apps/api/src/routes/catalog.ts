import {
  type Database,
  getCardById,
  listGames,
  listSealedProducts,
  listSets,
  searchCards,
} from '@gth/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

/** Every query parameter is validated before it reaches the database (SR-X.10). */
const listQuerySchema = z
  .object({
    game: z
      .string()
      .regex(/^[a-z0-9-]{1,40}$/, 'slug must be lowercase letters, digits or dashes')
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.uuid().optional(),
  })
  .strict();

const cardQuerySchema = listQuerySchema
  .omit({ game: true })
  .extend({
    q: z.string().trim().min(1).max(100).optional(),
    setId: z.uuid().optional(),
  })
  .strict();

const idParamSchema = z.object({ id: z.uuid() }).strict();

/** Catalog data is public and changes rarely: cache it, but never cache per-user data. */
const PUBLIC_CACHE = 'public, max-age=300';

function parseOr400<T extends z.ZodType>(
  schema: T,
  value: unknown,
  reply: FastifyReply,
): z.infer<T> | undefined {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  void reply.code(400).send({
    error: 'invalid_request',
    // Field names and rules only - never echo the offending value back.
    details: result.error.issues.map((i) => ({
      field: i.path.map(String).join('.') || '(root)',
      code: i.code,
    })),
  });
  return undefined;
}

export function registerCatalogRoutes(app: FastifyInstance, db: Database): void {
  app.get('/v1/games', async (_request, reply) => {
    const games = await listGames(db);
    return reply.header('cache-control', PUBLIC_CACHE).send({ items: games });
  });

  app.get('/v1/sets', async (request: FastifyRequest, reply) => {
    const query = parseOr400(listQuerySchema, request.query, reply);
    if (!query) return reply;
    const page = await listSets(db, {
      gameSlug: query.game,
      limit: query.limit,
      cursor: query.cursor,
    });
    return reply.header('cache-control', PUBLIC_CACHE).send(page);
  });

  app.get('/v1/cards', async (request: FastifyRequest, reply) => {
    const query = parseOr400(cardQuerySchema, request.query, reply);
    if (!query) return reply;
    const page = await searchCards(db, {
      q: query.q,
      setId: query.setId,
      limit: query.limit,
      cursor: query.cursor,
    });
    return reply.header('cache-control', PUBLIC_CACHE).send(page);
  });

  app.get('/v1/cards/:id', async (request: FastifyRequest, reply) => {
    const params = parseOr400(idParamSchema, request.params, reply);
    if (!params) return reply;
    const card = await getCardById(db, params.id);
    if (!card) return reply.code(404).send({ error: 'not_found' });
    return reply.header('cache-control', PUBLIC_CACHE).send(card);
  });

  app.get('/v1/products', async (request: FastifyRequest, reply) => {
    const query = parseOr400(listQuerySchema, request.query, reply);
    if (!query) return reply;
    const page = await listSealedProducts(db, {
      gameSlug: query.game,
      limit: query.limit,
      cursor: query.cursor,
    });
    return reply.header('cache-control', PUBLIC_CACHE).send(page);
  });
}
