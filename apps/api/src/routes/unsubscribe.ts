import { type Database, unsubscribeEmail } from '@gth/db';
import { signLink, verifyLink } from '@gth/security';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * One-click unsubscribe (SR-1.12, RFC 8058).
 *
 * The `List-Unsubscribe` header used to point at the watches page, which asks the reader to
 * sign in. That is somewhere to go and unsubscribe; it is not unsubscribing. A mail client
 * following it gets a sign-in form, a reader gets a chore, and Gmail — which now requires
 * working one-click unsubscribe from anyone sending in volume — gets a reason to put restock
 * alerts in spam. That last one would defeat the feature silently, which is the failure mode
 * this project keeps finding.
 *
 * So: a link that works with no session, carrying the watch id and a signature over it
 * (`signLink`). Nothing is stored, nothing expires, and rotating `TOKEN_PEPPER` invalidates
 * every outstanding link at once.
 *
 * **The POST is the one that matters.** RFC 8058 says a mail client may POST
 * `List-Unsubscribe=One-Click` without asking the reader anything, and that it must not be
 * answered with a confirmation page. The GET exists for a human who clicks the link in the
 * message body, and shows a plain page saying what happened.
 *
 * It removes the **email channel from that one watch**, and leaves the watch alone. "Stop
 * sending me this" is not "forget what I asked to be told about", and one click from a mail
 * client — possibly a scanner following links in a message, not the reader at all — should not
 * be able to throw away a choice somebody made.
 */
export const UNSUBSCRIBE_PURPOSE = 'unsubscribe:watch';

/**
 * The link that goes in the email, minted next to the code that checks it.
 *
 * Deliberately in this file. A signed link is two halves that must agree about the purpose
 * string and the shape, and the way those drift apart is by living in different places.
 */
export function unsubscribeUrl(
  config: { API_BASE_URL: string; TOKEN_PEPPER: string },
  userId: string,
  subscriptionId: string,
): string {
  const token = signLink(UNSUBSCRIBE_PURPOSE, `${userId}|${subscriptionId}`, config.TOKEN_PEPPER);
  return `${config.API_BASE_URL}/v1/unsubscribe?t=${encodeURIComponent(token)}`;
}

/**
 * Both ids out of a verified link.
 *
 * The owner travels in the link rather than being looked up. `watch_subscriptions` is FORCE'd,
 * so a connection with no session cannot see the row it would have to read to discover whose
 * it is, and escaping that with a `SECURITY DEFINER` function would mean granting the ability
 * to read every watch in order to change one.
 *
 * One signature covers both ids together, so a stranger cannot pair their own user with
 * somebody else's watch — and the update checks the two against each other regardless.
 */
function readToken(token: string, pepper: string): { userId: string; watchId: string } | null {
  const value = verifyLink(UNSUBSCRIBE_PURPOSE, token, pepper);
  if (value === null) return null;
  const cut = value.indexOf('|');
  if (cut <= 0 || cut === value.length - 1) return null;
  return { userId: value.slice(0, cut), watchId: value.slice(cut + 1) };
}

/** Escaped, because the only variable here is our own text, and that is how it stays. */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; }
  p { color: #333; }
  button { font: inherit; padding: .6rem 1rem; }
</style>
</head><body><h1>${title}</h1>${body}</body></html>`;
}

function html(reply: FastifyReply, status: number, title: string, body: string): FastifyReply {
  return (
    reply
      .code(status)
      .header('content-type', 'text/html; charset=utf-8')
      // Never cached and never indexed: the URL is the credential (SR-2.2's reasoning).
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header('x-robots-tag', 'noindex, nofollow')
      .send(page(title, body))
  );
}

export interface UnsubscribeDeps {
  db: Database;
  tokenPepper: string;
  /** Where to send somebody who wants to change their mind. */
  watchesUrl: string;
}

export async function registerUnsubscribeRoutes(
  app: FastifyInstance,
  deps: UnsubscribeDeps,
): Promise<void> {
  // Encapsulated, for the content-type parser below: these two routes accept a form body and
  // nothing else in the API does. Widening that app-wide would let a cross-site HTML form
  // reach every state-changing route — those are still protected by a `SameSite` cookie, but
  // the parser is the kind of thing that outlives the reason it was added.
  await app.register((scope, _opts, done) => {
    // RFC 8058's one-click POST sends `List-Unsubscribe=One-Click` as a form body. We read the
    // token from the query string and do not care what the body says, but Fastify refuses a
    // content type it cannot parse, so it has to be parseable. `URLSearchParams` is the
    // platform's own parser; hand-rolling one to avoid a dependency would be worse than either.
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, next) => {
        next(null, Object.fromEntries(new URLSearchParams(body as string)));
      },
    );
    registerRoutes(scope, deps);
    done();
  });
}

function registerRoutes(app: FastifyInstance, deps: UnsubscribeDeps): void {
  const tokenOf = (request: { query: unknown; body: unknown }): string | null => {
    const fromQuery = (request.query as { t?: unknown } | null)?.t;
    if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;
    const fromBody = (request.body as { t?: unknown } | null)?.t;
    return typeof fromBody === 'string' && fromBody.length > 0 ? fromBody : null;
  };

  const done = (reply: FastifyReply): FastifyReply =>
    html(
      reply,
      200,
      'Unsubscribed',
      `<p>You will no longer receive restock emails for that product.</p>
       <p>The watch itself is still there, switched off. You can turn it back on at
          <a href="${deps.watchesUrl}">your watches</a>.</p>`,
    );

  // A human clicking the link in the message. Shows what will happen and asks once, because a
  // GET should not change anything — a mail client or a security scanner may fetch it without
  // anybody having read the message.
  app.get('/v1/unsubscribe', (request, reply) => {
    const token = tokenOf(request);
    // Says plainly that a bad link is bad, unlike the POST below. That is deliberate rather
    // than inconsistent: the signature is unguessable, so anyone able to distinguish a valid
    // token already holds one and could simply use it. Telling a reader with a mangled link
    // that it is mangled is worth more than the nothing it conceals.
    if (token === null || readToken(token, deps.tokenPepper) === null) {
      return html(
        reply,
        404,
        'That link is not valid',
        `<p>That unsubscribe link is not valid. It may have been used after the site's keys
            were changed.</p>
         <p>You can always turn alerts off at <a href="${deps.watchesUrl}">your watches</a>.</p>`,
      );
    }
    return html(
      reply,
      200,
      'Unsubscribe',
      `<p>Stop sending restock emails for this product?</p>
       <form method="post" action="/v1/unsubscribe">
         <input type="hidden" name="t" value="${token}">
         <button type="submit">Unsubscribe</button>
       </form>`,
    );
  });

  // The one-click endpoint. Answers the same way whether the link was good, already used, or
  // never valid: a stranger with a guessed token learns nothing from the reply.
  app.post('/v1/unsubscribe', async (request, reply) => {
    const token = tokenOf(request);
    const ids = token === null ? null : readToken(token, deps.tokenPepper);
    if (ids !== null) await unsubscribeEmail(deps.db, ids.userId, ids.watchId);
    return done(reply);
  });
}
