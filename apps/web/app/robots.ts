import type { MetadataRoute } from 'next';
import { SITE_IS_PUBLIC } from '@/lib/site';

/**
 * `robots.txt`, which did not exist until now — the nightly scan noticed it 404ing.
 *
 * It follows the same switch as the pages (`SITE_IS_PUBLIC`), so the site cannot end up in the
 * state where the HTML says `noindex` and this file invites crawlers in, or the reverse. While
 * the site is private this refuses everything; a `noindex` tag only works on a page a crawler
 * has already fetched, and before launch there is no reason to let it fetch any.
 *
 * When it goes public, the areas that are private stay listed here as well. That is belt and
 * braces on purpose: `robots.txt` is a request rather than a control — the real protection is
 * that those pages need a session — but a well-behaved crawler should not be wandering into
 * somebody's account pages or a live overlay, and a URL that never appears in an index is a
 * URL that is never guessed at from one.
 */
const PRIVATE_AREAS = ['/account/', '/admin/', '/overlay/', '/creator/'];

export default function robots(): MetadataRoute.Robots {
  if (!SITE_IS_PUBLIC) {
    return { rules: [{ userAgent: '*', disallow: '/' }] };
  }
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: PRIVATE_AREAS }],
  };
}
