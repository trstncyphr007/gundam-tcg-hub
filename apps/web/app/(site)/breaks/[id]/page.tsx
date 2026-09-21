import { formatVodOffset } from '@gth/core/vod';
import { notFound } from 'next/navigation';
import { api } from '@/lib/api';
import { BreakVerifier } from './verifier';

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<{ title: string }> {
  const { id } = await params;
  const view = await api.publicBreak(id);
  // React escapes this on render; the title is data, never markup.
  return { title: view ? `${view.title} · Gundam TCG Hub` : 'Break · Gundam TCG Hub' };
}

export default async function PublicBreakPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const view = await api.publicBreak(id);
  // A draft is not merely hidden in the UI: the API does not return it at all.
  if (!view) notFound();

  const profit = view.costCents === null ? null : view.totalCents - view.costCents;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{view.title}</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
          {view.productName ?? 'Sealed product'} ·{' '}
          {view.status === 'live' ? 'Live now' : 'Finished'}
        </p>
      </header>

      <div className="flex flex-wrap gap-6 text-sm">
        <p>
          <span style={{ color: 'var(--muted)' }}>Pulls</span> <strong>{view.pulls.length}</strong>
        </p>
        <p>
          <span style={{ color: 'var(--muted)' }}>Total value</span>{' '}
          <strong data-testid="public-total">{dollars(view.totalCents)}</strong>
        </p>
        {view.costCents !== null && (
          <p>
            <span style={{ color: 'var(--muted)' }}>Cost</span>{' '}
            <strong>{dollars(view.costCents)}</strong>
          </p>
        )}
        {profit !== null && (
          <p>
            <span style={{ color: 'var(--muted)' }}>Result</span>{' '}
            <strong style={{ color: profit >= 0 ? 'var(--accent)' : undefined }}>
              {profit >= 0 ? '+' : ''}
              {dollars(profit)}
            </strong>
          </p>
        )}
      </div>

      {view.pulls.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Nothing pulled yet.
        </p>
      ) : (
        <ol className="space-y-2" data-testid="public-pulls">
          {view.pulls.map((pull) => (
            <li
              key={pull.seq}
              className="flex items-center gap-3 rounded border px-3 py-2 text-sm"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
            >
              <span style={{ color: 'var(--muted)' }}>#{pull.seq}</span>
              <span className="min-w-0 flex-1">{pull.label}</span>
              {/* Straight to the moment (FR-4.4). `noopener` because it leaves our origin,
                  and `nofollow` because a creator's VOD link is not an endorsement. */}
              {pull.vodUrl !== null && (
                <a
                  href={pull.vodUrl}
                  target="_blank"
                  rel="nofollow noopener external"
                  data-testid="pull-vod-link"
                  className="underline"
                  style={{ color: 'var(--muted)' }}
                  title="Watch this pull"
                >
                  {pull.vodOffsetSeconds === null
                    ? 'watch'
                    : formatVodOffset(pull.vodOffsetSeconds)}
                </a>
              )}
              <span>{dollars(pull.valueCentsAtPull)}</span>
            </li>
          ))}
        </ol>
      )}

      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        Values are what the creator recorded at the moment of the pull.
        {view.pulls.some((p) => p.vodUrl !== null) && (
          <>
            {' '}
            Timestamps point into the creator&rsquo;s VOD and are <strong>not</strong> covered by
            the hashes below — the log is proven, a timestamp is the creator telling you where to
            look.
          </>
        )}
      </p>

      <BreakVerifier
        breakId={view.id}
        commitment={view.verification.commitment}
        chain={view.verification.chain}
        rows={view.verification.rows}
      />
    </div>
  );
}
