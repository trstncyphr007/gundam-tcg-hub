import Link from 'next/link';
import type { AdminRefusal } from '@/lib/api';

/**
 * What an admin page shows when the API refuses — one component, so every admin page answers
 * the same refusal the same way (ADR-024, ADR-025).
 *
 * The page never decides for itself whether the visitor may be there: the API's answer is the
 * only one that counts, and this renders it.
 */
export function AdminGate({
  title,
  path,
  refusal,
}: {
  title: string;
  /** Where "sign in again" should bring the admin back to. */
  path: string;
  refusal: AdminRefusal;
}): React.JSX.Element {
  const next = encodeURIComponent(path);

  if (refusal.kind === 'signed_out') {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <Link href={`/sign-in?next=${next}`} className="underline">
          Sign in
        </Link>
      </div>
    );
  }

  if (refusal.kind === 'step_up' || refusal.kind === 'passkey_required') {
    // Both are fixed the same way — a fresh sign-in with a passkey — but the reason differs,
    // and the page says which: an admin signed in by email ten minutes ago is not "too old",
    // they are missing the second factor (ADR-025).
    return (
      <div
        className="max-w-prose space-y-4"
        data-testid="step-up-required"
        data-reason={refusal.kind}
      >
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm">
          {refusal.kind === 'passkey_required'
            ? 'This page needs a sign-in with your passkey. An emailed link or Discord is not enough for the admin pages.'
            : 'You are signed in, but not recently enough for this page. The admin pages need a passkey sign-in from within the last twelve hours.'}
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href={`/sign-in?reason=step-up&next=${next}`}
            className="inline-block rounded bg-accent px-4 py-2 text-sm font-medium"
            data-testid="step-up-link"
          >
            Sign in with your passkey
          </Link>
          <Link href="/account/security" className="text-sm underline" data-testid="enroll-link">
            No passkey yet? Add one
          </Link>
        </div>
      </div>
    );
  }

  if (refusal.kind === 'forbidden') {
    // It does not describe what an admin would see.
    return (
      <div className="space-y-4" data-testid="admin-forbidden">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted">This page is for administrators.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="admin-unavailable">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted">This page could not be loaded. Nothing has changed.</p>
    </div>
  );
}

/** Links between the admin pages, shown once an admin is in. */
export function AdminNav({ current }: { current: 'moderation' | 'operations' }): React.JSX.Element {
  const link = (href: string, label: string, key: typeof current) => (
    <Link
      href={href}
      aria-current={current === key ? 'page' : undefined}
      className={current === key ? 'font-medium' : 'text-muted underline'}
    >
      {label}
    </Link>
  );
  return (
    <nav className="flex gap-4 text-sm" aria-label="Admin" data-testid="admin-nav">
      {link('/admin/moderation', 'Moderation', 'moderation')}
      {link('/admin/operations', 'Operations', 'operations')}
    </nav>
  );
}
