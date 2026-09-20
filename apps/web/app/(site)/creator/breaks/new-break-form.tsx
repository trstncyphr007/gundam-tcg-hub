'use client';

import { useRouter } from 'next/navigation';
import { type SyntheticEvent, useState } from 'react';
import type { SealedProduct } from '@/lib/api';

export function NewBreakForm({ products }: { products: SealedProduct[] }): React.JSX.Element {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [productId, setProductId] = useState('');
  const [cost, setCost] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Shown once, then gone: the server never returns it again, so it lives in component
   * state only and is deliberately not persisted anywhere.
   */
  const [token, setToken] = useState<{ id: string; value: string } | null>(null);

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/v1/breaks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          ...(productId ? { sealedProductId: productId } : {}),
          ...(cost ? { costCents: Math.round(Number(cost) * 100) } : {}),
        }),
      });
      if (!response.ok) {
        setError(
          response.status === 403 ? 'Creator role required.' : 'Could not create the break.',
        );
        return;
      }
      const created = (await response.json()) as { id: string; overlayToken: string };
      setToken({ id: created.id, value: created.overlayToken });
      setTitle('');
      setCost('');
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (token) {
    const url = `${window.location.origin}/overlay/${token.value}`;
    return (
      <div
        className="space-y-3 rounded border p-4"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
      >
        <h2 className="font-medium">Break created — copy your overlay URL now</h2>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          This is shown <strong>once</strong>. Add it to OBS as a Browser Source. If you lose it or
          it ends up on stream, regenerate it from the break page — the old one dies immediately.
        </p>
        <input
          readOnly
          value={url}
          aria-label="Overlay URL"
          data-testid="overlay-url"
          onFocus={(e) => {
            e.currentTarget.select();
          }}
          className="w-full rounded border px-3 py-2 font-mono text-xs"
          style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
        />
        <button
          type="button"
          onClick={() => {
            setToken(null);
          }}
          className="rounded px-3 py-1.5 text-sm font-medium"
          style={{ background: 'var(--accent)' }}
        >
          I've saved it
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="space-y-3 rounded border p-4"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      <h2 className="font-medium">Start a new break</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm sm:col-span-2">
          <span style={{ color: 'var(--muted)' }}>Title</span>
          <input
            required
            maxLength={120}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
            }}
            placeholder="Freedom Ascension box break"
            className="mt-1 w-full rounded border px-3 py-2"
            style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
          />
        </label>
        <label className="block text-sm">
          <span style={{ color: 'var(--muted)' }}>Cost (USD)</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={cost}
            onChange={(e) => {
              setCost(e.target.value);
            }}
            placeholder="99.99"
            className="mt-1 w-full rounded border px-3 py-2"
            style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
          />
        </label>
      </div>
      <label className="block text-sm">
        <span style={{ color: 'var(--muted)' }}>Product (optional)</span>
        <select
          value={productId}
          onChange={(e) => {
            setProductId(e.target.value);
          }}
          className="mt-1 w-full rounded border px-3 py-2"
          style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
        >
          <option value="">Not specified</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p role="alert" className="text-sm" style={{ color: 'var(--danger, #f87171)' }}>
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || title.trim().length === 0}
        className="rounded px-4 py-2 text-sm font-medium disabled:opacity-50"
        style={{ background: 'var(--accent)' }}
      >
        {busy ? 'Creating…' : 'Create break'}
      </button>
    </form>
  );
}
