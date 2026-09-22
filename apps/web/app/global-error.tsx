'use client';

import './globals.css';

/**
 * The last-resort error page, for when a root layout itself fails and `error.tsx` has no
 * layout to render into. It brings its own <html> and stylesheet, because Next's default
 * version styles itself inline and would render unstyled under the production CSP (ADR-031).
 *
 * Like the site's error page, it never shows the error — only the opaque digest that matches
 * the server's log.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  return (
    <html lang="en">
      <body className="mx-auto max-w-2xl space-y-4 p-8">
        <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="text-sm text-muted">The site could not be shown. Try again in a minute.</p>
        {error.digest && (
          <p className="text-xs text-muted">
            Reference: <code>{error.digest}</code>
          </p>
        )}
        <button
          type="button"
          onClick={reset}
          className="rounded bg-accent px-4 py-2 text-sm font-medium"
        >
          Try again
        </button>
      </body>
    </html>
  );
}
