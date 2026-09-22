import Link from 'next/link';
import { API_LIMITS, CONTACT_EMAIL, INDEX_LICENCE, LAST_UPDATED } from '@/lib/site';

export const metadata = {
  title: 'Terms · Gundam TCG Hub',
  description: 'The rules for using this service, its data and its API.',
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
    <section className="space-y-2" id={id} data-testid={`terms-${id}`}>
      <h2 className="text-lg font-medium">{title}</h2>
      {children}
    </section>
  );
}

/**
 * Terms of use (plan §23), matching what the service actually enforces: the API limits below
 * are the ones the quota plugin applies, and the index licence is the one the OpenAPI
 * document declares (ADR-020).
 */
export default function TermsPage(): React.JSX.Element {
  return (
    <div className="max-w-prose space-y-8" data-testid="terms">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Terms</h1>
        <p className="text-sm text-muted">Last updated {LAST_UPDATED}.</p>
      </header>

      <Section id="what" title="What this is">
        <p className="text-sm">
          Gundam TCG Hub is an independent hobby project: restock alerts, a community price index,
          collection tools and break transparency tools for the Gundam Card Game. It is
          <strong> not affiliated with, endorsed by or licensed by Bandai</strong> or any publisher
          or retailer. Card names and game text belong to their owners.
        </p>
      </Section>

      <Section id="account" title="Your account">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>You must be at least 13.</li>
          <li>
            Keep your sign-in email and passkeys to yourself; anything done with your account is
            treated as done by you.
          </li>
          <li>
            You can delete the account at any time at{' '}
            <Link href="/account/data" className="underline">
              Account → Your data
            </Link>
            .
          </li>
          <li>
            We may suspend an account that is breaking these rules, and will say why where we can.
          </li>
        </ul>
      </Section>

      <Section id="use" title="Using it fairly">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>
            Do not submit prices you know to be wrong, or file reports to move the index. The index
            exists to be trustworthy; manipulating it is the one thing that breaks it.
          </li>
          <li>
            Do not upload other people&rsquo;s personal information. A buyer&rsquo;s name in the
            live-sale logger is optional, kept private and erased after 90 days.
          </li>
          <li>
            Do not scrape the site, attempt to reach other people&rsquo;s data, or work around the
            rate limits. The API exists for that, and it is free.
          </li>
          <li>
            Break logs, pull values and VOD links you publish are your claims about your own
            streams; keep them honest.
          </li>
        </ul>
      </Section>

      <Section id="data" title="The price index is open data">
        <p className="text-sm">
          The published price index — medians, spreads and the number of observations behind them —
          is available under{' '}
          <a href={INDEX_LICENCE.url} className="underline" rel="noreferrer">
            {INDEX_LICENCE.name}
          </a>
          : use it, including commercially, with attribution to this service. How it is computed is
          public at{' '}
          <Link href="/methodology" className="underline">
            Methodology
          </Link>
          .
        </p>
        <p className="text-sm">
          What you write stays yours. By publishing a collection, a profile or a break page you
          allow us to display it here.
        </p>
      </Section>

      <Section id="api" title="The API">
        <p className="text-sm">
          A free key allows {API_LIMITS.perMinute} requests a minute and {API_LIMITS.perDay} a day.
          Keys are personal; do not share one. Sustained abuse gets a key suspended. Attribution is
          required when you publish anything built on the index.
        </p>
      </Section>

      <Section id="promises" title="What we do not promise">
        <p className="text-sm">
          This is a hobby service provided as-is, with no guarantee of uptime, accuracy or
          continuity. Prices here are community estimates, not appraisals: check before you buy or
          sell. Restock alerts may be late, wrong or missed, and retailers change their pages
          without warning. Decisions you make from this data are yours.
        </p>
      </Section>

      <Section id="changes" title="Changes">
        <p className="text-sm">
          These terms will change as the service grows — a marketplace, for instance, will need its
          own rules. Material changes will be announced before they take effect, and the date above
          will move.
        </p>
      </Section>

      <Section id="contact" title="Contact">
        {CONTACT_EMAIL === null ? (
          <p className="text-sm" data-testid="contact-pending">
            A contact address will be published here when the site goes live on its own domain.
          </p>
        ) : (
          <p className="text-sm">
            <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
              {CONTACT_EMAIL}
            </a>
          </p>
        )}
      </Section>
    </div>
  );
}
