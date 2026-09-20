'use client';

import { type SyntheticEvent, useState } from 'react';
import { authClient } from '@/lib/auth-client';

type Status =
  { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'error'; message: string };

export function SignInForm() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  async function requestLink(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatus({ kind: 'sending' });
    const { error } = await authClient.signIn.magicLink({ email, callbackURL: '/account/watches' });
    // Deliberately identical response whether or not the address has an account:
    // anything else would confirm who is registered (SR-X.4).
    setStatus(
      error
        ? { kind: 'error', message: 'Could not send the link. Try again shortly.' }
        : { kind: 'sent' },
    );
  }

  if (status.kind === 'sent') {
    return (
      <p
        className="rounded border p-4 text-sm"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        role="status"
      >
        Check your email. The link works once and expires in 15 minutes.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => {
          void authClient.signIn.social({ provider: 'discord', callbackURL: '/account/watches' });
        }}
        className="w-full rounded px-4 py-2 text-sm font-medium"
        style={{ background: '#5865f2' }}
      >
        Continue with Discord
      </button>

      <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--muted)' }}>
        <span className="h-px flex-1" style={{ background: 'var(--border)' }} />
        or
        <span className="h-px flex-1" style={{ background: 'var(--border)' }} />
      </div>

      <form onSubmit={(event) => void requestLink(event)} className="space-y-3">
        <label htmlFor="email" className="block text-sm">
          Email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          maxLength={254}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          className="w-full rounded border px-3 py-2 text-sm outline-none"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        />
        <button
          type="submit"
          disabled={status.kind === 'sending'}
          className="w-full rounded px-4 py-2 text-sm font-medium disabled:opacity-60"
          style={{ background: 'var(--accent)' }}
        >
          {status.kind === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
        </button>
        {status.kind === 'error' && (
          <p className="text-sm" role="alert" style={{ color: 'var(--accent)' }}>
            {status.message}
          </p>
        )}
      </form>
    </div>
  );
}
