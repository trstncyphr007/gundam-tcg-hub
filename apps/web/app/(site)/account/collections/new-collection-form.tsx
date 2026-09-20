'use client';

import { useRouter } from 'next/navigation';
import { type SyntheticEvent, useState } from 'react';

export function NewCollectionForm(): React.JSX.Element {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/v1/collections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!response.ok) {
        setError(
          response.status === 409
            ? 'You have reached the collection limit.'
            : 'Could not create the collection.',
        );
        return;
      }
      setName('');
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="space-y-3 rounded border p-4"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      <h2 className="font-medium">New collection</h2>
      <label className="block text-sm">
        <span style={{ color: 'var(--muted)' }}>Name</span>
        <input
          required
          maxLength={80}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          placeholder="Main binder"
          data-testid="collection-name"
          className="mt-1 w-full rounded border px-3 py-2"
          style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
        />
      </label>
      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        Private until you say otherwise.
      </p>
      {error && (
        <p role="alert" className="text-sm" style={{ color: 'var(--danger, #f87171)' }}>
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || name.trim().length === 0}
        data-testid="create-collection"
        className="rounded px-4 py-2 text-sm font-medium disabled:opacity-50"
        style={{ background: 'var(--accent)' }}
      >
        {busy ? 'Creating…' : 'Create collection'}
      </button>
    </form>
  );
}
