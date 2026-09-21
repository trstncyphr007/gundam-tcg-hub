import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api } from '@/lib/api';
import { FairnessPanel } from './fairness-panel';
import { PackCount } from './pack-count';
import { PullLogger } from './pull-logger';
import { VodPanel } from './vod-panel';

export const metadata = { title: 'Run break · Gundam TCG Hub' };

export default async function RunBreakPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const me = await api.me();
  if (!me) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Run break</h1>
        <Link href="/sign-in" className="underline">
          Sign in
        </Link>
      </div>
    );
  }

  const breaks = await api.breaks();
  const entry = breaks?.items.find((b) => b.id === id);
  // Someone else's break is indistinguishable from one that does not exist.
  if (!entry) notFound();

  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{entry.title}</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
            {entry.status === 'draft'
              ? 'Not started yet'
              : entry.status === 'live'
                ? 'Live'
                : 'Ended'}
            {entry.costCents === null ? '' : ` · cost $${(entry.costCents / 100).toFixed(2)}`}
          </p>
        </div>
        {entry.status !== 'draft' && (
          <Link href={`/breaks/${entry.id}`} className="ml-auto text-sm underline">
            Public page
          </Link>
        )}
      </header>

      <PullLogger
        breakId={entry.id}
        initialStatus={entry.status}
        costCents={entry.costCents}
        tokenVersion={entry.overlayTokenVersion}
      />

      <PackCount breakId={entry.id} initial={entry.packsOpened} />

      {/* Timestamping happens after the stream, when the VOD exists — so the panel only
          appears once there is a finished log to walk down. */}
      {entry.status === 'ended' && (
        <VodPanel
          breakId={entry.id}
          initialVodUrl={entry.vodUrl}
          initialPulls={(await api.creatorPulls(entry.id))?.items ?? []}
        />
      )}

      <FairnessPanel
        breakId={entry.id}
        status={entry.status}
        initial={(await api.publicBreak(entry.id))?.verification.commitment ?? null}
      />
    </div>
  );
}
