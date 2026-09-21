import Link from 'next/link';
import { api } from '@/lib/api';
import { PasskeyManager } from './passkey-manager';

export const metadata = {
  title: 'Security · Gundam TCG Hub',
  robots: { index: false, follow: false },
};

export default async function SecurityPage(): Promise<React.JSX.Element> {
  const me = await api.me();
  if (!me) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Security</h1>
        <Link href="/sign-in?next=%2Faccount%2Fsecurity" className="underline">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Security</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
          How you sign in to this account.
        </p>
      </header>
      <PasskeyManager />
    </div>
  );
}
