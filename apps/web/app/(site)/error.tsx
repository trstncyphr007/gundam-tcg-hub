'use client';

import Link from 'next/link';

/**
 * The site's error page, inside the site's own layout (ADR-031: Next's default styles itself
 * inline, which the production CSP refuses).
 *
 * It never shows the error. A message or stack from the server is exactly the detail an
 * attacker probes for, and it means nothing to a collector. The digest is the one thing
 * worth showing: it is an opaque id that matches the server's log line, so a person who
 * reports the problem can hand over something that finds it.
 */
export default function SiteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  return (
    <div className="space-y-4" role="alert" data-testid="site-error">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="max-w-prose text-sm text-muted">
        That page could not be shown. Nothing you entered was lost by this. Try again, or come back
        in a minute.
      </p>
      {error.digest && (
        <p className="text-xs text-muted">
          Reference: <code>{error.digest}</code>
        </p>
      )}
      <p className="flex gap-4 text-sm">
        <button
          type="button"
          onClick={reset}
          className="rounded bg-accent px-4 py-2 font-medium"
          data-testid="error-retry"
        >
          Try again
        </button>
        <Link href="/" className="self-center underline">
          Home
        </Link>
      </p>
    </div>
  );
}
