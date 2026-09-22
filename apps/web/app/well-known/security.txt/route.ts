import { CONTACT_EMAIL, SECURITY_TXT_EXPIRY_DAYS } from '@/lib/site';

/**
 * `/.well-known/security.txt` (RFC 9116), rewritten to this path in `next.config.ts` because
 * Next does not route a directory whose name begins with a dot.
 *
 * Served only once a contact address exists. A security.txt naming an address nobody reads is
 * worse than none: it tells a finder they have reported something when they have not.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  if (CONTACT_EMAIL === null) {
    return new Response('Not found\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const expires = new Date(Date.now() + SECURITY_TXT_EXPIRY_DAYS * 86_400_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  const body = [
    `Contact: mailto:${CONTACT_EMAIL}`,
    `Expires: ${expires}`,
    'Preferred-Languages: en',
    'Policy: /security-policy',
    '',
  ].join('\n');

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      // Public, and cheap to re-read: an hour is plenty, and keeps `Expires` fresh.
      'cache-control': 'public, max-age=3600',
    },
  });
}
