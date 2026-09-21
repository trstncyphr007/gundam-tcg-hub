import { authorize } from '@gth/auth';
import {
  BreakLimitError,
  BreakStateError,
  CommitmentError,
  type Database,
  checkChain,
  commitBreak,
  createBreak,
  getCommitment,
  getOverlayState,
  getPublicBreak,
  listBreaks,
  logPull,
  revealBreak,
  rotateOverlayToken,
  setBreakStatus,
  setClientSeed,
  writeAuditLog,
} from '@gth/db';
import { type KeyRing, generateToken, hashToken, toCsv } from '@gth/security';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

/** 32 bytes of CSPRNG, base64url — the overlay token shown once at creation (SR-2.1). */
const OVERLAY_TOKEN_BYTES = 32;

/** Per-token concurrent overlay connections (SR-2.4). OBS opens one; a few spare is plenty. */
export const MAX_OVERLAY_CONNECTIONS = 5;
const OVERLAY_HEARTBEAT_MS = 15_000;
const OVERLAY_IDLE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const OVERLAY_POLL_MS = 1000;

const createSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    sealedProductId: z.uuid().optional(),
    costCents: z.number().int().min(0).max(100_000_000).optional(),
  })
  .strict();

const pullSchema = z
  .object({
    cardVariantId: z.uuid().optional(),
    label: z.string().trim().min(1).max(120).optional(),
    // No default: omitting it asks the index to fill it (FR-2.1), which is a different
    // request from "this card is worth nothing". A default of 0 here would silently turn
    // the first into the second.
    valueCentsAtPull: z.number().int().min(0).max(100_000_000).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.cardVariantId) || Boolean(v.label), {
    message: 'provide a cardVariantId or a label',
  });

const idParamSchema = z.object({ id: z.uuid() }).strict();
/** base64url of 32 bytes is 43 characters; bound it so a huge path never reaches the DB. */
const tokenParamSchema = z.object({ token: z.string().min(20).max(200) }).strict();

function issuesOf(error: z.ZodError): { field: string; code: string }[] {
  return error.issues.map((i) => ({
    field: i.path.map(String).join('.') || '(root)',
    code: i.code,
  }));
}

/** Overlay responses must never be cached or leak the token through a referrer (SR-2.2). */
function overlayHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .header('x-robots-tag', 'noindex, nofollow');
}

export interface BreakDeps {
  db: Database;
  tokenPepper: string;
  /**
   * Commit–reveal needs two things the rest of this file does not: a key ring to encrypt the
   * server seed, and a pool on the one role permitted to read it back. Both are optional, so
   * a deployment that has not configured field encryption simply has no fairness routes
   * rather than half-working ones that store a seed it cannot protect.
   */
  keyRing?: KeyRing | undefined;
  secretsDb?: Database | undefined;
}

const commitSchema = z.object({ slotCount: z.int().min(2).max(1000) }).strict();
const clientSeedSchema = z.object({ clientSeed: z.string().trim().min(1).max(200) }).strict();

/**
 * Commit–reveal (FR-4.2).
 *
 * All three are creator-only and session-authenticated. The reveal is the one operation that
 * touches the encrypted seed, and it runs on a pool whose role may read that column — the
 * tier serving this request cannot.
 */
function registerFairnessRoutes(
  app: FastifyInstance,
  db: Database,
  keyRing: KeyRing,
  secretsDb: Database,
): void {
  const guard = (
    request: FastifyRequest,
    reply: FastifyReply,
  ): { id: string; userId: string } | null => {
    if (!request.subject) {
      void reply.code(401).send({ error: 'unauthenticated' });
      return null;
    }
    authorize(request.subject, 'break:write');
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      void reply.code(404).send({ error: 'not_found' });
      return null;
    }
    return { id: params.data.id, userId: request.subject.userId };
  };

  app.post('/v1/breaks/:id/commit', async (request, reply) => {
    const ctx = guard(request, reply);
    if (!ctx) return reply;

    const body = commitSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
    }

    try {
      const commitment = await commitBreak(db, ctx.userId, ctx.id, {
        slotCount: body.data.slotCount,
        keyRing,
      });
      await writeAuditLog(db, {
        actorId: ctx.userId,
        action: 'break.committed',
        targetType: 'break',
        targetId: ctx.id,
        // The commitment is public by design; the seed is not written anywhere but the
        // encrypted column.
        diff: { commitment: commitment.commitment, slotCount: commitment.slotCount },
      });
      return await reply.code(201).header('cache-control', 'no-store').send(commitment);
    } catch (error) {
      if (error instanceof CommitmentError) {
        return reply.code(409).send({ error: 'commit_failed', reason: error.message });
      }
      throw error;
    }
  });

  app.post('/v1/breaks/:id/client-seed', async (request, reply) => {
    const ctx = guard(request, reply);
    if (!ctx) return reply;

    const body = clientSeedSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
    }

    try {
      const commitment = await setClientSeed(db, ctx.userId, ctx.id, body.data.clientSeed);
      return await reply.header('cache-control', 'no-store').send(commitment);
    } catch (error) {
      if (error instanceof CommitmentError) {
        return reply.code(409).send({ error: 'client_seed_failed', reason: error.message });
      }
      throw error;
    }
  });

  app.post('/v1/breaks/:id/reveal', async (request, reply) => {
    const ctx = guard(request, reply);
    if (!ctx) return reply;

    try {
      const revealed = await revealBreak(db, secretsDb, ctx.userId, ctx.id, keyRing);
      await writeAuditLog(db, {
        actorId: ctx.userId,
        action: 'break.revealed',
        targetType: 'break',
        targetId: ctx.id,
      });
      return await reply.header('cache-control', 'no-store').send(revealed);
    } catch (error) {
      if (error instanceof CommitmentError) {
        return reply.code(409).send({ error: 'reveal_failed', reason: error.message });
      }
      throw error;
    }
  });
}

/**
 * Strip the overlay token's hash before a break leaves the server. It is a credential's
 * fingerprint: useless to a client, and an unnecessary thing to hand out.
 */
function withoutTokenHash<T extends { overlayTokenHash: string }>(
  row: T,
): Omit<T, 'overlayTokenHash'> {
  const copy: Record<string, unknown> = { ...row };
  delete copy['overlayTokenHash'];
  return copy as Omit<T, 'overlayTokenHash'>;
}

/** Creator tooling: breaks, pull logs, and the OBS overlay stream (Phase 2). */
export function registerBreakRoutes(app: FastifyInstance, deps: BreakDeps): void {
  const { db, tokenPepper } = deps;
  /** Live overlay connections per token hash, for the SR-2.4 cap. */
  const overlayConnections = new Map<string, number>();

  app.get('/v1/breaks', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'break:read');
    const items = await listBreaks(db, request.subject.userId);
    // The token hash is a credential's fingerprint; it has no business in a response.
    return reply.header('cache-control', 'no-store').send({ items: items.map(withoutTokenHash) });
  });

  app.post('/v1/breaks', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'break:write');

    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(parsed.error) });
    }

    const token = generateToken(OVERLAY_TOKEN_BYTES);
    let row;
    try {
      row = await createBreak(db, request.subject.userId, {
        title: parsed.data.title,
        sealedProductId: parsed.data.sealedProductId,
        costCents: parsed.data.costCents,
        overlayTokenHash: hashToken(token, tokenPepper),
      });
    } catch (error) {
      if (error instanceof BreakLimitError) {
        return reply.code(409).send({ error: 'break_limit_reached' });
      }
      throw error;
    }

    await writeAuditLog(db, {
      actorId: request.subject.userId,
      action: 'break.created',
      targetType: 'break',
      targetId: row.id,
    });

    // The only time the token is ever returned. It is not stored in plaintext anywhere.
    return reply
      .code(201)
      .header('cache-control', 'no-store')
      .send({ ...withoutTokenHash(row), overlayToken: token });
  });

  app.post('/v1/breaks/:id/status', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'break:write');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
    }
    const body = z
      .object({ status: z.enum(['live', 'ended']) })
      .strict()
      .safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
    }

    let row;
    try {
      row = await setBreakStatus(db, request.subject.userId, params.data.id, body.data.status);
    } catch (error) {
      // "Not found" and "not yours" are the same answer: never confirm another
      // creator's ids exist (SR-X.6).
      if (error instanceof BreakStateError) {
        return reply.code(409).send({ error: 'invalid_transition', reason: error.message });
      }
      throw error;
    }

    await writeAuditLog(db, {
      actorId: request.subject.userId,
      action: `break.${body.data.status}`,
      targetType: 'break',
      targetId: row.id,
    });
    return reply.header('cache-control', 'no-store').send(withoutTokenHash(row));
  });

  app.post('/v1/breaks/:id/overlay-token', async (request, reply) => {
    if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
    authorize(request.subject, 'break:write');

    const params = idParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
    }

    const token = generateToken(OVERLAY_TOKEN_BYTES);
    let row;
    try {
      row = await rotateOverlayToken(
        db,
        request.subject.userId,
        params.data.id,
        hashToken(token, tokenPepper),
      );
    } catch (error) {
      if (error instanceof BreakStateError) return reply.code(404).send({ error: 'not_found' });
      throw error;
    }

    await writeAuditLog(db, {
      actorId: request.subject.userId,
      action: 'break.overlay_token_rotated',
      targetType: 'break',
      targetId: row.id,
    });
    return reply
      .header('cache-control', 'no-store')
      .send({ overlayToken: token, overlayTokenVersion: row.overlayTokenVersion });
  });

  app.post(
    '/v1/breaks/:id/pulls',
    // Keyboard-first logging is fast by design (FR-2.2, under 3s a pull); the limit is
    // set well above a human and exists to bound a runaway client.
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!request.subject) return reply.code(401).send({ error: 'unauthenticated' });
      authorize(request.subject, 'break:write');

      const params = idParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: 'invalid_request', details: issuesOf(params.error) });
      }
      const body = pullSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_request', details: issuesOf(body.error) });
      }

      let pull;
      try {
        pull = await logPull(db, request.subject.userId, params.data.id, {
          cardVariantId: body.data.cardVariantId,
          label: body.data.label,
          valueCentsAtPull: body.data.valueCentsAtPull,
        });
      } catch (error) {
        if (error instanceof BreakLimitError) {
          return reply.code(409).send({ error: 'pull_limit_reached' });
        }
        if (error instanceof BreakStateError) {
          return reply.code(409).send({ error: 'break_not_live', reason: error.message });
        }
        throw error;
      }
      return await reply.code(201).header('cache-control', 'no-store').send(pull);
    },
  );

  /** The public break page (FR-2.2). No auth: a draft simply does not resolve. */
  app.get('/v1/breaks/:id/public', async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });

    const view = await getPublicBreak(db, params.data.id);
    if (!view) return reply.code(404).send({ error: 'not_found' });

    // The evidence travels with the break: the commitment, the seeds once revealed, and our
    // own reading of the chain. A viewer is not asked to take that reading on trust — the
    // raw hashed rows are here too, so their browser can reach its own conclusion and say so
    // if it differs from ours (SR-4.3).
    const [commitment, chain] = await Promise.all([
      getCommitment(db, params.data.id),
      checkChain(db, params.data.id),
    ]);

    return reply
      .header('cache-control', 'public, max-age=5')
      .send({ ...view, verification: { ...view.verification, commitment, chain } });
  });

  if (deps.keyRing && deps.secretsDb) {
    registerFairnessRoutes(app, deps.db, deps.keyRing, deps.secretsDb);
  }

  /** Export a pull log (FR-2.5). CSV cells are formula-escaped (SR-2.5). */
  app.get('/v1/breaks/:id/export', async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    const query = z
      .object({ format: z.enum(['csv', 'json']).default('json') })
      .strict()
      .safeParse(request.query);
    if (!params.success || !query.success) return reply.code(404).send({ error: 'not_found' });

    const view = await getPublicBreak(db, params.data.id);
    if (!view) return reply.code(404).send({ error: 'not_found' });

    if (query.data.format === 'json') {
      return reply.header('cache-control', 'no-store').send(view);
    }

    const csv = toCsv(
      ['seq', 'card', 'value_cents', 'pulled_at'],
      view.pulls.map((p) => [p.seq, p.label, p.valueCentsAtPull, p.pulledAt.toISOString()]),
    );
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="break-${params.data.id}.csv"`)
      .header('cache-control', 'no-store')
      .send(csv);
  });

  /**
   * The OBS overlay stream (FR-2.3).
   *
   * Server-sent events rather than websockets: one-way, reconnects by itself, and OBS's
   * browser source handles it without any extra machinery.
   */
  app.get('/v1/overlay/:token/stream', async (request, reply) => {
    const params = tokenParamSchema.safeParse(request.params);
    if (!params.success) {
      return overlayHeaders(reply).code(404).send({ error: 'not_found' });
    }

    const tokenHash = hashToken(params.data.token, tokenPepper);
    const initial = await getOverlayState(db, tokenHash);
    // A rotated or wrong token is indistinguishable from a missing break (AC-2.2).
    if (!initial) return overlayHeaders(reply).code(404).send({ error: 'not_found' });

    const open = overlayConnections.get(tokenHash) ?? 0;
    if (open >= MAX_OVERLAY_CONNECTIONS) {
      return overlayHeaders(reply).code(429).send({ error: 'too_many_connections' });
    }
    overlayConnections.set(tokenHash, open + 1);

    overlayHeaders(reply)
      .header('content-type', 'text/event-stream')
      .header('connection', 'keep-alive')
      // Proxies that buffer would defeat the point of streaming.
      .header('x-accel-buffering', 'no');
    reply.hijack();
    const { raw } = reply;
    raw.writeHead(200, reply.getHeaders() as Record<string, string>);

    let lastSeq = -1;
    let closed = false;
    const send = (event: string, data: unknown): void => {
      if (!closed) raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('state', initial);
    lastSeq = initial.pulls.at(-1)?.seq ?? 0;

    const poll = setInterval(() => {
      void (async () => {
        try {
          const state = await getOverlayState(db, tokenHash);
          if (!state) {
            // The token was rotated or the break deleted mid-stream: drop the viewer
            // rather than keep serving a revoked credential.
            send('revoked', {});
            cleanup();
            return;
          }
          const newest = state.pulls.at(-1)?.seq ?? 0;
          if (newest !== lastSeq) {
            lastSeq = newest;
            send('state', state);
          }
        } catch (error) {
          request.log.warn({ err: error }, 'overlay poll failed');
        }
      })();
    }, OVERLAY_POLL_MS);

    const heartbeat = setInterval(() => {
      // A comment frame: keeps proxies and OBS from treating the stream as dead.
      if (!closed) raw.write(': ping\n\n');
    }, OVERLAY_HEARTBEAT_MS);

    const idle = setTimeout(() => {
      send('closing', { reason: 'idle_timeout' });
      cleanup();
    }, OVERLAY_IDLE_TIMEOUT_MS);

    function cleanup(): void {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(heartbeat);
      clearTimeout(idle);
      overlayConnections.set(tokenHash, Math.max(0, (overlayConnections.get(tokenHash) ?? 1) - 1));
      if ((overlayConnections.get(tokenHash) ?? 0) === 0) overlayConnections.delete(tokenHash);
      raw.end();
    }

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });

  /** One-shot overlay state, for a client that cannot hold a stream open. */
  app.get('/v1/overlay/:token', async (request, reply) => {
    const params = tokenParamSchema.safeParse(request.params);
    if (!params.success) return overlayHeaders(reply).code(404).send({ error: 'not_found' });

    const state = await getOverlayState(db, hashToken(params.data.token, tokenPepper));
    if (!state) return overlayHeaders(reply).code(404).send({ error: 'not_found' });
    return overlayHeaders(reply).send(state);
  });
}
