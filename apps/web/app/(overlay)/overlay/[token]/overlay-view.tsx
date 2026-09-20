'use client';

import { useEffect, useState } from 'react';

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

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
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
    return (
      <div style={{ fontFamily: 'system-ui, sans-serif', color: '#fff', padding: '1rem' }}>
        Overlay URL was regenerated.
      </div>
    );
  }

  if (!state) return <div />;

  const last = state.pulls.at(-1);
  const top = [...state.pulls].sort((a, b) => b.valueCentsAtPull - a.valueCentsAtPull).slice(0, 3);
  const profit = state.costCents === null ? null : state.totalCents - state.costCents;

  return (
    <div
      style={{
        fontFamily: 'system-ui, sans-serif',
        color: '#fff',
        // Heavy shadow so the text stays readable over any stream footage.
        textShadow: '0 2px 6px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,1)',
        padding: '1.25rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.9rem',
        maxWidth: '26rem',
      }}
    >
      <div style={{ fontSize: '1.1rem', fontWeight: 600 }} data-testid="overlay-title">
        {state.title}
      </div>

      <div style={{ display: 'flex', gap: '1.25rem', alignItems: 'baseline' }}>
        <div>
          <div style={{ fontSize: '0.7rem', opacity: 0.8 }}>TOTAL</div>
          <div style={{ fontSize: '2rem', fontWeight: 700 }} data-testid="overlay-total">
            {dollars(state.totalCents)}
          </div>
        </div>
        {profit !== null && (
          <div>
            <div style={{ fontSize: '0.7rem', opacity: 0.8 }}>VS COST</div>
            <div
              style={{
                fontSize: '1.3rem',
                fontWeight: 700,
                color: profit >= 0 ? '#4ade80' : '#f87171',
              }}
            >
              {profit >= 0 ? '+' : ''}
              {dollars(profit)}
            </div>
          </div>
        )}
      </div>

      {last && (
        <div>
          <div style={{ fontSize: '0.7rem', opacity: 0.8 }}>LAST PULL</div>
          <div style={{ fontSize: '1.15rem', fontWeight: 600 }} data-testid="overlay-last">
            {last.label} <span style={{ opacity: 0.85 }}>{dollars(last.valueCentsAtPull)}</span>
          </div>
        </div>
      )}

      {top.length > 0 && (
        <div>
          <div style={{ fontSize: '0.7rem', opacity: 0.8 }}>TOP HITS</div>
          <ol style={{ margin: 0, padding: 0, listStyle: 'none' }} data-testid="overlay-top">
            {top.map((pull) => (
              <li key={pull.seq} style={{ display: 'flex', gap: '0.5rem', fontSize: '0.95rem' }}>
                <span style={{ minWidth: 0, flex: 1 }}>{pull.label}</span>
                <span style={{ fontWeight: 600 }}>{dollars(pull.valueCentsAtPull)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div style={{ fontSize: '0.75rem', opacity: 0.75 }}>{state.pulls.length} pulled</div>
    </div>
  );
}
