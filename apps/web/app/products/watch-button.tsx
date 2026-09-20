'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

interface Props {
  productId: string;
  signedIn: boolean;
  existingWatchId: string | null;
}

/**
 * Same-origin fetch: the session cookie rides along automatically, and the server decides
 * ownership. Nothing here is trusted by the API beyond the product id.
 */
export function WatchButton({ productId, signedIn, existingWatchId }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const watching = existingWatchId !== null;

  if (!signedIn) {
    return (
      <a href="/sign-in" className="text-sm hover:underline" style={{ color: 'var(--muted)' }}>
        Sign in to watch
      </a>
    );
  }

  async function toggle(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = watching
        ? await fetch(`/v1/watches/${existingWatchId}`, { method: 'DELETE' })
        : await fetch('/v1/watches', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sealedProductId: productId, channels: ['email'] }),
          });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(
          body.error === 'watch_limit_reached'
            ? 'You have reached the watch limit.'
            : 'Could not update the watch.',
        );
        return;
      }
      startTransition(() => {
        router.refresh();
      });
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-right">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy || pending}
        aria-pressed={watching}
        className="rounded border px-3 py-1.5 text-sm disabled:opacity-60"
        style={{
          borderColor: watching ? 'var(--accent)' : 'var(--border)',
          color: watching ? 'var(--accent)' : 'inherit',
        }}
      >
        {busy || pending ? '…' : watching ? 'Watching' : 'Watch'}
      </button>
      {error && (
        <p className="mt-1 text-xs" role="alert" style={{ color: 'var(--accent)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
