'use client';

import { useState } from 'react';

type Kind = 'reports' | 'flags';

function labelsFor(kind: Kind): {
  accept: string;
  reject: string;
  acceptVerb: 'approve' | 'clear';
} {
  return kind === 'flags'
    ? { accept: 'Clear — it was real', reject: 'Reject', acceptVerb: 'clear' }
    : { accept: 'Approve', reject: 'Reject', acceptVerb: 'approve' };
}

/**
 * One decision, with its reason (SR-5.9).
 *
 * The reason box is required and sits *before* the buttons, so the order on screen is the
 * order of thought: look at the evidence, say why, then decide. A console where the buttons
 * come first is one where the reason gets written afterwards to fit.
 */
export function DecisionCard({
  kind,
  id,
  children,
}: {
  kind: Kind;
  id: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const [reason, setReason] = useState('');
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'busy' }
    | { status: 'done'; decision: string }
    | { status: 'error'; message: string }
  >({ status: 'idle' });
  const labels = labelsFor(kind);

  async function decide(decision: string): Promise<void> {
    if (reason.trim().length < 3) {
      setState({ status: 'error', message: 'Say why first — it goes in the audit log.' });
      return;
    }
    setState({ status: 'busy' });
    try {
      const response = await fetch(`/v1/admin/${kind}/${id}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, reason }),
      });
      if (response.ok) {
        setState({ status: 'done', decision });
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (body?.error === 'step_up_required') {
        // The session aged out while the page was open. Send them to sign in and back,
        // rather than showing an error they cannot act on.
        window.location.assign(
          `/sign-in?reason=step-up&next=${encodeURIComponent('/admin/moderation')}`,
        );
        return;
      }
      setState({
        status: 'error',
        message:
          body?.error === 'already_decided'
            ? 'Someone else decided this one a moment ago. Reload to see the queue as it is now.'
            : 'That decision was not saved.',
      });
    } catch {
      setState({ status: 'error', message: 'Could not reach the server.' });
    }
  }

  if (state.status === 'done') {
    return (
      <li
        className="rounded border px-4 py-3 text-sm border-line text-muted"
        data-testid={`decided-${kind}`}
      >
        {state.decision === 'reject'
          ? 'Rejected'
          : labels.acceptVerb === 'clear'
            ? 'Cleared'
            : 'Approved'}
        {' — '}
        {reason.trim()}
      </li>
    );
  }

  return (
    <li
      className="space-y-3 rounded border p-4 bg-surface border-line"
      data-testid={`queue-${kind}`}
    >
      {children}

      <label className="block text-sm">
        <span className="text-muted">Why</span>
        <input
          value={reason}
          maxLength={280}
          onChange={(e) => {
            setReason(e.target.value);
          }}
          placeholder={
            kind === 'flags' ? 'e.g. watched the VOD at 1:02:03' : 'e.g. receipt matches'
          }
          data-testid="decision-reason"
          className="mt-1 w-full rounded border px-3 py-2 bg-page border-line"
        />
      </label>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={state.status === 'busy'}
          onClick={() => void decide(labels.acceptVerb)}
          data-testid="decision-accept"
          className="rounded px-4 py-2 text-sm font-medium disabled:opacity-50 bg-accent"
        >
          {labels.accept}
        </button>
        <button
          type="button"
          disabled={state.status === 'busy'}
          onClick={() => void decide('reject')}
          data-testid="decision-reject"
          className="rounded border px-4 py-2 text-sm font-medium disabled:opacity-50 border-line"
        >
          {labels.reject}
        </button>
      </div>

      {state.status === 'error' && (
        <p role="alert" className="text-sm text-danger" data-testid="decision-error">
          {state.message}
        </p>
      )}
    </li>
  );
}
