import Link from 'next/link';

export const metadata = {
  title: 'Not found · Gundam TCG Hub',
  robots: { index: false, follow: false },
};

/**
 * The site's 404, inside the site's own layout — for `notFound()` from any page, and (via
 * the catch-all route) for any URL nothing matches. Styled with classes, so it renders
 * properly under a CSP that refuses inline styles (ADR-031).
 *
 * It says nothing about *why* something is missing. "Not found" and "not yours" must look
 * the same, or this page becomes a way to find out what exists (SR-X.6).
 */
export default function NotFound(): React.JSX.Element {
  return (
    <div className="space-y-4" data-testid="not-found">
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="max-w-prose text-sm text-muted">
        There is nothing at this address. It may have been moved, made private, or never existed.
      </p>
      <p className="flex gap-4 text-sm">
        <Link href="/" className="underline">
          Browse the catalog
        </Link>
        <Link href="/products" className="underline">
          Sealed products
        </Link>
      </p>
    </div>
  );
}
