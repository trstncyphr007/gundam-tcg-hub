import Link from 'next/link';
import { type HeldObservation, type PendingReport, api } from '@/lib/api';
import { DecisionCard } from './decision-card';

export const metadata = {
  title: 'Moderation · Gundam TCG Hub',
  robots: { index: false, follow: false },
};

function money(cents: number, currency: string): string {
  return `${currency === 'USD' ? '$' : `${currency} `}${(cents / 100).toFixed(2)}`;
}

/** "12× the median" is the fact a reviewer actually needs; two raw prices make them do maths. */
function against(priceCents: number, medianCents: number | null): string {
  if (medianCents === null || medianCents === 0) return 'no recent published price to compare';
  const ratio = priceCents / medianCents;
  return ratio >= 1
    ? `${ratio.toFixed(ratio >= 10 ? 0 : 1)}× the published median`
    : `${(1 / ratio).toFixed(1)}× below the published median`;
}

function Evidence({ href }: { href: string | null }): React.JSX.Element {
  if (href === null) {
    return <span style={{ color: 'var(--muted)' }}>no evidence link</span>;
  }
  // `nofollow noopener`: a link a member of the public supplied, opened by an admin whose
  // session can change published prices. It gets no window handle back to this tab.
  return (
    <a href={href} target="_blank" rel="nofollow noopener noreferrer" className="underline">
      evidence
    </a>
  );
}

function ReportBody({ report }: { report: PendingReport }): React.JSX.Element {
  return (
    <div className="space-y-1 text-sm">
      <p className="font-medium">
        {report.cardName ?? 'Unknown card'} · {report.condition.toUpperCase()} ·{' '}
        {money(report.priceCents, report.currency)}{' '}
        <span style={{ color: 'var(--muted)' }}>({report.saleType})</span>
      </p>
      <p style={{ color: 'var(--muted)' }}>
        {against(report.priceCents, report.medianCents)} · <Evidence href={report.evidenceRef} />
        {report.reporterPending > 1 && <> · this reporter has {report.reporterPending} waiting</>}
      </p>
    </div>
  );
}

function HeldBody({ held }: { held: HeldObservation }): React.JSX.Element {
  return (
    <div className="space-y-1 text-sm">
      <p className="font-medium">
        {held.cardName ?? 'Unknown card'} · {held.condition.toUpperCase()} ·{' '}
        {money(held.priceCents, held.currency)}{' '}
        <span style={{ color: 'var(--muted)' }}>({held.source.replace('_', ' ')})</span>
      </p>
      <p style={{ color: 'var(--muted)' }}>
        {against(held.priceCents, held.medianCents)} · <Evidence href={held.evidenceRef} />
      </p>
    </div>
  );
}

/**
 * The moderation console (SR-3.5, SR-4.4).
 *
 * Server-rendered, and the server asks the API rather than deciding for itself whether this
 * visitor may be here: the API's answer (signed out, not an admin, sign in again, or the
 * queue) is the only one that counts, and a page that guessed would eventually guess wrong.
 */
export default async function ModerationPage(): Promise<React.JSX.Element> {
  const result = await api.adminQueue();

  if (result.kind === 'signed_out') {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Moderation</h1>
        <Link href="/sign-in?next=%2Fadmin%2Fmoderation" className="underline">
          Sign in
        </Link>
      </div>
    );
  }

  if (result.kind === 'step_up') {
    return (
      <div className="max-w-prose space-y-4" data-testid="step-up-required">
        <h1 className="text-2xl font-semibold tracking-tight">Moderation</h1>
        <p className="text-sm">
          You are signed in, but not recently enough for this page. Decisions here change what the
          price index publishes, so they need a sign-in from within the last twelve hours.
        </p>
        <Link
          href="/sign-in?reason=step-up&next=%2Fadmin%2Fmoderation"
          className="inline-block rounded px-4 py-2 text-sm font-medium"
          style={{ background: 'var(--accent)' }}
          data-testid="step-up-link"
        >
          Sign in again
        </Link>
      </div>
    );
  }

  if (result.kind === 'forbidden') {
    // The same page whether or not an admin console exists at this path, as far as the
    // wording goes: it does not describe what an admin would see.
    return (
      <div className="space-y-4" data-testid="admin-forbidden">
        <h1 className="text-2xl font-semibold tracking-tight">Moderation</h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          This page is for administrators.
        </p>
      </div>
    );
  }

  if (result.kind === 'unavailable') {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Moderation</h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          The queue could not be loaded. Nothing has been decided.
        </p>
      </div>
    );
  }

  const { reports, flagged } = result;

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Moderation</h1>
        <p className="mt-1 max-w-prose text-sm" style={{ color: 'var(--muted)' }}>
          Every decision needs a reason and is recorded with your name against it. Nothing here
          deletes anything: a rejected price stays on record, it just never counts.
        </p>
      </header>

      <section className="space-y-3" data-testid="held-section">
        <div>
          <h2 className="text-lg font-medium">Held sales ({flagged.length})</h2>
          <p className="mt-1 max-w-prose text-sm" style={{ color: 'var(--muted)' }}>
            Our own sources, recorded and approved, then held because the price sat far outside the
            published spread. Clearing one lets it count; rejecting one means it never will. The VOD
            link is usually the quickest way to tell a typo from a real sale.
          </p>
        </div>
        {flagged.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Nothing held.
          </p>
        ) : (
          <ul className="space-y-3">
            {flagged.map((held) => (
              <DecisionCard key={held.id} kind="flags" id={held.id}>
                <HeldBody held={held} />
              </DecisionCard>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3" data-testid="reports-section">
        <div>
          <h2 className="text-lg font-medium">Reported prices ({reports.length})</h2>
          <p className="mt-1 max-w-prose text-sm" style={{ color: 'var(--muted)' }}>
            Prices members of the public told us about. They count for nothing until approved. Who
            sent each one is deliberately not shown: judge the price and its evidence.
          </p>
        </div>
        {reports.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            No reports waiting.
          </p>
        ) : (
          <ul className="space-y-3">
            {reports.map((report) => (
              <DecisionCard key={report.id} kind="reports" id={report.id}>
                <ReportBody report={report} />
              </DecisionCard>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
