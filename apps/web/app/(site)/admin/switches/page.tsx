import { api } from '@/lib/api';
import { AdminGate, AdminNav } from '../admin-gate';
import { SwitchCard } from './switch-card';

export const metadata = {
  title: 'Switches · Gundam TCG Hub',
  robots: { index: false, follow: false },
};

/** What each switch is for, in the words of someone who has to use it under pressure. */
const DESCRIPTIONS = new Map([
  [
    'alerts.enabled',
    {
      label: 'Restock alerts',
      effect:
        'Stops alerts being sent. Restocks are still recorded, so nothing is lost — only the sending stops.',
    },
  ],
  [
    'api.public.enabled',
    {
      label: 'Public API',
      effect:
        'The public catalog and price endpoints answer 503. Sign-in, this console and the health check stay up.',
    },
  ],
  [
    'scanner.ingest.enabled',
    {
      label: 'Scanner ingestion',
      effect:
        'Refuses new stock reports with a 503, without revoking anybody’s key. To stop one shop only, disable that retailer instead.',
    },
  ],
]);

/**
 * The kill switches the incident runbook promises (plan §22, ADR-039).
 *
 * Its own page rather than a corner of the operations dashboard: the one time it is needed,
 * it should be somewhere obvious and nowhere near anything else that can be clicked.
 */
export default async function SwitchesPage(): Promise<React.JSX.Element> {
  const result = await api.adminFlags();
  if (result.kind !== 'ok') {
    return <AdminGate title="Switches" path="/admin/switches" refusal={result} />;
  }

  const off = result.flags.filter((flag) => !flag.enabled);

  return (
    <div className="space-y-6" data-testid="switches">
      <header className="space-y-2">
        <AdminNav current="switches" />
        <h1 className="text-2xl font-semibold tracking-tight">Switches</h1>
        <p className="max-w-prose text-sm text-muted">
          Containment before investigation. Stop the bleeding here, then work out what happened with
          the clock stopped. Every change needs a reason and is written to the audit log, and a
          switch takes at most ten seconds to take effect everywhere.
        </p>
      </header>

      {off.length > 0 && (
        <p
          className="rounded border px-4 py-3 text-sm border-line text-danger"
          data-testid="switches-off"
        >
          {off.length === 1 ? 'One thing is' : `${String(off.length)} things are`} switched off
          right now. Nothing turns itself back on.
        </p>
      )}

      <ul className="space-y-4">
        {result.flags.map((flag) => {
          const described = DESCRIPTIONS.get(flag.key);
          return (
            <SwitchCard
              key={flag.key}
              flagKey={flag.key}
              label={described?.label ?? flag.key}
              effect={described?.effect ?? ''}
              enabled={flag.enabled}
              reason={flag.reason}
              updatedAt={flag.updatedAt}
            />
          );
        })}
      </ul>
    </div>
  );
}
