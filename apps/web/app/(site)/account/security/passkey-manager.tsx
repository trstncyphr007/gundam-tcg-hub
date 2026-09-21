'use client';

import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import { authClient } from '@/lib/auth-client';

interface Passkey {
  id: string;
  name: string | null;
  deviceType: string;
  backedUp: boolean;
  createdAt: string | null;
}

/** What went wrong, phrased as what to do next. */
function explain(code: string, action: 'add' | 'remove'): string {
  switch (code) {
    case 'PASSKEY_SESSION_REQUIRED':
      // The rule that stops anyone with inbox access swapping in their own (ADR-025).
      return action === 'add'
        ? 'You already have a passkey. To add another, sign in with that one first.'
        : 'To remove a passkey, sign in with a passkey first. Lost the only one? It cannot be used without the device, so it is safe to leave.';
    case 'SESSION_NOT_FRESH':
    case 'SESSION_EXPIRED':
      return 'For your safety, sign in again (within the last ten minutes) before changing passkeys.';
    case 'USER_VERIFICATION_REQUIRED':
      return 'That device did not check it was you (PIN, fingerprint or face), so it cannot be used as a passkey here.';
    default:
      return 'That did not work. Nothing was changed.';
  }
}

function codeOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const { code } = value as { code?: unknown };
  return typeof code === 'string' ? code : '';
}

/**
 * Add, list and remove passkeys (SR-X.3, ADR-025).
 *
 * Adding or removing one needs a sign-in from the last ten minutes; adding a second, or
 * removing any, needs a sign-in *with* a passkey. When the server refuses for either reason the page says which,
 * with a sign-in link that comes straight back here — never a vague failure.
 */
export function PasskeyManager(): React.JSX.Element {
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; reauth: boolean } | null>(null);
  const [added, setAdded] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch('/api/auth/passkey/list-user-passkeys', { cache: 'no-store' });
    setPasskeys(response.ok ? ((await response.json()) as Passkey[]) : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function fail(code: string, action: 'add' | 'remove'): void {
    setProblem({
      message: explain(code, action),
      reauth:
        code === 'SESSION_NOT_FRESH' ||
        code === 'SESSION_EXPIRED' ||
        code === 'PASSKEY_SESSION_REQUIRED',
    });
  }

  async function add(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    setAdded(false);
    try {
      const result = await authClient.passkey.addPasskey({ name: name.trim() || 'My passkey' });
      if (result.error) {
        fail(codeOf(result.error), 'add');
        return;
      }
      setName('');
      setAdded(true);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch('/api/auth/passkey/delete-passkey', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!response.ok) {
        fail(codeOf(await response.json().catch(() => null)), 'remove');
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="space-y-4 rounded border p-4"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
      data-testid="passkey-manager"
    >
      <div>
        <h2 className="font-medium">Passkeys</h2>
        <p className="mt-1 max-w-prose text-sm" style={{ color: 'var(--muted)' }}>
          A passkey signs you in with your device&rsquo;s own lock — fingerprint, face or PIN —
          instead of an emailed link. Administrators need one: the moderation console only opens for
          a session started with a passkey.
        </p>
      </div>

      {passkeys === null ? (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Loading…
        </p>
      ) : passkeys.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--muted)' }} data-testid="no-passkeys">
          You have no passkeys yet.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="passkey-list">
          {passkeys.map((key) => (
            <li
              key={key.id}
              className="flex flex-wrap items-center gap-3 rounded border px-3 py-2 text-sm"
              style={{ borderColor: 'var(--border)' }}
              data-testid="passkey-row"
            >
              <span className="min-w-0 flex-1 font-medium">{key.name ?? 'Passkey'}</span>
              <span style={{ color: 'var(--muted)' }}>
                {key.backedUp ? 'synced' : 'this device only'}
                {key.createdAt ? ` · added ${new Date(key.createdAt).toLocaleDateString()}` : ''}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove(key.id)}
                data-testid="remove-passkey"
                className="underline disabled:opacity-50"
                style={{ color: 'var(--muted)' }}
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={(e) => void add(e)} className="flex flex-wrap items-end gap-3">
        <label className="flex-1 text-sm" style={{ minWidth: '14rem' }}>
          <span style={{ color: 'var(--muted)' }}>Name it</span>
          <input
            value={name}
            maxLength={60}
            onChange={(e) => {
              setName(e.target.value);
            }}
            placeholder="e.g. MacBook Touch ID"
            data-testid="passkey-name"
            className="mt-1 w-full rounded border px-3 py-2"
            style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          data-testid="add-passkey"
          className="rounded px-4 py-2 text-sm font-medium disabled:opacity-50"
          style={{ background: 'var(--accent)' }}
        >
          Add a passkey
        </button>
      </form>

      {added && (
        <p role="status" className="text-sm" data-testid="passkey-added">
          Passkey added. We have emailed you to confirm it — if you ever get that email without
          having done this, remove the passkey you do not recognise.
        </p>
      )}

      {problem && (
        <p
          role="alert"
          className="text-sm"
          style={{ color: '#f87171' }}
          data-testid="passkey-problem"
        >
          {problem.message}{' '}
          {problem.reauth && (
            <a
              href={`/sign-in?reason=step-up&next=${encodeURIComponent('/account/security')}`}
              className="underline"
              data-testid="passkey-reauth"
            >
              Sign in again
            </a>
          )}
        </p>
      )}
    </section>
  );
}
