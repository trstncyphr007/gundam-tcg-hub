import Link from 'next/link';
import { api } from '@/lib/api';
import { SignOutButton } from './sign-out-button';

export const metadata = { title: 'My watches · Gundam TCG Hub' };

export default async function WatchesPage() {
  const me = await api.me();

  if (!me) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">My watches</h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          You need to sign in to see your watches.
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

  const watches = await api.watches();

  return (
    <div className="space-y-6">
      <header className="flex items-start gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My watches</h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
            Signed in as {me.displayName ?? me.email}
            {watches ? ` · ${String(watches.items.length)} of ${String(watches.limit)}` : ''}
          </p>
        </div>
        <div className="ml-auto">
          <SignOutButton />
        </div>
      </header>

      {!watches || watches.items.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          No watches yet. Pick something from{' '}
          <Link href="/products" className="underline">
            sealed products
          </Link>
          .
        </p>
      ) : (
        <ul className="space-y-3">
          {watches.items.map((watch) => (
            <li
              key={watch.id}
              className="rounded border p-4 text-sm"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
            >
              <p className="font-medium">
                {watch.sealedProductId ? 'Product watch' : 'Listing watch'}
              </p>
              <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                Alerts via {watch.channels.join(', ')}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
