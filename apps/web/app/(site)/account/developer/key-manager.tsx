'use client';

import { type SyntheticEvent, useState } from 'react';
import type { ApiKeySummary } from '@/lib/api';

/** A Map, not an object: the key comes from the server, and a lookup by dynamic key on a
 * plain object is the sink the linter is right to flag. */
const SCOPE_LABEL = new Map([
  ['catalog:read', 'Read the catalog'],
  ['prices:read', 'Read prices'],
]);

function when(value: string | null): string {
  if (value === null) return 'never';
  return new Date(value).toISOString().slice(0, 10);
}

export function KeyManager({
  initialKeys,
  limit,
  scopes,
}: {
  initialKeys: ApiKeySummary[];
  limit: number;
  scopes: string[];
}): React.JSX.Element {
  const [keys, setKeys] = useState<ApiKeySummary[]>(initialKeys);
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string[]>(scopes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Held in component state and nowhere else. The server cannot return it a second time --
   * it stored a hash, not the key -- so this is the only copy in existence until the person
   * puts it somewhere. It is deliberately not written to localStorage or the URL.
   */
  const [fresh, setFresh] = useState<{ name: string; value: string } | null>(null);

  const active = keys.filter((key) => key.revokedAt === null);

  async function refresh(): Promise<void> {
    const response = await fetch('/v1/developer/keys', { cache: 'no-store' });
    if (response.ok) setKeys(((await response.json()) as { items: ApiKeySummary[] }).items);
  }

  async function create(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (chosen.length === 0) {
      setError('A key needs at least one permission.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/v1/developer/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), scopes: chosen }),
      });
      if (!response.ok) {
        setError(
          response.status === 409
            ? `You already have ${String(limit)} keys. Revoke one first.`
            : 'Could not create the key.',
        );
        return;
      }
      const created = (await response.json()) as ApiKeySummary & { key: string };
      setFresh({ name: created.name, value: created.key });
      setName('');
      await refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: ApiKeySummary): Promise<void> {
    setError(null);
    const response = await fetch(`/v1/developer/keys/${key.id}`, { method: 'DELETE' });
    if (!response.ok) {
      setError('Could not revoke that key.');
      return;
    }
    await refresh();
  }

  return (
    <div className="space-y-6">
      {fresh && (
        <div className="space-y-3 rounded border p-4 bg-surface border-line">
          <h2 className="font-medium">Copy “{fresh.name}” now — it is shown once</h2>
          <p className="text-sm text-muted">
            We store a hash, not the key, so we cannot show it again or recover it for you. If it
            leaks, revoke it here and make another.
          </p>
          <input
            readOnly
            value={fresh.value}
            aria-label="New API key"
            data-testid="new-key"
            onFocus={(e) => {
              e.currentTarget.select();
            }}
            className="w-full rounded border px-3 py-2 font-mono text-xs bg-page border-line"
          />
          <button
            type="button"
            onClick={() => {
              setFresh(null);
            }}
            data-testid="dismiss-key"
            className="rounded px-3 py-1.5 text-sm font-medium bg-accent"
          >
            I&rsquo;ve saved it
          </button>
        </div>
      )}

      <form
        onSubmit={(e) => void create(e)}
        className="space-y-3 rounded border p-4 bg-surface border-line"
      >
        <h2 className="font-medium">New key</h2>
        <label className="block text-sm">
          <span className="text-muted">What is it for?</span>
          <input
            required
            maxLength={60}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            placeholder="Deck price widget"
            data-testid="key-name"
            className="mt-1 w-full rounded border px-3 py-2 bg-page border-line"
          />
        </label>
        <fieldset className="flex flex-wrap gap-4 text-sm">
          <legend className="text-xs text-muted">Permissions</legend>
          {scopes.map((scope) => (
            <label key={scope} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={chosen.includes(scope)}
                onChange={(e) => {
                  setChosen((current) =>
                    e.target.checked
                      ? [...current, scope]
                      : current.filter((value) => value !== scope),
                  );
                }}
              />
              {SCOPE_LABEL.get(scope) ?? scope}
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-muted">Keys are read-only. There is nothing a key can change.</p>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || name.trim().length === 0 || active.length >= limit}
          data-testid="create-key"
          className="rounded px-4 py-2 text-sm font-medium disabled:opacity-50 bg-accent"
        >
          {busy ? 'Creating…' : 'Create key'}
        </button>
      </form>

      {keys.length === 0 ? (
        <p className="text-sm text-muted">No keys yet. You can use the API without one.</p>
      ) : (
        <table className="w-full text-sm" data-testid="key-table">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-2">Name</th>
              <th className="py-2">Key</th>
              <th className="py-2">Permissions</th>
              <th className="py-2">Last used</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id} className="border-t border-line">
                <td className="py-2">
                  <span className={key.revokedAt === null ? 'font-medium' : ''}>{key.name}</span>
                  {key.revokedAt !== null && (
                    <span className="ml-2 text-xs text-muted">revoked {when(key.revokedAt)}</span>
                  )}
                </td>
                <td className="py-2 font-mono text-xs text-muted">
                  {/* The public half only — enough to tell two keys apart, useless on its own. */}
                  gth_…_{key.prefix}_…
                </td>
                <td className="py-2 text-xs text-muted">{key.scopes.join(', ')}</td>
                <td className="py-2 text-xs text-muted">{when(key.lastUsedAt)}</td>
                <td className="py-2 text-right">
                  {key.revokedAt === null && (
                    <button
                      type="button"
                      onClick={() => void revoke(key)}
                      data-testid="revoke-key"
                      className="text-xs underline text-muted"
                    >
                      revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
