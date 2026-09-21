import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import '../globals.css';

/**
 * Every page renders per request. A statically prerendered page has its HTML baked at build
 * time, so it cannot carry the per-request CSP nonce: its scripts get blocked and the page
 * never hydrates. Pages here are either personalised or proxied anyway.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Gundam TCG Hub',
  description: 'Restock alerts, prices and collection tools for the Gundam Card Game.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b" style={{ borderColor: 'var(--border)' }}>
          <nav className="mx-auto flex max-w-5xl items-center gap-6 px-4 py-4">
            <Link href="/" className="font-semibold tracking-tight">
              Gundam TCG Hub
            </Link>
            <Link href="/products" className="text-sm" style={{ color: 'var(--muted)' }}>
              Products
            </Link>
            <Link href="/account/watches" className="text-sm" style={{ color: 'var(--muted)' }}>
              My watches
            </Link>
            <Link href="/account/collections" className="text-sm" style={{ color: 'var(--muted)' }}>
              My collections
            </Link>
            <Link href="/creator/breaks" className="text-sm" style={{ color: 'var(--muted)' }}>
              Breaks
            </Link>
            <Link href="/creator/live-sales" className="text-sm" style={{ color: 'var(--muted)' }}>
              Live sales
            </Link>
            <Link href="/breakers" className="text-sm" style={{ color: 'var(--muted)' }}>
              Breakers
            </Link>
            <Link href="/account/developer" className="text-sm" style={{ color: 'var(--muted)' }}>
              API
            </Link>
            <Link href="/sign-in" className="ml-auto text-sm" style={{ color: 'var(--muted)' }}>
              Sign in
            </Link>
          </nav>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
