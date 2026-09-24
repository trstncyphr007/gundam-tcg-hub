import { SignInRequired } from '@/components/sign-in-required';
import { api } from '@/lib/api';
import { ProfileForm } from './profile-form';

export const metadata = { title: 'Your breaker page · Gundam TCG Hub' };

export default async function CreatorProfilePage(): Promise<React.JSX.Element> {
  const me = await api.me();
  if (!me) {
    return (
      <SignInRequired
        title="Your breaker page"
        reason="set up your breaker page"
        next="/creator/profile"
      />
    );
  }

  const result = await api.myProfile();
  // `null` from the API means "no session or not a creator"; the route itself returns
  // `{ profile: null }` for a creator who simply has not made one yet.
  if (!result) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Your breaker page</h1>
        <p className="max-w-prose text-sm text-muted">
          Breaker pages are for creator accounts. Running breaks is a role an admin grants.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Your breaker page</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">
          A public page showing your break counts, pull logs and hit rates by rarity against
          published pack odds. It is off until you publish it, and it names only what you type here.
        </p>
      </header>

      <ProfileForm initial={result.profile} />

      <section className="max-w-prose space-y-2 text-sm text-muted">
        <h2 className="font-medium text-fg">Two things worth knowing</h2>
        <p>
          Hit rates only appear for breaks that have <strong>finished</strong> and recorded a{' '}
          <strong>pack count</strong>. Published odds are stated per pack, so a break without one
          has no denominator and is left out rather than guessed at.
        </p>
        <p>
          The verified-randomisation badge is earned per break, through commit&ndash;reveal, and it
          can be lost: if any pull log stops matching its own hashes, the page says so.
        </p>
      </section>
    </div>
  );
}
