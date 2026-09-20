'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { signOut } from '@/lib/auth-client';

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void signOut().finally(() => {
          // The server revokes the session; refresh so the UI reflects it.
          router.refresh();
          router.push('/sign-in');
        });
      }}
      className="rounded border px-3 py-1.5 text-sm disabled:opacity-60"
      style={{ borderColor: 'var(--border)' }}
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
