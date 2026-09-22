import Link from 'next/link';
import { api } from '@/lib/api';
import { KeyManager } from './key-manager';

export const metadata = { title: 'API keys · Gundam TCG Hub' };

export default async function DeveloperPage() {
  const me = await api.me();

  if (!me) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
        <p className="text-sm text-muted">You need to sign in to create an API key.</p>
        <Link
          href="/sign-in"
          className="inline-block rounded px-4 py-2 text-sm font-medium bg-accent"
        >
          Sign in
        </Link>
      </div>
    );
  }

  const keys = await api.developerKeys();

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
        <p className="mt-1 text-sm text-muted">
          The catalog and the price index are free to read, with or without a key. A key gets you
          your own allowance instead of one shared with everyone at your address — 60 requests a
          minute, 1,000 a day.
        </p>
        <p className="mt-2 text-sm text-muted">
          <a href="/docs" className="underline">
            Read the docs
          </a>{' '}
          ·{' '}
          <a href="/docs/openapi.json" className="underline">
            OpenAPI 3.1
          </a>{' '}
          ·{' '}
          <Link href="/methodology" className="underline">
            How prices are computed
          </Link>
        </p>
      </header>

      <KeyManager
        initialKeys={keys?.items ?? []}
        limit={keys?.limit ?? 10}
        scopes={keys?.scopes ?? ['catalog:read', 'prices:read']}
      />
    </div>
  );
}
