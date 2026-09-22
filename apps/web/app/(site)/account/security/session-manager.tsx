'use client';

import { useCallback, useEffect, useState } from 'react';

interface Session {
  id: string;
  device: string;
  method: 'passkey' | 'magic_link' | 'discord' | null;
  signedInAt: string;
  current: boolean;
}

const METHOD_LABELS = new Map<string, string>([
  ['passkey', 'passkey'],
  ['magic_link', 'email link'],
  ['discord', 'Discord'],
]);

function methodLabel(method: Session['method']): string {
  return METHOD_LABELS.get(method ?? '') ?? 'unknown method';
}

/**
 * Where this account is signed in, and a way to end any of it (§16.2, SR-X.5, ADR-026).
 *
 * A session opened with a passkey can only be ended from another passkey session. The page
 * says so when it happens rather than offering a button that silently does nothing.
 */
export function SessionManager(): React.JSX.Element {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; problem: boolean } | null>(null);

  const load = useCallback(async () => {
    const response = await fetch('/v1/account/sessions', { cache: 'no-store' });
    setSessions(response.ok ? ((await response.json()) as { sessions: Session[] }).sessions : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(id: string): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/v1/account/sessions/${encodeURIComponent(id)}/revoke`, {
        method: 'POST',
      });
      if (response.status === 403) {
        setMessage({
          text: 'That session was started with a passkey. Sign in with a passkey to end it.',
          problem: true,
        });
        return;
      }
      if (!response.ok && response.status !== 404) {
        setMessage({ text: 'That did not work. Nothing was changed.', problem: true });
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function revokeOthers(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/v1/account/sessions/revoke-others', { method: 'POST' });
      if (!response.ok) {
        setMessage({ text: 'That did not work. Nothing was changed.', problem: true });
        return;
      }
      const { revoked, keptPasskeySessions } = (await response.json()) as {
        revoked: number;
        keptPasskeySessions: number;
      };
      const ended = `Signed out ${String(revoked)} other session${revoked === 1 ? '' : 's'}.`;
      setMessage({
        text:
          keptPasskeySessions > 0
            ? `${ended} ${String(keptPasskeySessions)} started with a passkey ${keptPasskeySessions === 1 ? 'is' : 'are'} still signed in — sign in with a passkey to end ${keptPasskeySessions === 1 ? 'it' : 'them'}.`
            : ended,
        problem: false,
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  const others = sessions?.filter((s) => !s.current).length ?? 0;

  return (
    <section
      className="space-y-4 rounded border p-4 bg-surface border-line"
      data-testid="session-manager"
    >
      <div>
        <h2 className="font-medium">Where you are signed in</h2>
        <p className="mt-1 max-w-prose text-sm text-muted">
          Every browser signed in to this account. If you see one you do not recognise, sign it out.
          We also email you the first time a new device signs in.
        </p>
      </div>

      {sessions === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <ul className="space-y-2" data-testid="session-list">
          {sessions.map((session) => (
            <li
              key={session.id}
              className="flex flex-wrap items-center gap-3 rounded border px-3 py-2 text-sm border-line"
              data-testid="session-row"
              data-current={session.current ? 'true' : 'false'}
            >
              <span className="min-w-0 flex-1 font-medium">{session.device}</span>
              <span className="text-muted">
                {methodLabel(session.method)} · signed in{' '}
                {new Date(session.signedInAt).toLocaleString()}
              </span>
              {session.current ? (
                <span className="font-medium" data-testid="session-current">
                  this device
                </span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void revoke(session.id)}
                  data-testid="revoke-session"
                  className="underline disabled:opacity-50 text-muted"
                >
                  sign out
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {others > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void revokeOthers()}
          data-testid="revoke-others"
          className="rounded border px-4 py-2 text-sm font-medium disabled:opacity-50 border-line"
        >
          Sign out everywhere else
        </button>
      )}

      {message && (
        <p
          role={message.problem ? 'alert' : 'status'}
          className={message.problem ? 'text-sm text-danger' : 'text-sm'}
          data-testid={message.problem ? 'sessions-problem' : 'sessions-result'}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
