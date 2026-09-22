import Link from 'next/link';
import { CONTACT_EMAIL, LAST_UPDATED } from '@/lib/site';

export const metadata = {
  title: 'Privacy · Gundam TCG Hub',
  description: 'What this service stores about you, why, for how long, and how to take it back.',
};

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="space-y-2" id={id} data-testid={`privacy-${id}`}>
      <h2 className="text-lg font-medium">{title}</h2>
      {children}
    </section>
  );
}

/**
 * The privacy policy (plan §23, SR-X.24 to SR-X.26).
 *
 * Written from what the code actually does, not from a template: every retention period and
 * every "we do not" below matches a control in the repository. If a claim here stops being
 * true, the page is wrong and must change with the code.
 */
export default function PrivacyPage(): React.JSX.Element {
  return (
    <div className="max-w-prose space-y-8" data-testid="privacy">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Privacy</h1>
        <p className="text-sm text-muted">Last updated {LAST_UPDATED}.</p>
        <p className="text-sm">
          The short version: we keep the least we can, we never sell it, there is no advertising or
          analytics tracking on this site, and you can take a copy or delete everything yourself at
          any time.
        </p>
      </header>

      <Section id="collect" title="What we store">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>
            <strong>Your account:</strong> the email address you sign in with, a display name if you
            set one, and your Discord account id if you choose to connect Discord.
          </li>
          <li>
            <strong>How you sign in:</strong> passkeys (public keys only — the private key never
            leaves your device), and for each session, when it started, the browser and operating
            system family (&ldquo;Chrome on Windows&rdquo;), and a <em>hash</em> of the network
            address. The hash is re-keyed every day, so it cannot be used to follow you from one day
            to the next, and the address itself is never stored.
          </li>
          <li>
            <strong>What you make:</strong> restock watches, collections and their notes, break logs
            and pull values, live-sale entries, price reports and the evidence links you attach, and
            API keys (stored only as a hash).
          </li>
          <li>
            <strong>A security log</strong> of account events — signing in, adding or removing a
            passkey, role changes, moderation decisions. It records an internal account id, never an
            email address.
          </li>
        </ul>
      </Section>

      <Section id="not" title="What we do not do">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>
            No advertising, no analytics, no third-party trackers, and no cookies beyond the one
            that keeps you signed in.
          </li>
          <li>We do not sell or rent your data, and we do not share it for marketing.</li>
          <li>We do not store your network address in a readable form (see above).</li>
          <li>
            We do not read your collection to price it for anyone else: a private collection is
            visible only to you.
          </li>
        </ul>
      </Section>

      <Section id="public" title="What is public, and only if you choose">
        <p className="text-sm">
          Collections are private unless you make them unlisted or public. A creator profile and its
          break pages are published only when you publish them. A price you report may be approved
          and counted in the public price index — the price and its evidence link are public, but
          you are not named. Buyer names typed into the live-sale logger are never shown publicly.
        </p>
      </Section>

      <Section id="keep" title="How long we keep it">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>
            <strong>Sign-in links:</strong> 15 minutes, single use.
          </li>
          <li>
            <strong>Sessions:</strong> at most 30 days, and you can end any of them at{' '}
            <Link href="/account/security" className="underline">
              Account → Security
            </Link>
            .
          </li>
          <li>
            <strong>Buyer names in the live-sale logger:</strong> erased 90 days after the sale,
            automatically, by a job that cannot read them.
          </li>
          <li>
            <strong>Everything else:</strong> until you delete it, or until you delete your account.
          </li>
          <li>
            <strong>The security log</strong> outlives the account it refers to, holding an internal
            id and no email. It is not yet pruned automatically; when that is built, entries will be
            kept for a year.
          </li>
          <li>
            <strong>Backups</strong> are kept on a rolling schedule and age out. A deletion is
            re-applied if a backup is ever restored.
          </li>
        </ul>
      </Section>

      <Section id="rights" title="Taking it back">
        <p className="text-sm">
          At{' '}
          <Link href="/account/data" className="underline">
            Account → Your data
          </Link>{' '}
          you can download everything this account holds as one file, or delete the account
          outright. Deletion is immediate and permanent: watches, collections, breaks, live sales,
          sessions and passkeys all go. Prices you reported that already count in the public index
          stay, with nothing left connecting them to you.
        </p>
      </Section>

      <Section id="others" title="Who else is involved">
        <p className="text-sm">
          An email provider delivers sign-in links and alerts. Discord receives an alert only if you
          connect Discord and ask for it. The site runs on a rented server. That is the whole list —
          there is no analytics or advertising service to name.
        </p>
      </Section>

      <Section id="children" title="Age">
        <p className="text-sm">
          This service is not for children under 13, and we do not knowingly keep data about them.
        </p>
      </Section>

      <Section id="contact" title="Contact">
        {CONTACT_EMAIL === null ? (
          <p className="text-sm" data-testid="contact-pending">
            A contact address will be published here when the site goes live on its own domain.
            Until then this service is not open to the public.
          </p>
        ) : (
          <p className="text-sm">
            Questions, or a request about your data:{' '}
            <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        )}
      </Section>
    </div>
  );
}
