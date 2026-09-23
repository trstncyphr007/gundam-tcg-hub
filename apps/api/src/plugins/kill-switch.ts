import { FLAGS, type FlagReader } from '@gth/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

/**
 * The public API's kill switch (plan §22, ADR-039).
 *
 * Turning it off answers 503 with a `Retry-After`, which is the honest status code: the
 * service exists and is coming back, as opposed to 404 (never existed) or 403 (you are not
 * allowed). Caches and clients treat it accordingly.
 *
 * **What it deliberately does not switch off:** the admin console, the auth endpoints, and
 * `/healthz`. Two reasons, and both are the kind of thing discovered at the worst moment:
 *
 *  - An admin has to be able to sign in and **turn it back on**. A switch that locks the
 *    operator out of the room with the switch in it is not a control, it is a trap.
 *  - `/healthz` going dark tells the orchestrator the container is broken, and it would be
 *    restarted — repeatedly — while someone is deliberately holding it closed.
 */
export interface KillSwitchOptions {
  flags: FlagReader;
  /** Which requests the public switch covers. */
  applies: (request: FastifyRequest) => boolean;
}

export const DISABLED_BODY = {
  error: 'temporarily_disabled',
  message: 'This API is temporarily switched off. Try again shortly.',
} as const;

function plugin(app: FastifyInstance, options: KillSwitchOptions): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    if (!options.applies(request)) return;
    if (await options.flags.isEnabled(FLAGS.publicApiEnabled)) return;

    await reply
      .code(503)
      .header('retry-after', '300')
      // Never let a switched-off answer be cached as if it were the truth.
      .header('cache-control', 'no-store')
      .send(DISABLED_BODY);
  });
  return Promise.resolve();
}

export const killSwitchPlugin = fp(plugin, { name: 'kill-switch' });
