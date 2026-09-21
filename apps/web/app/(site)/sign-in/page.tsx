import { safeNextPath } from '@/lib/next-path';
import { SignInForm } from './sign-in-form';

export const metadata = { title: 'Sign in · Gundam TCG Hub' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reason?: string }>;
}) {
  const { next, reason } = await searchParams;
  // Validated here, on the server, before it goes anywhere near a redirect (SR-X.13).
  const after = safeNextPath(next);

  return (
    <div className="mx-auto max-w-md space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          No passwords. Use Discord, or we email you a one-time link.
        </p>
      </header>
      {reason === 'step-up' && (
        <p
          className="rounded border p-3 text-sm"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
          data-testid="step-up-notice"
        >
          That page needs a recent sign-in. You are still signed in — this just confirms it is you,
          now, before you change anything that affects published prices.
        </p>
      )}
      <SignInForm next={after} />
    </div>
  );
}
