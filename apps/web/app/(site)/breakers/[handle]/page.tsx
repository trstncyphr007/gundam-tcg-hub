import Link from 'next/link';
import { notFound } from 'next/navigation';
import { type BreakerProfile, type RarityComparison, api } from '@/lib/api';

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** "1 in 12" reads as odds; "0.083" reads as a spreadsheet. */
function asOneIn(rate: number | null): string {
  if (rate === null || rate <= 0) return '—';
  return `1 in ${(1 / rate).toFixed(rate > 0.05 ? 1 : 0)}`;
}

/**
 * What a verdict means, in words, on the row it belongs to.
 *
 * Deliberately not a colour and a number. A reader scanning a table of green and red ticks
 * takes away "this breaker is fine / this one is not", which is a conclusion none of these
 * samples can support. The sentence is the finding.
 */
const VERDICTS: Record<RarityComparison['verdict'], { label: string; note: string }> = {
  consistent: {
    label: 'As published',
    note: 'The published rate falls inside what this many packs can show.',
  },
  insufficient: {
    label: 'Too few packs',
    note: 'Not enough packs yet to tell this rate apart from luck. This is the usual answer.',
  },
  unpublished: {
    label: 'No published odds',
    note: 'We have no citable odds for this rarity, so there is nothing to compare against.',
  },
  not_comparable: {
    label: 'Not comparable',
    note: 'More hits than packs, so the one-per-pack model these odds assume does not apply.',
  },
  above: {
    label: 'Above published',
    note: 'Higher than published across this sample. A sample, not an explanation.',
  },
  below: {
    label: 'Below published',
    note: 'Lower than published across this sample. A sample, not an explanation.',
  },
};

function Badge({ fairness }: { fairness: BreakerProfile['fairness'] }): React.JSX.Element {
  const { badge } = fairness;
  const text =
    badge === 'verified'
      ? 'Verified randomisation'
      : badge === 'broken'
        ? 'Pull log does not verify'
        : 'Not verified';
  const colour =
    badge === 'verified'
      ? 'border-accent text-accent'
      : badge === 'broken'
        ? 'border-danger text-danger'
        : 'border-muted text-muted';

  return (
    <span
      data-testid="fairness-badge"
      data-badge={badge}
      className={`rounded border px-2 py-1 text-xs font-medium ${colour}`}
    >
      {text}
    </span>
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<{ title: string }> {
  const { handle } = await params;
  const profile = await api.breaker(handle);
  return {
    title: profile ? `${profile.displayName} · Gundam TCG Hub` : 'Breaker · Gundam TCG Hub',
  };
}

export default async function BreakerPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<React.JSX.Element> {
  const { handle } = await params;
  const profile = await api.breaker(handle);
  // An unpublished profile is not merely hidden here: the API does not return it.
  if (!profile) notFound();

  const { totals, fairness } = profile;

  return (
    <div className="space-y-8">
      <header>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{profile.displayName}</h1>
          <Badge fairness={fairness} />
        </div>
        <p className="mt-1 text-sm text-muted">@{profile.handle}</p>
        {profile.bio !== null && <p className="mt-3 max-w-prose text-sm">{profile.bio}</p>}
      </header>

      <section className="flex flex-wrap gap-6 text-sm" data-testid="breaker-totals">
        <p>
          <span className="text-muted">Breaks</span> <strong>{totals.breaks}</strong>
        </p>
        <p>
          <span className="text-muted">Pulls logged</span> <strong>{totals.pulls}</strong>
        </p>
        <p>
          <span className="text-muted">Packs opened</span> <strong>{totals.packsOpened}</strong>
        </p>
        <p>
          <span className="text-muted">Total pulled value</span>{' '}
          <strong>{dollars(totals.totalValueCents)}</strong>
        </p>
      </section>

      {/* What the badge actually rests on. A badge nobody can interrogate is a logo. */}
      <section
        className="space-y-2 rounded border p-4 text-sm bg-surface border-line"
        data-testid="fairness-detail"
      >
        <h2 className="font-medium">What that badge means</h2>
        {fairness.badge === 'broken' ? (
          <p>
            <strong>{fairness.chainsBroken}</strong> of this breaker&rsquo;s pull logs did not
            re-derive from their own hashes. That means a row was changed after it was written. Open
            the break and check it yourself — the page verifies in your browser.
          </p>
        ) : fairness.badge === 'verified' ? (
          <p>
            <strong>{fairness.revealed}</strong> break
            {fairness.revealed === 1 ? ' was' : 's were'} committed to before starting and revealed
            afterwards, and every pull log re-checked here re-derived from its own hashes.
          </p>
        ) : (
          <p>
            No break here has been through commit&ndash;reveal yet, so there is nothing to verify.
            That is not a criticism: it is a feature a creator has to turn on.
          </p>
        )}
        <p className="text-muted">
          {fairness.chainsChecked} of {fairness.endedBreaks} finished break
          {fairness.endedBreaks === 1 ? '' : 's'} had their pull log re-hashed for this page
          {fairness.chainsUnverifiable > 0 &&
            `, and ${String(fairness.chainsUnverifiable)} predate the hash chain and cannot be checked either way`}
          . Every break is checkable in full on its own page.
        </p>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-medium">Hit rates against published odds</h2>
          <p className="mt-1 max-w-prose text-sm text-muted">
            Compared per product, never pooled, because odds differ between sets. The interval
            widens for the number of rarities checked at once. Most rows will say{' '}
            <em>too few packs</em> for a long time — the packs needed to tell a real rate from luck
            run into the hundreds.
          </p>
        </div>

        {profile.oddsReports.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing to compare yet. A break counts here once it has finished and its pack count has
            been recorded
            {totals.breaksWithoutPackCount > 0 &&
              ` — ${String(totals.breaksWithoutPackCount)} finished break${
                totals.breaksWithoutPackCount === 1 ? ' has' : 's have'
              } no pack count`}
            .
          </p>
        ) : (
          profile.oddsReports.map((report) => (
            <div
              key={report.sealedProductId}
              className="space-y-3 rounded border p-4 bg-surface border-line"
              data-testid="odds-report"
            >
              <div>
                <h3 className="font-medium">{report.productName}</h3>
                <p className="mt-1 text-xs text-muted">
                  {report.packs} packs across {report.breaks} break
                  {report.breaks === 1 ? '' : 's'}
                  {report.unidentifiedPulls > 0 &&
                    ` · ${String(report.unidentifiedPulls)} pull${
                      report.unidentifiedPulls === 1 ? '' : 's'
                    } named no catalogued card, so they are not counted by rarity`}
                </p>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted">
                      <th className="py-1 text-left font-normal">Rarity</th>
                      <th className="py-1 text-right font-normal">Hits</th>
                      <th className="py-1 text-right font-normal">Observed</th>
                      <th className="py-1 text-right font-normal">Published</th>
                      <th className="py-1 text-left font-normal">Reading</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rarities.map((row) => (
                      <tr
                        key={row.rarity}
                        className="border-t border-line"
                        data-testid="rarity-row"
                        data-verdict={row.verdict}
                      >
                        <td className="py-2">{row.rarity}</td>
                        <td className="py-2 text-right">{row.hits}</td>
                        <td className="py-2 text-right">{asOneIn(row.observedRate)}</td>
                        <td className="py-2 text-right">
                          {row.published === null
                            ? '—'
                            : `${String(row.published.numerator)} in ${String(row.published.denominator)}`}
                        </td>
                        <td className="py-2">
                          <span className="font-medium">{VERDICTS[row.verdict].label}</span>
                          <span className="block text-xs text-muted">
                            {VERDICTS[row.verdict].note}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {report.sources.length > 0 && (
                <p className="text-xs text-muted">
                  Published odds from{' '}
                  {/* A citation, not a claim. Anyone arguing with the table can check it. */}
                  {[...new Set(report.sources.map((s) => s.sourceUrl))].map((url, index) => (
                    <span key={url}>
                      {index > 0 && ', '}
                      <a href={url} rel="nofollow noopener external" className="underline">
                        {new URL(url).hostname}
                      </a>
                    </span>
                  ))}
                  .
                </p>
              )}
            </div>
          ))
        )}
      </section>

      {profile.recentBreaks.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">Recent breaks</h2>
          <ul className="space-y-2" data-testid="recent-breaks">
            {profile.recentBreaks.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-baseline gap-3 rounded border px-3 py-2 text-sm bg-surface border-line"
              >
                <Link href={`/breaks/${entry.id}`} className="font-medium underline">
                  {entry.title}
                </Link>
                <span className="text-muted">
                  {entry.productName ?? 'Sealed product'} · {entry.pulls} pull
                  {entry.pulls === 1 ? '' : 's'}
                  {entry.packsOpened !== null && ` · ${String(entry.packsOpened)} packs`}
                </span>
                <span className="ml-auto">{dollars(entry.totalCents)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-xs text-muted">
        Values are what the creator recorded at the moment of each pull. How the index behind them
        is built is written up at{' '}
        <Link href="/methodology" className="underline">
          /methodology
        </Link>
        .
      </p>
    </div>
  );
}
