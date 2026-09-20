import { type RestockMessage, dispatchRestockEvent } from '@gth/alerts';
import {
  type Database,
  findActiveApiKey,
  recordStockReport,
  touchApiKey,
  writeAuditLog,
} from '@gth/db';
import { hashToken, safeEqual } from '@gth/security';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

/** `gth_live_<prefix>_<secret>` — the prefix is a public handle, the secret never stored. */
const API_KEY_PATTERN = /^gth_(?:live|test)_([a-z0-9]{8})_([A-Za-z0-9_-]{32,})$/;

const reportSchema = z
  .object({
    retailerProductId: z.uuid(),
    inStock: z.boolean(),
    priceCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    rawHash: z.string().max(128).nullable().optional(),
  })
  .strict();

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

async function authenticate(
  request: FastifyRequest,
  deps: IngestDeps,
): Promise<{ ok: true; keyId: string } | { ok: false; status: 401 | 403 }> {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer '))
    return { ok: false, status: 401 };

  const match = API_KEY_PATTERN.exec(header.slice('Bearer '.length).trim());
  if (!match) return { ok: false, status: 401 };
  const [, prefix, secret] = match;

  const key = await findActiveApiKey(deps.workerDb, String(prefix));
  if (!key) return { ok: false, status: 401 };
  // Constant-time compare of keyed hashes; a wrong secret leaks no timing signal.
  if (!safeEqual(hashToken(String(secret), deps.tokenPepper), key.keyHash)) {
    return { ok: false, status: 401 };
  }
  if (!key.scopes.includes('ingest:write')) return { ok: false, status: 403 };

  await touchApiKey(deps.workerDb, key.id);
  return { ok: true, keyId: key.id };
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

      const results: { retailerProductId: string; restock: boolean; deliveries: number }[] = [];

      for (const report of parsed.data.reports) {
        let outcome;
        try {
          outcome = await recordStockReport(deps.workerDb, report);
        } catch (error) {
          // Unknown listing ids are a client mistake, not a server fault.
          request.log.warn({ err: error }, 'stock report rejected');
          return reply.code(422).send({ error: 'unprocessable_report' });
        }

        let deliveries = 0;
        if (outcome.event) {
          const message = await deps.buildMessage(
            deps.workerDb,
            report.retailerProductId,
            report.priceCents ?? null,
            report.currency ?? 'USD',
          );
          if (message) {
            const dispatched = await dispatchRestockEvent(
              { db: deps.workerDb, transports: deps.transports, logger: request.log },
              { id: outcome.event.id, retailerProductId: report.retailerProductId },
              message,
            );
            deliveries = dispatched.claimed;
          }
          await writeAuditLog(deps.workerDb, {
            action: 'stock.restock_detected',
            targetType: 'retailer_product',
            targetId: report.retailerProductId,
          });
        }

        results.push({
          retailerProductId: report.retailerProductId,
          restock: outcome.event !== null,
          deliveries,
        });
      }

      return reply.code(202).header('cache-control', 'no-store').send({ results });
    },
  );
}
