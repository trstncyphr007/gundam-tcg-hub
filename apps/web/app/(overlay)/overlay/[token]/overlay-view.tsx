'use client';

import { useEffect, useState } from 'react';
import { dollars } from '@/lib/money';

interface Pull {
  seq: number;
  label: string;
  valueCentsAtPull: number;
}

interface OverlayState {
  title: string;
  costCents: number | null;
  pulls: Pull[];
  totalCents: number;
}

/**
 * Transparent-background overlay for an OBS browser source.
 *
 * Stream-safe (FR-2.4): the only things rendered are the break title, card labels and
 * values the creator typed for display. No user name, no email, no ids — the API does not
 * even send them.
 */
export function OverlayView({ token }: { token: string }): React.JSX.Element {
  const [state, setState] = useState<OverlayState | null>(null);
  const [dead, setDead] = useState(false);

  useEffect(() => {
    const source = new EventSource(`/v1/overlay/${encodeURIComponent(token)}/stream`);

    source.addEventListener('state', (event) => {
      setState(JSON.parse((event as MessageEvent<string>).data) as OverlayState);
    });
    // The creator regenerated the URL: stop showing data immediately rather than
    // keep a revoked credential on screen.
    source.addEventListener('revoked', () => {
      setDead(true);
      source.close();
    });
    source.addEventListener('closing', () => {
      source.close();
    });

    return () => {
      source.close();
    };
  }, [token]);

  if (dead) {
    return <div className="font-sans text-white p-4">Overlay URL was regenerated.</div>;
  }

  if (!state) return <div />;

  const last = state.pulls.at(-1);
  const top = [...state.pulls].sort((a, b) => b.valueCentsAtPull - a.valueCentsAtPull).slice(0, 3);
  const profit = state.costCents === null ? null : state.totalCents - state.costCents;

  return (
    <div
      className="overlay-text flex max-w-[26rem] flex-col gap-[0.9rem] p-5 font-sans text-white"
      data-testid="overlay-root"
    >
      <div className="text-[1.1rem] font-semibold" data-testid="overlay-title">
        {state.title}
      </div>

      <div className="flex gap-5 items-baseline">
        <div>
          <div className="text-[0.7rem] opacity-80">TOTAL</div>
          <div className="text-[2rem] font-bold" data-testid="overlay-total">
            {dollars(state.totalCents)}
          </div>
        </div>
        {profit !== null && (
          <div>
            <div className="text-[0.7rem] opacity-80">VS COST</div>
            <div
              className={`text-[1.3rem] font-bold ${profit >= 0 ? 'text-[#4ade80]' : 'text-[#f87171]'}`}
            >
              {profit >= 0 ? '+' : ''}
              {dollars(profit)}
            </div>
          </div>
        )}
      </div>

      {last && (
        <div>
          <div className="text-[0.7rem] opacity-80">LAST PULL</div>
          <div className="text-[1.15rem] font-semibold" data-testid="overlay-last">
            {last.label} <span className="opacity-85">{dollars(last.valueCentsAtPull)}</span>
          </div>
        </div>
      )}

      {top.length > 0 && (
        <div>
          <div className="text-[0.7rem] opacity-80">TOP HITS</div>
          <ol className="m-0 p-0 list-none" data-testid="overlay-top">
            {top.map((pull) => (
              <li key={pull.seq} className="flex gap-2 text-[0.95rem]">
                <span className="min-w-0 flex-1">{pull.label}</span>
                <span className="font-semibold">{dollars(pull.valueCentsAtPull)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="text-[0.75rem] opacity-75">{state.pulls.length} pulled</div>
    </div>
  );
}
