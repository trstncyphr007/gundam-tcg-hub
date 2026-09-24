import Link from 'next/link';

/**
 * What a page behind a sign-in shows to somebody who is not signed in (SR-X.6).
 *
 * There were three shapes of this, written independently: a bare sentence on four pages, an
 * `h1` and a link on others, and `AdminGate` for the console. They said different things, sent
 * people to different places, and — the reason this exists — there was no way to tell from the
 * outside whether a page had a gate at all.
 *
 * `data-testid="sign-in-required"` is the point of the component. `signed-out.spec.ts` sweeps
 * every page under `/account`, `/creator` and `/admin` and looks for exactly this, so a page
 * added without a gate fails rather than quietly serving its shell. Asserting a "Sign in" link
 * instead would prove nothing: the site header has one on every page, including public ones.
 *
 * The API is what actually holds the line — a page with no gate still could not get any rows
 * (`deny-by-default.test.ts`). This is about what a person sees, and about being able to prove
 * which pages are meant to be closed.
 */
export function SignInRequired({
  title,
  reason,
  next,
}: {
  title: string;
  /** Finishes the sentence "You need to sign in to …". Ends without a full stop. */
  reason: string;
  /** Where to return after signing in. */
  next: string;
}): React.JSX.Element {
  return (
    <div className="space-y-4" data-testid="sign-in-required">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted">You need to sign in to {reason}.</p>
      {/* Back to where they were trying to go, rather than the front page. */}
      <Link href={`/sign-in?next=${encodeURIComponent(next)}`} className="underline">
        Sign in
      </Link>
    </div>
  );
}
