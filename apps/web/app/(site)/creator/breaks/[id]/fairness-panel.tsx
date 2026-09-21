'use client';

import { type SyntheticEvent, useState } from 'react';

interface Commitment {
  commitment: string;
  clientSeed: string | null;
  revealedSeed: string | null;
  slotCount: number;
  algorithmVersion: string;
}

/**
 * Verifiable randomisation, from the creator's side (FR-4.2).
 *
 * The order of operations is the security property, so the UI enforces it as a sequence
 * rather than a form: commit before the break, take the audience's seed on stream, reveal
 * after. Each step only appears once the previous one is done, because a control people can
 * do out of order is a control they will do out of order.
 */
export function FairnessPanel({
  breakId,
  status,
  initial,
}: {
  breakId: string;
  status: 'draft' | 'live' | 'ended';
  initial: Commitment | null;
}): React.JSX.Element {
  const [commitment, setCommitment] = useState<Commitment | null>(initial);
  const [slots, setSlots] = useState('10');
  const [seed, setSeed] = useState('');
  const [order, setOrder] = useState<number[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(path: string, body?: unknown): Promise<unknown> {
    setBusy(true);
    setError(null);
    try {
      // No content-type when there is no body: declaring JSON and then sending nothing is a
      // 400 from Fastify, and "reveal" genuinely has no payload.
      const response = await fetch(`/v1/breaks/${breakId}/${path}`, {
        method: 'POST',
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { reason?: string } | null;
        setError(detail?.reason ?? 'That did not work.');
        return null;
      }
      return await response.json();
    } catch {
      setError('Could not reach the server.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function commit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const count = Number.parseInt(slots, 10);
    if (!Number.isInteger(count) || count < 2) {
      setError('Pick at least two slots.');
      return;
    }
    const result = (await call('commit', { slotCount: count })) as Commitment | null;
    if (result) setCommitment(result);
  }

  async function submitSeed(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const result = (await call('client-seed', { clientSeed: seed.trim() })) as Commitment | null;
    if (result) setCommitment(result);
  }

  async function reveal(): Promise<void> {
    const result = (await call('reveal')) as {
      commitment: Commitment;
      order: number[];
    } | null;
    if (result) {
      setCommitment(result.commitment);
      setOrder(result.order);
    }
  }

  return (
    <section
      className="space-y-4 rounded border p-4"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
      data-testid="fairness-panel"
    >
      <div>
        <h2 className="font-medium">Verifiable randomisation</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
          Commit before you open anything, read the commitment out on stream, take a seed from chat,
          then reveal at the end. Viewers can check the result themselves.
        </p>
      </div>

      {!commitment && status === 'draft' && (
        <form onSubmit={(e) => void commit(e)} className="flex flex-wrap items-end gap-3">
          <label className="text-sm" style={{ width: '9rem' }}>
            <span style={{ color: 'var(--muted)' }}>Slots</span>
            <input
              type="number"
              min="2"
              max="1000"
              value={slots}
              onChange={(e) => {
                setSlots(e.target.value);
              }}
              data-testid="slot-count"
              className="mt-1 w-full rounded border px-3 py-2"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            data-testid="commit-break"
            className="rounded px-4 py-2 text-sm font-medium disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
          >
            Commit
          </button>
        </form>
      )}

      {!commitment && status !== 'draft' && (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          This break has already started, so it is too late to commit. A commitment made afterwards
          would prove nothing about what already happened.
        </p>
      )}

      {commitment && (
        <>
          <div className="text-xs">
            <p style={{ color: 'var(--muted)' }}>Read this out before you open anything:</p>
            <p className="mt-1 break-all font-mono" data-testid="commitment-value">
              {commitment.commitment}
            </p>
          </div>

          {commitment.clientSeed === null ? (
            <form onSubmit={(e) => void submitSeed(e)} className="flex flex-wrap items-end gap-3">
              <label className="flex-1 text-sm" style={{ minWidth: '14rem' }}>
                <span style={{ color: 'var(--muted)' }}>Audience seed</span>
                <input
                  required
                  maxLength={200}
                  value={seed}
                  onChange={(e) => {
                    setSeed(e.target.value);
                  }}
                  placeholder="A number from chat, or a future block hash"
                  data-testid="client-seed"
                  className="mt-1 w-full rounded border px-3 py-2"
                  style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
                />
              </label>
              <button
                type="submit"
                disabled={busy}
                data-testid="set-client-seed"
                className="rounded px-4 py-2 text-sm font-medium disabled:opacity-50"
                style={{ background: 'var(--accent)' }}
              >
                Lock it in
              </button>
            </form>
          ) : (
            <p className="text-xs">
              <span style={{ color: 'var(--muted)' }}>Audience seed: </span>
              <span className="font-mono" data-testid="locked-seed">
                {commitment.clientSeed}
              </span>
            </p>
          )}

          {commitment.revealedSeed === null ? (
            <button
              type="button"
              onClick={() => void reveal()}
              disabled={busy || status !== 'ended' || commitment.clientSeed === null}
              data-testid="reveal-break"
              title={
                status !== 'ended'
                  ? 'End the break first — revealing early makes the remaining slots predictable'
                  : undefined
              }
              className="rounded border px-4 py-2 text-sm font-medium disabled:opacity-50"
              style={{ borderColor: 'var(--border)' }}
            >
              Reveal the seed
            </button>
          ) : (
            <div className="space-y-1 text-xs">
              <p>
                <span style={{ color: 'var(--muted)' }}>Revealed seed: </span>
                <span className="break-all font-mono">{commitment.revealedSeed}</span>
              </p>
              {order && (
                <p>
                  <span style={{ color: 'var(--muted)' }}>Slot order: </span>
                  <span className="font-mono" data-testid="revealed-order">
                    {order.join(', ')}
                  </span>
                </p>
              )}
            </div>
          )}
        </>
      )}

      {error && (
        <p role="alert" className="text-sm" style={{ color: 'var(--danger, #f87171)' }}>
          {error}
        </p>
      )}
    </section>
  );
}
