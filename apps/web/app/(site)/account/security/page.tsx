import Link from 'next/link';
import { SignInRequired } from '@/components/sign-in-required';
import { api } from '@/lib/api';
import { PasskeyManager } from './passkey-manager';
import { SessionManager } from './session-manager';

export const metadata = {
  title: 'Security · Gundam TCG Hub',
  robots: { index: false, follow: false },
};

export default async function SecurityPage(): Promise<React.JSX.Element> {
  const me = await api.me();
  if (!me) {
    return (
      <SignInRequired title="Security" reason="manage how you sign in" next="/account/security" />
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Security</h1>
        <p className="mt-1 text-sm text-muted">
          How you sign in to this account, and where it is signed in.
        </p>
      </header>
      <PasskeyManager />
      <SessionManager />
      <p className="text-sm">
        <Link href="/account/data" className="underline" data-testid="data-link">
          Download or delete your data →
        </Link>
      </p>
    </div>
  );
}
