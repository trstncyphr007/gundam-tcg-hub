import { SignInForm } from './sign-in-form';

export const metadata = { title: 'Sign in · Gundam TCG Hub' };

export default function SignInPage() {
  return (
    <div className="mx-auto max-w-md space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          No passwords. Use Discord, or we email you a one-time link.
        </p>
      </header>
      <SignInForm />
    </div>
  );
}
