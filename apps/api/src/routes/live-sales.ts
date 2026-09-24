import { authorize } from '@gth/auth';
import {
  BuyerHandleError,
  type Database,
  LiveSaleLimitError,
  LiveSaleStateError,
  deleteLiveSale,
  listLiveSales,
  logLiveSale,
  writeAuditLog,
} from '@gth/db';
import type { KeyRing } from '@gth/security';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

/**
 * The live-sale logger (FR-4.1).
 *
 * Three routes, all the seller's own. There is no public read: what reaches the public is the
 * derived price observation, which carries no handle, no seller and nothing the seller did
 * not type. That is not a filter in a serialiser — the row policy admits only the owner.
 */
const logSchema = z
  .object({
    cardVariantId: z.uuid().optional(),
    label: z.string().trim().min(1).max(120).optional(),
    condition: z.enum(['nm', 'lp', 'mp', 'hp', 'dmg']).optional(),
    priceCents: z.int().min(0).max(100_000_000),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/u)
      .optional(),
    soldAt: z.iso.datetime().optional(),
    streamRef: z.url().startsWith('https://').max(500).optional(),
    /** Optional by design: a seller who does not need it should not be storing a name. */
    buyerHandle: z.string().max(80).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.cardVariantId) || Boolean(v.label), {
    message: 'provide a cardVariantId or a label',
  });

const idParamSchema = z.object({ id: z.uuid() }).strict();

function issuesOf(error: z.ZodError): { field: string; code: string }[] {
  return error.issues.map((i) => ({
    field: i.path.map(String).join('.') || '(root)',
    code: i.code,
  }));
}

export interface LiveSaleDeps {
  db: Database;
  /**
   * Optional, and the logger degrades rather than breaking without it: entries still record,
   * and an entry carrying a buyer handle is refused outright. Storing somebody's name in
   * plaintext because a key was missing is not a fallback, it is the failure.
   */
  keyRing?: KeyRing | undefined;
}

export function registerLiveSaleRoutes(app: FastifyInstance, deps: LiveSaleDeps): void {
  const { db } = deps;
  const keyRing = deps.keyRing ?? null;

  app.get('/v1/live-sales', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'live_sale:read');

    const items = await listLiveSales(db, request.subject.userId, keyRing);
    // `no-store`, emphatically: this payload contains buyer handles, and a cached copy of
    // somebody else's customers is the kind of thing a shared proxy should never hold.
    return reply.header('cache-control', 'no-store').send({ items });
  });

  app.post(
    '/v1/live-sales',
    // Per-seller rate limit (SR-4.4). A live stream sells fast; this sits well above a
    // person and bounds a script. The daily cap in the query layer is the other half.
    //
    // It said "per-seller" and was keyed on the caller's address, which is the default when no
    // `keyGenerator` is given — so two sellers in one venue shared an allowance and one seller
    // on two connections had none. `preHandler`, because the session has to be resolved first.
    {
      config: {
        rateLimit: {
          max: 120,
          timeWindow: '1 minute',
          hook: 'preHandler',
          keyGenerator: (request: FastifyRequest) =>
            request.subject ? `seller:${request.subject.userId}` : `ip:${request.ip}`,
        },
      },
    },
    async (request, reply) => {
      if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
      authorize(request.subject, 'live_sale:write');

      const body = logSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
      }

      let row;
      try {
        row = await logLiveSale(
          db,
          request.subject.userId,
          {
            cardVariantId: body.data.cardVariantId,
            label: body.data.label,
            condition: body.data.condition,
            priceCents: body.data.priceCents,
            currency: body.data.currency,
            soldAt: body.data.soldAt === undefined ? undefined : new Date(body.data.soldAt),
            streamRef: body.data.streamRef,
            buyerHandle: body.data.buyerHandle,
          },
          keyRing,
        );
      } catch (error) {
        if (error instanceof LiveSaleLimitError) {
          return reply.code(409).send({ error: 'daily_limit_reached', reason: error.message });
        }
        if (error instanceof BuyerHandleError || error instanceof LiveSaleStateError) {
          return reply.code(400).send({ error: 'invalid_request', reason: error.message });
        }
        throw error;
      }

      // Audited, and note what the diff does not contain. The point of an audit log is to
      // say what happened, not to become a second copy of the thing being protected.
      await writeAuditLog(db, {
        actorId: request.subject.userId,
        action: 'live_sale.logged',
        targetType: 'live_sale',
        targetId: row.id,
        diff: { priceCents: row.priceCents, hasBuyerHandle: row.hasBuyerHandle },
      });

      return reply.code(201).header('cache-control', 'no-store').send({
        id: row.id,
        priceCents: row.priceCents,
        condition: row.condition,
        currency: row.currency,
        soldAt: row.soldAt,
      });
    },
  );

  app.delete('/v1/live-sales/:id', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'live_sale:write');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });

    const removed = await deleteLiveSale(db, request.subject.userId, params.data.id);
    if (!removed) {
      // Three different situations, one answer: no such entry, somebody else's, or already
      // in the index. Distinguishing them would confirm another seller's ids exist.
      return reply.code(404).send({ error: 'not_found' });
    }

    await writeAuditLog(db, {
      actorId: request.subject.userId,
      action: 'live_sale.deleted',
      targetType: 'live_sale',
      targetId: params.data.id,
    });
    return reply.code(204).header('cache-control', 'no-store').send();
  });
}
