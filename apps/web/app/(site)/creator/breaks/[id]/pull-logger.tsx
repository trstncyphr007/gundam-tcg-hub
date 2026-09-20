'use client';

import { useRouter } from 'next/navigation';
import { type SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react';

interface Pull {
  seq: number;
  label: string;
  valueCentsAtPull: number;
}

type Status = 'draft' | 'live' | 'ended';

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Keyboard-first pull logging (FR-2.2): a break moves fast, so the card name and value are
 * two fields and Enter submits. Focus returns to the card field immediately, so a whole
 * pull is type-tab-type-Enter without ever reaching for the mouse.
 */
export function PullLogger({
  breakId,
  initialStatus,
  costCents,
  tokenVersion,
}: {
  breakId: string;
  initialStatus: Status;
  costCents: number | null;
  tokenVersion: number;
}): React.JSX.Element {
  const [status, setStatus] = useState<Status>(initialStatus);
  const [pulls, setPulls] = useState<Pull[]>([]);
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [rotated, setRotated] = useState<string | null>(null);
  const [version, setVersion] = useState(tokenVersion);
  const labelRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const total = pulls.reduce((sum, p) => sum + p.valueCentsAtPull, 0);

  const load = useCallback(async () => {
    const response = await fetch(`/v1/breaks/${breakId}/public`, { cache: 'no-store' });
    if (!response.ok) return;
    const view = (await response.json()) as { pulls: Pull[] };
    setPulls(view.pulls);
  }, [breakId]);

  useEffect(() => {
    if (status !== 'draft') void load();
  }, [status, load]);

  async function changeStatus(next: 'live' | 'ended'): Promise<void> {
    setError(null);
    const response = await fetch(`/v1/breaks/${breakId}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: next }),
    });
    if (!response.ok) {
      setError('Could not change the break status.');
      return;
    }
    setStatus(next);
    if (next === 'live') labelRef.current?.focus();
    // The heading and the "Public page" link live in the server component, which does not
    // know the status just changed. Without this the break is live but the page still
    // says draft, and the public link never appears until a manual reload.
    router.refresh();
  }

  async function submitPull(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = label.trim();
    if (trimmed.length === 0) return;
    setError(null);

    const cents = value.trim() === '' ? 0 : Math.round(Number(value) * 100);
    if (!Number.isFinite(cents) || cents < 0) {
      setError('That value is not a number.');
      return;
    }

    // Clear first so the next pull can be typed while this one is in flight; a break
    // does not pause for the network.
    setLabel('');
    setValue('');
    labelRef.current?.focus();

    const response = await fetch(`/v1/breaks/${breakId}/pulls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: trimmed, valueCentsAtPull: cents }),
    });
    if (!response.ok) {
      setError(`Could not log "${trimmed}". It was not saved.`);
      return;
    }
    const pull = (await response.json()) as Pull;
    setPulls((current) => [...current, { ...pull, label: trimmed }]);
  }

  async function rotateToken(): Promise<void> {
    setError(null);
    const response = await fetch(`/v1/breaks/${breakId}/overlay-token`, { method: 'POST' });
    if (!response.ok) {
      setError('Could not regenerate the overlay URL.');
      return;
    }
    const next = (await response.json()) as { overlayToken: string; overlayTokenVersion: number };
    setRotated(`${window.location.origin}/overlay/${next.overlayToken}`);
    setVersion(next.overlayTokenVersion);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        {status === 'draft' && (
          <button
            type="button"
            onClick={() => void changeStatus('live')}
            className="rounded px-4 py-2 text-sm font-medium"
            style={{ background: 'var(--accent)' }}
          >
            Start break
          </button>
        )}
        {status === 'live' && (
          <button
            type="button"
            onClick={() => void changeStatus('ended')}
            className="rounded border px-4 py-2 text-sm font-medium"
            style={{ borderColor: 'var(--border)' }}
          >
            End break
          </button>
        )}
        <button
          type="button"
          onClick={() => void rotateToken()}
          className="rounded border px-4 py-2 text-sm"
          style={{ borderColor: 'var(--border)' }}
        >
          Regenerate overlay URL
        </button>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          overlay v{version}
        </span>
      </div>

      {rotated && (
        <div
          className="space-y-2 rounded border p-4"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          <p className="text-sm font-medium">New overlay URL — the previous one is now dead</p>
          <input
            readOnly
            value={rotated}
            aria-label="Overlay URL"
            data-testid="overlay-url"
            onFocus={(e) => {
              e.currentTarget.select();
            }}
            className="w-full rounded border px-3 py-2 font-mono text-xs"
            style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
          />
        </div>
      )}

      {status === 'live' && (
        <form
          onSubmit={(e) => void submitPull(e)}
          className="flex flex-wrap gap-3 rounded border p-4"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          <label className="flex-1 text-sm" style={{ minWidth: '16rem' }}>
            <span style={{ color: 'var(--muted)' }}>Card</span>
            <input
              ref={labelRef}
              autoFocus
              value={label}
              maxLength={120}
              onChange={(e) => {
                setLabel(e.target.value);
              }}
              placeholder="Gundam Barbatos (parallel)"
              data-testid="pull-label"
              className="mt-1 w-full rounded border px-3 py-2"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
            />
          </label>
          <label className="text-sm" style={{ width: '9rem' }}>
            <span style={{ color: 'var(--muted)' }}>Value (USD)</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
              }}
              placeholder="0.00"
              data-testid="pull-value"
              className="mt-1 w-full rounded border px-3 py-2"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
            />
          </label>
          <button
            type="submit"
            data-testid="log-pull"
            className="self-end rounded px-4 py-2 text-sm font-medium"
            style={{ background: 'var(--accent)' }}
          >
            Log pull
          </button>
        </form>
      )}

      {error && (
        <p role="alert" className="text-sm" style={{ color: 'var(--danger, #f87171)' }}>
          {error}
        </p>
      )}

      <div className="flex gap-6 text-sm">
        <p>
          <span style={{ color: 'var(--muted)' }}>Pulled</span>{' '}
          <strong data-testid="pull-count">{pulls.length}</strong>
        </p>
        <p>
          <span style={{ color: 'var(--muted)' }}>Value</span>{' '}
          <strong data-testid="running-total">{dollars(total)}</strong>
        </p>
        {costCents !== null && (
          <p>
            <span style={{ color: 'var(--muted)' }}>vs cost</span>{' '}
            <strong style={{ color: total >= costCents ? 'var(--accent)' : undefined }}>
              {total >= costCents ? '+' : ''}
              {dollars(total - costCents)}
            </strong>
          </p>
        )}
      </div>

      {pulls.length > 0 && (
        <ol className="space-y-2" data-testid="pull-list">
          {[...pulls].reverse().map((pull) => (
            <li
              key={pull.seq}
              className="flex gap-3 rounded border px-3 py-2 text-sm"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
            >
              <span style={{ color: 'var(--muted)' }}>#{pull.seq}</span>
              <span className="min-w-0 flex-1">{pull.label}</span>
              <span>{dollars(pull.valueCentsAtPull)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
