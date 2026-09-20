import Link from 'next/link';
import { api } from '@/lib/api';
import { NewBreakForm } from './new-break-form';

export const metadata = { title: 'My breaks · Gundam TCG Hub' };

const STATUS_LABEL = { draft: 'Draft', live: 'Live', ended: 'Ended' } as const;

export default async function BreaksPage() {
  const me = await api.me();

  if (!me) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">My breaks</h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          You need to sign in to run a break.
        </p>
        <Link
          href="/sign-in"
          className="inline-block rounded px-4 py-2 text-sm font-medium"
          style={{ background: 'var(--accent)' }}
        >
          Sign in
        </Link>
      </div>
    );
  }

  if (me.role !== 'creator' && me.role !== 'admin') {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">My breaks</h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Running breaks needs the creator role. Ask an admin to grant it — role changes are
          deliberate and recorded.
        </p>
      </div>
    );
  }

  const [breaks, products] = await Promise.all([api.breaks(), api.products()]);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">My breaks</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
          Log pulls as you open, and put the overlay on stream.
        </p>
      </header>

      <NewBreakForm products={products?.items ?? []} />

      {!breaks || breaks.items.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          No breaks yet.
        </p>
      ) : (
        <ul className="space-y-3">
          {breaks.items.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center gap-4 rounded border p-4"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
            >
              <div className="min-w-0">
                <Link href={`/creator/breaks/${entry.id}`} className="font-medium underline">
                  {entry.title}
                </Link>
                <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                  {STATUS_LABEL[entry.status]}
                  {entry.costCents === null ? '' : ` · cost $${(entry.costCents / 100).toFixed(2)}`}
                </p>
              </div>
              {entry.status !== 'draft' && (
                <Link href={`/breaks/${entry.id}`} className="ml-auto text-sm underline">
                  Public page
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
