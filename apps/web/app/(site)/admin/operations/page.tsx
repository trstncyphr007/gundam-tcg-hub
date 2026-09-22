import { type OperationsSummary, type SecuritySummary, api } from '@/lib/api';
import { AdminGate, AdminNav } from '../admin-gate';

export const metadata = {
  title: 'Operations · Gundam TCG Hub',
  robots: { index: false, follow: false },
};

/** "4 min", "3 h", "2 d": how an operator reads an age at a glance. */
function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${String(s)} s`;
  if (s < 90 * 60) return `${String(Math.round(s / 60))} min`;
  if (s < 36 * 3600) return `${String(Math.round(s / 3600))} h`;
  return `${String(Math.round(s / 86400))} d`;
}

function ago(iso: string | null, now: Date): string {
  if (iso === null) return 'never';
  return `${duration((now.getTime() - new Date(iso).getTime()) / 1000)} ago`;
}

/** A backlog older than this means deliveries have stopped moving, not merely queued. */
const STUCK_BACKLOG_S = 15 * 60;

function Scanner({ data, now }: { data: OperationsSummary; now: Date }): React.JSX.Element {
  return (
    <section className="space-y-3" data-testid="scanner-section">
      <div>
        <h2 className="text-lg font-medium">Scanner</h2>
        <p className="mt-1 max-w-prose text-sm text-muted">
          A listing is stale when no stock report has arrived within twice its retailer&rsquo;s
          interval — one jitter late is normal, a whole interval late is not. The scanner runs
          separately, so this is what it has actually reported, whatever it believes itself.
        </p>
      </div>
      {data.retailers.length === 0 ? (
        <p className="text-sm text-muted">No retailers yet.</p>
      ) : (
        <table className="w-full text-sm" data-testid="retailer-table">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1 font-normal">Retailer</th>
              <th className="py-1 font-normal">Listings</th>
              <th className="py-1 font-normal">Healthy</th>
              <th className="py-1 font-normal">Stale</th>
              <th className="py-1 font-normal">Never checked</th>
              <th className="py-1 font-normal">Last report</th>
            </tr>
          </thead>
          <tbody>
            {data.retailers.map((r) => {
              const status = !r.enabled
                ? 'paused'
                : r.stale > 0 || r.neverChecked > 0
                  ? 'attention'
                  : 'healthy';
              return (
                <tr
                  key={r.id}
                  className="border-t border-line"
                  data-testid="retailer-row"
                  data-status={status}
                >
                  <td className="py-1.5">
                    <span className="font-medium">{r.name}</span>{' '}
                    <span className="text-muted">
                      {r.domain} · every {duration(r.minIntervalS)}
                    </span>{' '}
                    {status === 'paused' && <span className="text-muted">(paused)</span>}
                  </td>
                  <td>{r.listings}</td>
                  <td>{r.healthy}</td>
                  <td className={r.enabled && r.stale > 0 ? 'text-warning' : undefined}>
                    {r.stale}
                  </td>
                  <td className={r.enabled && r.neverChecked > 0 ? 'text-warning' : undefined}>
                    {r.neverChecked}
                  </td>
                  <td className="text-muted">{ago(r.lastCheckedAt, now)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="space-y-2" data-testid="stale-listings">
        <h3 className="font-medium">Needs attention ({data.staleListings.length})</h3>
        {data.staleListings.length === 0 ? (
          <p className="text-sm text-muted">
            Every listing at an active retailer is being checked.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {data.staleListings.map((l) => (
              <li
                key={`${l.retailer}-${l.product}-${l.lastCheckedAt ?? 'never'}`}
                data-testid="stale-listing"
              >
                <span className="font-medium">{l.product}</span>{' '}
                <span className="text-muted">at {l.retailer} ·</span>{' '}
                {l.lastCheckedAt === null ? (
                  <span className="text-warning">never checked</span>
                ) : (
                  <>
                    last report {ago(l.lastCheckedAt, now)}
                    {l.overdueSeconds !== null && l.overdueSeconds > 0 && (
                      <span className="text-warning"> · {duration(l.overdueSeconds)} overdue</span>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Restocks({ data, now }: { data: OperationsSummary; now: Date }): React.JSX.Element {
  const { restocks } = data;
  return (
    <section className="space-y-3" data-testid="restocks-section">
      <h2 className="text-lg font-medium">Restocks</h2>
      <p className="text-sm">
        <span className="font-medium" data-testid="restocks-24h">
          {restocks.last24h}
        </span>{' '}
        in the last 24 hours ·{' '}
        <span className="font-medium" data-testid="restocks-7d">
          {restocks.last7d}
        </span>{' '}
        in the last 7 days
      </p>
      {restocks.recent.length > 0 && (
        <ul className="space-y-1 text-sm">
          {restocks.recent.map((e) => (
            <li key={`${e.product}-${e.retailer}-${e.detectedAt}`}>
              {e.product}{' '}
              <span className="text-muted">
                at {e.retailer} · {ago(e.detectedAt, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Deliveries({ data, now }: { data: OperationsSummary; now: Date }): React.JSX.Element {
  const { deliveries } = data;
  const backlogAge =
    deliveries.oldestPendingAt === null
      ? 0
      : (now.getTime() - new Date(deliveries.oldestPendingAt).getTime()) / 1000;
  const stuck = deliveries.pending > 0 && backlogAge > STUCK_BACKLOG_S;

  return (
    <section className="space-y-3" data-testid="deliveries-section">
      <h2 className="text-lg font-medium">Alert delivery</h2>
      <p className="text-sm" data-testid="backlog" data-stuck={stuck ? 'true' : 'false'}>
        Backlog: <span className="font-medium">{deliveries.pending}</span> waiting
        {deliveries.pending > 0 && (
          <span className={stuck ? 'text-warning' : 'text-muted'}>
            {' '}
            · oldest {ago(deliveries.oldestPendingAt, now)}
            {stuck && ' — deliveries have stopped moving'}
          </span>
        )}
      </p>

      <div>
        <h3 className="font-medium">Last 24 hours</h3>
        {deliveries.byChannel.length === 0 ? (
          <p className="text-sm text-muted">Nothing sent.</p>
        ) : (
          <ul className="text-sm" data-testid="deliveries-by-channel">
            {deliveries.byChannel.map((d) => (
              <li key={`${d.channel}-${d.status}`}>
                {d.channel.replace('_', ' ')} ·{' '}
                <span className={d.status === 'failed' ? 'text-danger' : undefined}>
                  {d.status}
                </span>{' '}
                · {d.count}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="font-medium">Why deliveries failed (7 days)</h3>
        {deliveries.failures.length === 0 ? (
          <p className="text-sm text-muted">No failures.</p>
        ) : (
          <ul className="space-y-1 text-sm" data-testid="delivery-failures">
            {deliveries.failures.map((f) => (
              <li key={f.reason}>
                <code>{f.reason}</code>{' '}
                <span className="text-muted">
                  × {f.count} · last {ago(f.lastAt, now)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** How an action reads to someone who did not write the constant. */
const ACTION_LABELS = new Map([
  ['auth.sign_in_failed', 'Failed sign-ins'],
  ['auth.rate_limited', 'Auth rate limits hit'],
  ['api.rate_limited', 'API rate limits hit'],
]);

function Security({ data, now }: { data: SecuritySummary; now: Date }): React.JSX.Element {
  const quiet = data.counts.every((c) => c.last7d === 0);
  return (
    <section className="space-y-3" data-testid="security-section">
      <div>
        <h2 className="text-lg font-medium">Refused attempts</h2>
        <p className="mt-1 max-w-prose text-sm text-muted">
          One failed sign-in is a typo; two hundred is somebody working through a list. Sources are
          counted by that day&rsquo;s hash, so a run of attempts from one place is visible without
          anyone being followed from one day to the next — and no address that was tried is recorded
          anywhere.
        </p>
      </div>

      <table className="w-full max-w-lg text-sm" data-testid="security-counts">
        <thead className="text-left text-muted">
          <tr>
            <th className="py-1 font-normal">Event</th>
            <th className="py-1 font-normal">Last hour</th>
            <th className="py-1 font-normal">24 hours</th>
            <th className="py-1 font-normal">7 days</th>
          </tr>
        </thead>
        <tbody>
          {data.counts.map((c) => (
            <tr key={c.action} className="border-t border-line" data-testid="security-row">
              <td className="py-1.5">{ACTION_LABELS.get(c.action) ?? c.action}</td>
              <td className={c.lastHour > 0 ? 'py-1.5 font-medium text-warning' : 'py-1.5'}>
                {c.lastHour}
              </td>
              <td className="py-1.5">{c.last24h}</td>
              <td className="py-1.5">{c.last7d}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {quiet ? (
        <p className="text-sm text-muted">Nothing refused in the last week.</p>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <h3 className="font-medium">Busiest sources (24 h)</h3>
            {data.noisySources.length === 0 ? (
              <p className="text-sm text-muted">None recorded.</p>
            ) : (
              <ul className="space-y-1 text-sm" data-testid="noisy-sources">
                {data.noisySources.map((s) => (
                  <li key={s.source}>
                    <code>…{s.source}</code>{' '}
                    <span className="text-muted">
                      × {s.attempts} · last {ago(s.lastAt, now)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="font-medium">Where (24 h)</h3>
            <ul className="space-y-1 text-sm" data-testid="security-endpoints">
              {data.endpoints.map((e) => (
                <li key={e.endpoint}>
                  <code>{e.endpoint}</code> <span className="text-muted">× {e.attempts}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The operations dashboard (FR-1.12): is the scanner reporting, are restocks being found,
 * are alerts going out, and is anything being refused. Aggregates only — no user appears on it.
 *
 * Every age is measured from the summary's own `generatedAt`, so the page is consistent with
 * itself and states exactly when it was taken.
 */
export default async function OperationsPage(): Promise<React.JSX.Element> {
  const [result, security] = await Promise.all([api.adminOperations(), api.adminSecurity()]);
  if (result.kind !== 'ok') {
    return <AdminGate title="Operations" path="/admin/operations" refusal={result} />;
  }
  const now = new Date(result.generatedAt);

  return (
    <div className="space-y-10" data-testid="operations">
      <header className="space-y-2">
        <AdminNav current="operations" />
        <h1 className="text-2xl font-semibold tracking-tight">Operations</h1>
        <p className="text-sm text-muted">
          As of {now.toISOString().slice(0, 16).replace('T', ' ')} UTC. Reload for newer figures.
        </p>
      </header>
      <Scanner data={result} now={now} />
      <Restocks data={result} now={now} />
      <Deliveries data={result} now={now} />
      {/* The gate above already passed, so a refusal here is a fault, not a permission
          problem — say so rather than leaving a blank space that looks like "all quiet". */}
      {security.kind === 'ok' ? (
        <Security data={security} now={now} />
      ) : (
        <p className="text-sm text-danger" data-testid="security-unavailable">
          Refused attempts could not be read.
        </p>
      )}
    </div>
  );
}
