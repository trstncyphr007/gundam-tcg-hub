'use client';

// The submodule, not the package barrel: this ships to a browser, and the barrel would drag
// env parsing and pricing maths into the bundle alongside it. The verifier needs the
// algorithm and nothing else.
import { deriveShuffle, verifyChain, verifyShuffle } from '@gth/core/fairness';
import { useCallback, useEffect, useState } from 'react';

/**
 * The break verifier, running in the viewer's browser (FR-4.2, SR-4.3, AC-4.1).
 *
 * Everything here happens on the reader's machine, from values they can see and copy. That
 * is the entire point: a fairness claim checked only by the party making it is not a check.
 * The server publishes its own opinion of the chain alongside the evidence, and this
 * component says so loudly when the two disagree — our answer is a convenience, not the
 * authority.
 *
 * It imports the same module the server uses. Not a re-implementation that might quietly
 * drift, and not a copy pinned to a version of the algorithm nobody runs any more.
 */

export interface VerifiableRow {
  seq: number;
  cardVariantId: string | null;
  label: string | null;
  valueCentsAtPull: number;
  valueSource: string;
  pulledAt: string;
  prevHash: string | null;
  rowHash: string | null;
}

export interface CommitmentView {
  commitment: string;
  clientSeed: string | null;
  revealedSeed: string | null;
  slotCount: number;
  algorithmVersion: string;
  committedAt: string;
  revealedAt: string | null;
}

export interface ServerChainView {
  state: 'valid' | 'invalid' | 'unverifiable' | 'empty';
  brokenAtSeq: number | null;
  head: string | null;
}

type Outcome =
  | { kind: 'checking' }
  | { kind: 'pass'; detail: string }
  | { kind: 'fail'; detail: string }
  | { kind: 'skip'; detail: string };

function Verdict({ label, outcome }: { label: string; outcome: Outcome }): React.JSX.Element {
  const colour =
    outcome.kind === 'pass'
      ? 'text-accent'
      : outcome.kind === 'fail'
        ? 'text-danger'
        : 'text-muted';
  const mark =
    outcome.kind === 'pass'
      ? '✓'
      : outcome.kind === 'fail'
        ? '✗'
        : outcome.kind === 'skip'
          ? '–'
          : '…';

  return (
    <li className="flex gap-3 text-sm">
      <span aria-hidden className={colour}>
        {mark}
      </span>
      <span className="min-w-0 flex-1">
        <strong>{label}</strong>
        <span className="block text-xs text-muted">
          {outcome.kind === 'checking' ? 'checking…' : outcome.detail}
        </span>
      </span>
    </li>
  );
}

export function BreakVerifier({
  breakId,
  commitment,
  chain,
  rows,
}: {
  breakId: string;
  commitment: CommitmentView | null;
  chain: ServerChainView;
  rows: VerifiableRow[];
}): React.JSX.Element {
  const [shuffle, setShuffle] = useState<Outcome>({ kind: 'checking' });
  const [chainResult, setChainResult] = useState<Outcome>({ kind: 'checking' });
  const [order, setOrder] = useState<number[] | null>(null);
  const [agrees, setAgrees] = useState(true);
  /** What is being checked. Starts as what the page was rendered with; a re-fetch replaces it. */
  const [evidence, setEvidence] = useState({ commitment, chain, rows });
  const [refetching, setRefetching] = useState(false);

  /**
   * Fetch the evidence again, from the public endpoint, and re-check it.
   *
   * The page arrives server-rendered, which is convenient and is also exactly the thing a
   * sceptic should not have to accept. This button pulls the same JSON anyone can `curl`
   * and re-runs both checks against it — so the verdict on screen can be traced to a
   * request the reader made, not one we made for them.
   */
  const refetch = useCallback(async () => {
    setRefetching(true);
    try {
      const response = await fetch(`/v1/breaks/${breakId}/public`, { cache: 'no-store' });
      if (!response.ok) return;
      const body = (await response.json()) as {
        verification: {
          commitment: CommitmentView | null;
          chain: ServerChainView;
          rows: VerifiableRow[];
        };
      };
      setEvidence(body.verification);
    } catch {
      // Leave the existing evidence in place; the verdict on screen stays the one it came from.
    } finally {
      setRefetching(false);
    }
  }, [breakId]);

  const run = useCallback(async () => {
    const { commitment, chain, rows } = evidence;
    // --- the shuffle ---
    if (!commitment) {
      setShuffle({
        kind: 'skip',
        detail: 'This break did not use verifiable randomisation.',
      });
    } else if (commitment.revealedSeed === null || commitment.clientSeed === null) {
      setShuffle({
        kind: 'skip',
        detail:
          'The seed has not been revealed yet. It cannot be, until the break ends — that is ' +
          'what stops the remaining slots being predictable.',
      });
    } else {
      // Derive the order the seeds produce, then check the revealed seed against the
      // commitment published beforehand. Those are two different claims and only the second
      // can fail here: the first is a computation, not an assertion. What it buys the viewer
      // is a number they can compare against what the creator actually did on stream.
      const derived = await deriveShuffle({
        serverSeed: commitment.revealedSeed,
        clientSeed: commitment.clientSeed,
        breakId,
        count: commitment.slotCount,
      });
      setOrder(derived);

      const checked = await verifyShuffle({
        serverSeed: commitment.revealedSeed,
        clientSeed: commitment.clientSeed,
        breakId,
        commitment: commitment.commitment,
        claimedOrder: derived,
      });

      setShuffle(
        checked.commitmentMatches
          ? {
              kind: 'pass',
              detail:
                'The revealed seed hashes to the commitment published before the break, so it ' +
                'could not have been chosen afterwards. The slot order below follows from it.',
            }
          : {
              kind: 'fail',
              detail:
                'The revealed seed does NOT hash to the commitment published before the ' +
                'break. That would mean the seed was chosen after the outcome was known.',
            },
      );
    }

    // --- the pull log ---
    if (rows.length === 0) {
      setChainResult({ kind: 'skip', detail: 'No pulls were logged.' });
      return;
    }
    if (rows.some((r) => r.prevHash === null || r.rowHash === null)) {
      setChainResult({
        kind: 'skip',
        detail: 'This log predates the hash chain, so there is nothing to check against.',
      });
      return;
    }

    const result = await verifyChain(
      rows.map((r) => ({
        seq: r.seq,
        cardVariantId: r.cardVariantId,
        label: r.label,
        valueCentsAtPull: r.valueCentsAtPull,
        valueSource: r.valueSource,
        pulledAt: r.pulledAt,
        prevHash: String(r.prevHash),
        rowHash: String(r.rowHash),
      })),
    );

    setChainResult(
      result.valid
        ? {
            kind: 'pass',
            detail: `All ${String(rows.length)} pulls hash to the published chain, in order.`,
          }
        : {
            kind: 'fail',
            detail: `The log was altered at pull #${String(result.brokenAtSeq)}.`,
          },
    );

    // Did the server tell the truth about its own log?
    setAgrees((chain.state === 'valid') === result.valid);
  }, [breakId, evidence]);

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <section className="space-y-4 rounded border p-4 bg-surface border-line" data-testid="verifier">
      <div>
        <h2 className="font-medium">Verify this break</h2>
        <p className="mt-1 text-xs text-muted">
          These checks ran in your browser, on your machine, from the values below. Nothing here
          asks you to take our word for it.
        </p>
      </div>

      <ul className="space-y-3">
        <Verdict label="Randomisation" outcome={shuffle} />
        <Verdict label="Pull log" outcome={chainResult} />
      </ul>

      <button
        type="button"
        onClick={() => void refetch()}
        disabled={refetching}
        data-testid="verifier-refetch"
        className="rounded border px-3 py-1.5 text-xs disabled:opacity-50 border-line"
      >
        {refetching ? 'Fetching…' : 'Fetch the evidence again and re-check'}
      </button>

      {!agrees && (
        <p
          role="alert"
          className="rounded border px-3 py-2 text-sm border-danger text-danger"
          data-testid="verifier-disagrees"
        >
          Your browser and our server disagree about this log. Trust your browser.
        </p>
      )}

      {evidence.commitment && (
        <dl className="space-y-2 text-xs" data-testid="verifier-evidence">
          <div>
            <dt className="text-muted">Commitment, published before the break</dt>
            <dd className="break-all font-mono">{evidence.commitment.commitment}</dd>
          </div>
          <div>
            <dt className="text-muted">Audience seed</dt>
            <dd className="break-all font-mono">
              {evidence.commitment.clientSeed ?? 'not yet chosen'}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Server seed, revealed after the break</dt>
            <dd className="break-all font-mono" data-testid="revealed-seed">
              {evidence.commitment.revealedSeed ?? 'not revealed yet'}
            </dd>
          </div>
          {order && (
            <div>
              <dt className="text-muted">Slot order</dt>
              <dd className="font-mono" data-testid="slot-order">
                {order.join(', ')}
              </dd>
            </div>
          )}
          <div>
            <dt className="text-muted">Algorithm</dt>
            <dd className="font-mono">{evidence.commitment.algorithmVersion}</dd>
          </div>
        </dl>
      )}

      {evidence.chain.head !== null && (
        <p className="text-xs text-muted">
          Chain head: <span className="break-all font-mono">{chain.head}</span>
        </p>
      )}

      <p className="text-xs text-muted">
        The method is written up at{' '}
        <a href="/methodology" className="underline">
          /methodology
        </a>
        , and the code that runs these checks is the same code the server uses — it is open, in{' '}
        <span className="font-mono">packages/core/src/fairness.ts</span>.
      </p>
    </section>
  );
}
