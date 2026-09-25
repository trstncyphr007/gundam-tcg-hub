import type { Metadata } from 'next';
import Link from 'next/link';
import { PUBLIC_ROBOTS } from '@/lib/site';
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
  // One switch, in one file (lib/site.ts). The pages that must never be indexed set their own
  // `noindex` and are not affected by flipping it.
  robots: PUBLIC_ROBOTS,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b border-line">
          <nav className="mx-auto flex max-w-5xl items-center gap-6 px-4 py-4">
            <Link href="/" className="font-semibold tracking-tight">
              Gundam TCG Hub
            </Link>
            <Link href="/products" className="text-sm text-muted">
              Products
            </Link>
            <Link href="/account/watches" className="text-sm text-muted">
              My watches
            </Link>
            <Link href="/account/collections" className="text-sm text-muted">
              My collections
            </Link>
            <Link href="/account/selling" className="text-sm text-muted">
              Selling
            </Link>
            <Link href="/account/orders" className="text-sm text-muted">
              Orders
            </Link>
            <Link href="/creator/breaks" className="text-sm text-muted">
              Breaks
            </Link>
            <Link href="/creator/live-sales" className="text-sm text-muted">
              Live sales
            </Link>
            <Link href="/breakers" className="text-sm text-muted">
              Breakers
            </Link>
            <Link href="/account/developer" className="text-sm text-muted">
              API
            </Link>
            <Link href="/account/security" className="text-sm text-muted">
              Security
            </Link>
            <Link href="/sign-in" className="ml-auto text-sm text-muted">
              Sign in
            </Link>
          </nav>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
        <footer className="mt-8 border-t border-line">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-4 py-6 text-sm text-muted">
            <Link href="/methodology" className="underline">
              Methodology
            </Link>
            <Link href="/privacy" className="underline">
              Privacy
            </Link>
            <Link href="/terms" className="underline">
              Terms
            </Link>
            <Link href="/docs" className="underline">
              API docs
            </Link>
            <span className="ml-auto">Not affiliated with Bandai. Prices are community data.</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
