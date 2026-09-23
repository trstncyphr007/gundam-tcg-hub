'use client';

import { useState } from 'react';

/**
 * One kill switch (plan §22, ADR-039).
 *
 * Built for somebody who is having a bad morning: the reason box comes before the button, the
 * button says exactly what it will do, and turning something **off** asks once more before it
 * does it. Turning something back **on** does not — restoring service should never be the
 * slower path.
 */
export function SwitchCard({
  flagKey,
  label,
  effect,
  enabled,
  reason,
  updatedAt,
}: {
  flagKey: string;
  label: string;
  effect: string;
  enabled: boolean;
  reason: string;
  updatedAt: string;
}): React.JSX.Element {
  const [why, setWhy] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<
    { status: 'idle' } | { status: 'busy' } | { status: 'error'; message: string }
  >({ status: 'idle' });

  async function flip(next: boolean): Promise<void> {
    if (why.trim().length < 3) {
      setState({ status: 'error', message: 'Say why first — it goes in the audit log.' });
      return;
    }
    setState({ status: 'busy' });
    try {
      const response = await fetch(`/v1/admin/flags/${flagKey}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: next, reason: why }),
      });
      if (response.ok) {
        // Reload rather than patching state: the switch that was just flipped changes what
        // the rest of this page says, and a stale page here is genuinely dangerous.
        window.location.reload();
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (body?.error === 'step_up_required' || body?.error === 'passkey_required') {
        window.location.assign(
          `/sign-in?reason=step-up&next=${encodeURIComponent('/admin/switches')}`,
        );
        return;
      }
      setState({ status: 'error', message: 'That change was not saved.' });
    } catch {
      setState({ status: 'error', message: 'Could not reach the server.' });
    }
  }

  return (
    <li
      className="space-y-3 rounded border p-4 bg-surface border-line"
      data-testid="switch"
      data-key={flagKey}
      data-enabled={String(enabled)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="font-medium">{label}</h2>
          <p className="text-sm text-muted">{effect}</p>
        </div>
        <span
          className={enabled ? 'text-sm text-muted' : 'text-sm font-medium text-danger'}
          data-testid="switch-state"
        >
          {enabled ? 'On' : 'OFF'}
        </span>
      </div>

      {!enabled && reason !== '' && (
        <p className="text-sm text-warning" data-testid="switch-reason">
          Switched off {new Date(updatedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC —{' '}
          {reason}
        </p>
      )}

      <label className="block text-sm">
        <span className="text-muted">Why</span>
        <input
          value={why}
          maxLength={280}
          onChange={(e) => {
            setWhy(e.target.value);
            setConfirming(false);
          }}
          placeholder={enabled ? 'e.g. suspected credential stuffing' : 'e.g. attack has stopped'}
          data-testid="switch-why"
          className="mt-1 w-full rounded border px-3 py-2 bg-page border-line"
        />
      </label>

      {state.status === 'error' && (
        <p className="text-sm text-danger" data-testid="switch-error">
          {state.message}
        </p>
      )}

      {enabled ? (
        confirming ? (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={state.status === 'busy'}
              onClick={() => void flip(false)}
              data-testid="switch-confirm-off"
              className="rounded px-4 py-2 text-sm font-medium disabled:opacity-50 bg-danger"
            >
              Yes, switch it off
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
              }}
              className="text-sm underline"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setConfirming(true);
            }}
            data-testid="switch-off"
            className="rounded border px-4 py-2 text-sm font-medium border-line"
          >
            Switch off
          </button>
        )
      ) : (
        <button
          type="button"
          disabled={state.status === 'busy'}
          onClick={() => void flip(true)}
          data-testid="switch-on"
          className="rounded px-4 py-2 text-sm font-medium disabled:opacity-50 bg-accent"
        >
          Switch back on
        </button>
      )}
    </li>
  );
}
