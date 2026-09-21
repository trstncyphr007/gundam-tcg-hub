'use client';

import { type SyntheticEvent, useState } from 'react';
import { authClient } from '@/lib/auth-client';

type Status =
  { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'error'; message: string };

/**
 * Where the auth server should send someone once they are signed in.
 *
 * Absolute, on this site's own origin. A *relative* callback is resolved by the auth server
 * against **its** base URL — the API's origin — so wherever the API and the site are on
 * different origins (local dev today; `api.<domain>` in the plan's Caddyfile), `/admin` lands
 * on the API and answers with its 404. The default `/account/watches` had the same flaw since
 * Phase 1; a test helper that mangled the emailed link hid it until the step-up round trip
 * needed the redirect to actually work.
 *
 * `next` has already been through `safeNextPath` on the server, so this only ever joins our
 * own origin to a path on it.
 */
function absoluteCallback(next: string): string {
  return new URL(next, window.location.origin).href;
}

/**
 * `next` arrives already validated by the page (`safeNextPath`), so it is a path on this
 * origin or the default — never a URL someone put in a link.
 */
export function SignInForm({ next }: { next: string }) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [passkeyError, setPasskeyError] = useState<string | null>(null);

  /**
   * Sign in with a passkey (ADR-025).
   *
   * No email first: the passkey is discoverable, so the device offers the right credential
   * itself. On success the session is already set; the page moves on to `next` directly,
   * because a passkey sign-in has no emailed link to carry a callback.
   */
  async function signInWithPasskey(): Promise<void> {
    setPasskeyError(null);
    const result = await authClient.signIn.passkey();
    if (result.error) {
      // Cancelling the browser prompt is the commonest "error" and not worth alarming anyone.
      const { code } = result.error as { code?: unknown };
      setPasskeyError(
        code === 'USER_VERIFICATION_REQUIRED'
          ? 'That passkey did not check it was you (PIN, fingerprint or face). Try one that does.'
          : 'No passkey sign-in happened. You can try again, or use one of the options below.',
      );
      return;
    }
    window.location.assign(next);
  }

  async function requestLink(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatus({ kind: 'sending' });
    const { error } = await authClient.signIn.magicLink({
      email,
      callbackURL: absoluteCallback(next),
    });
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
        onClick={() => void signInWithPasskey()}
        data-testid="passkey-sign-in"
        className="w-full rounded border px-4 py-2 text-sm font-medium"
        style={{ borderColor: 'var(--border)' }}
      >
        Sign in with a passkey
      </button>
      {passkeyError && (
        <p
          className="text-sm"
          role="alert"
          data-testid="passkey-sign-in-error"
          style={{ color: 'var(--accent)' }}
        >
          {passkeyError}
        </p>
      )}

      <button
        type="button"
        onClick={() => {
          void authClient.signIn.social({
            provider: 'discord',
            callbackURL: absoluteCallback(next),
          });
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

      {/*
        method="post" matters even though JavaScript handles the submit. A form with no
        method defaults to GET, so if the script ever fails to run the browser navigates to
        `/sign-in?email=...` and the address lands in the URL bar, history, and any referrer.
        A ZAP baseline caught exactly that, and the hydration bug we hit in Phase 2 showed
        the degraded path is not hypothetical.
      */}
      <form method="post" onSubmit={(event) => void requestLink(event)} className="space-y-3">
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
