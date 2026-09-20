import { type RestockMessage, dispatchRestockEvent } from '@gth/alerts';
import { type Database, recordStockReport, resolveListing, writeAuditLog } from '@gth/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiKeyError, authenticateApiKey } from '../plugins/api-key.js';

const observationSchema = {
  inStock: z.boolean(),
  priceCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  rawHash: z.string().max(128).nullable().optional(),
};

/** A report about a listing we already know. */
const byIdSchema = z.object({ retailerProductId: z.uuid(), ...observationSchema }).strict();

/**
 * A report in the scanner's own terms: "this product, at this shop, at this URL".
 * The scanner searches by name and does not know our listing ids (ADR-013), so the
 * platform resolves the listing — and refuses if the shop is not an approved one.
 */
const byUrlSchema = z
  .object({
    productSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/),
    retailerDomain: z.string().regex(/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/),
    url: z.url().startsWith('https://').max(2048),
    ...observationSchema,
  })
  .strict();

const reportSchema = z.union([byIdSchema, byUrlSchema]);

const ingestSchema = z.object({ reports: z.array(reportSchema).min(1).max(100) }).strict();

export interface IngestDeps {
  /** app_worker pool: may append stock data, but cannot edit the catalog (least privilege). */
  workerDb: Database;
  tokenPepper: string;
  transports: Parameters<typeof dispatchRestockEvent>[0]['transports'];
  buildMessage: (
    db: Database,
    retailerProductId: string,
    priceCents: number | null,
    currency: string,
  ) => Promise<RestockMessage | null>;
}

/**
 * Ingestion needs a key and the `ingest:write` scope — a scope no self-serve key can hold
 * (migration 0017, and a CHECK constraint besides). Verification itself is the shared
 * implementation, so there is one place where a presented key is checked.
 */
async function authenticate(
  request: FastifyRequest,
  deps: IngestDeps,
): Promise<{ ok: true; keyId: string } | { ok: false; status: 401 | 403 }> {
  try {
    const key = await authenticateApiKey(request, {
      keysDb: deps.workerDb,
      tokenPepper: deps.tokenPepper,
    });
    if (!key) return { ok: false, status: 401 };
    if (!key.scopes.includes('ingest:write')) return { ok: false, status: 403 };
    return { ok: true, keyId: key.id };
  } catch (error) {
    if (error instanceof ApiKeyError) return { ok: false, status: error.status };
    throw error;
  }
}

/** Scanner → platform ingestion (ADR-013 data contract). */
export function registerIngestRoutes(app: FastifyInstance, deps: IngestDeps): void {
  app.post(
    '/v1/ingest/stock',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = await authenticate(request, deps);
      if (!auth.ok) {
        return reply
          .code(auth.status)
          .send({ error: auth.status === 401 ? 'unauthenticated' : 'forbidden' });
      }

      const parsed = ingestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid_request',
          details: parsed.error.issues.map((i) => ({
            field: i.path.map(String).join('.') || '(root)',
            code: i.code,
          })),
        });
      }

      const results: {
        retailerProductId: string;
        restock: boolean;
        deliveries: number;
        listingCreated?: boolean;
      }[] = [];

      for (const report of parsed.data.reports) {
        let retailerProductId: string;
        let listingCreated = false;

        if ('retailerProductId' in report) {
          retailerProductId = report.retailerProductId;
        } else {
          const resolved = await resolveListing(deps.workerDb, {
            productSlug: report.productSlug,
            retailerDomain: report.retailerDomain,
            url: report.url,
          });
          if (!resolved.ok) {
            // Say why, but only in our own vocabulary: these are operator-facing reasons,
            // and an unapproved retailer must never be silently accepted.
            return reply.code(422).send({ error: 'unprocessable_report', reason: resolved.reason });
          }
          retailerProductId = resolved.retailerProductId;
          listingCreated = resolved.created;
        }

        let outcome;
        try {
          outcome = await recordStockReport(deps.workerDb, {
            retailerProductId,
            inStock: report.inStock,
            priceCents: report.priceCents,
            currency: report.currency,
            rawHash: report.rawHash,
          });
        } catch (error) {
          // Unknown listing ids are a client mistake, not a server fault.
          request.log.warn({ err: error }, 'stock report rejected');
          return reply.code(422).send({ error: 'unprocessable_report' });
        }

        let deliveries = 0;
        if (outcome.event) {
          const message = await deps.buildMessage(
            deps.workerDb,
            retailerProductId,
            report.priceCents ?? null,
            report.currency ?? 'USD',
          );
          if (message) {
            const dispatched = await dispatchRestockEvent(
              { db: deps.workerDb, transports: deps.transports, logger: request.log },
              { id: outcome.event.id, retailerProductId },
              message,
            );
            deliveries = dispatched.claimed;
          }
          await writeAuditLog(deps.workerDb, {
            action: 'stock.restock_detected',
            targetType: 'retailer_product',
            targetId: retailerProductId,
          });
        }

        results.push({
          retailerProductId,
          restock: outcome.event !== null,
          deliveries,
          ...(listingCreated ? { listingCreated: true } : {}),
        });
      }

      return reply.code(202).header('cache-control', 'no-store').send({ results });
    },
  );
}
