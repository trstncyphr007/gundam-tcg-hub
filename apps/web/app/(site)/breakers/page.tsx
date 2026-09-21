import Link from 'next/link';
import { api } from '@/lib/api';

export const metadata = { title: 'Breakers · Gundam TCG Hub' };

export default async function BreakersPage(): Promise<React.JSX.Element> {
  const result = await api.breakers();
  const items = result?.items ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Breakers</h1>
        <p className="mt-1 max-w-prose text-sm" style={{ color: 'var(--muted)' }}>
          Creators who have published a profile. Each one shows break counts, pull logs and hit
          rates against published pack odds where they exist — and whether their breaks have been
          through commit&ndash;reveal.
        </p>
      </header>

      {items.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Nobody has published a profile yet.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="breaker-list">
          {items.map((breaker) => (
            <li
              key={breaker.handle}
              className="rounded border px-4 py-3"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
            >
              <Link href={`/breakers/${breaker.handle}`} className="font-medium underline">
                {breaker.displayName}
              </Link>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                @{breaker.handle}
              </p>
              {breaker.bio !== null && <p className="mt-2 text-sm">{breaker.bio}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
