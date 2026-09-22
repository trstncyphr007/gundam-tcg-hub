import Link from 'next/link';
import { api } from '@/lib/api';
import { DataManager } from './data-manager';

export const metadata = {
  title: 'Your data · Gundam TCG Hub',
  robots: { index: false, follow: false },
};

export default async function DataPage(): Promise<React.JSX.Element> {
  const me = await api.me();
  if (!me) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Your data</h1>
        <Link href="/sign-in?next=%2Faccount%2Fdata" className="underline">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Your data</h1>
        <p className="mt-1 text-sm text-muted">
          Take a copy of everything this account holds, or delete it.
        </p>
      </header>
      <DataManager email={me.email} />
    </div>
  );
}
