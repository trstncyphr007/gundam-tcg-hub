import Link from 'next/link';

export const metadata = {
  title: 'How prices are computed · Gundam TCG Hub',
  description: 'The method behind the Gundam TCG Hub price index, in full.',
};

/**
 * The published methodology (FR-3.2).
 *
 * Required by the plan, and required by the argument the project is making: an independent
 * price index is only worth citing if anyone can check how the number was reached. This page
 * is the prose version of ADR-018, and it should be updated in the same commit as any change
 * to the maths.
 */
export default function MethodologyPage() {
  return (
    <article className="max-w-2xl space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">How prices are computed</h1>
        <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
          Every number we publish is reached the same way, and the rules are deliberately dull. If
          you think one of them is wrong, we would rather argue about the method than about a
          number.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">The short version</h2>
        <p className="text-sm">
          For each printing, each condition, each day, we take every sale we know about, drop the
          extreme 10% at each end, and publish the median of what is left — along with the 25th and
          75th percentiles, so you can see the spread rather than just a single number.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Nothing is published below three sales</h2>
        <p className="text-sm">
          If we know of fewer than three sales for a card on a given day, we publish nothing for
          that day. Not a zero, not yesterday&rsquo;s number carried forward — nothing.
        </p>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          This is why a chart has gaps in it. A gap is a day we could not price honestly, and we
          would rather show you that than draw a line through it.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Trimming starts at ten sales</h2>
        <p className="text-sm">
          Below ten observations we do not trim at all. Dropping one from each end of a three-sale
          sample leaves a single number being called a median, which is a different statistic
          wearing the same name.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">The range shows the ends, including the odd ones</h2>
        <p className="text-sm">
          The low and high we report come from the <em>untrimmed</em> set. If one copy sold for ten
          times the going rate, the median will not move — but the range will show it, because it
          happened.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Some sources count more than others</h2>
        <p className="text-sm">
          A sale we watched happen is better evidence than a sale someone told us about. Each
          observation is weighted accordingly:
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs" style={{ color: 'var(--muted)' }}>
              <th className="py-2">Source</th>
              <th className="py-2">Weight</th>
              <th className="py-2">Why</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
              <td className="py-2">Break pulls, live sales</td>
              <td className="py-2">3</td>
              <td className="py-2" style={{ color: 'var(--muted)' }}>
                We watched it happen
              </td>
            </tr>
            <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
              <td className="py-2">Official marketplace APIs</td>
              <td className="py-2">2</td>
              <td className="py-2" style={{ color: 'var(--muted)' }}>
                Trustworthy, but someone else&rsquo;s number
              </td>
            </tr>
            <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
              <td className="py-2">User reports</td>
              <td className="py-2">1</td>
              <td className="py-2" style={{ color: 'var(--muted)' }}>
                Someone told us — and only after a human approves it
              </td>
            </tr>
          </tbody>
        </table>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Weighting repeats an observation rather than multiplying it, so the weighted median is
          still a price somebody actually paid, not an average nobody paid.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">&ldquo;Backed by 4 sales&rdquo; means four sales</h2>
        <p className="text-sm">
          The count we show is the number of <em>real</em> observations, never the weighted
          expansion of them. Four sales from trusted sources carry the weight of twelve in the
          maths, and we will still tell you there were four.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">What we do about people gaming it</h2>
        <p className="text-sm">
          A user-reported price counts for nothing until a person approves it, and prices far
          outside the current spread are flagged for review before they count. The sources we weight
          most heavily cannot be submitted at all — they come from our own logs.
        </p>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          That last point is a database privilege, not a policy we intend to follow. A signed-in
          session can file a report and nothing else; a break pull or a live sale becomes an
          observation only by passing through a job that no web request can reach.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Prices from live streams</h2>
        <p className="text-sm">
          A card sold on a live stream leaves no listing and no sold-price page. Nobody records
          those sales, which is why we do — sellers log each one as it happens, and it counts for as
          much as a pull we watched come out of a pack.
        </p>
        <p className="text-sm">
          Each entry is measured against the current spread for that card before it counts. One that
          sits more than three interquartile ranges outside is <strong>held</strong>: recorded,
          visible to the seller, and kept out of the published number until a person has looked. A
          $900 sale of a $12 card is either a typo or the most interesting thing that happened all
          week, and only a person can tell which.
        </p>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Nothing is held when we have no recent published price for that card: you cannot call a
          price an outlier with nothing to be outside of.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Currencies are never converted</h2>
        <p className="text-sm">
          Prices in different currencies are indexed separately. We hold no exchange rates, and
          inventing one would put a made-up number inside a number you are being asked to trust.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">How hit rates are compared to published odds</h2>
        <p className="text-sm">
          A{' '}
          <Link href="/breakers" className="underline">
            breaker profile
          </Link>{' '}
          compares what someone pulled against the odds the publisher printed. That comparison can
          read as an accusation, so it is deliberately hard to trigger.
        </p>
        <ul className="list-disc space-y-2 pl-5 text-sm">
          <li>
            The denominator is <strong>packs</strong>, not pulls, because published odds are stated
            per pack. A break that did not record a pack count is left out entirely.
          </li>
          <li>
            Comparisons are made <strong>per product</strong>. Pooling a 1-in-12 set with a 1-in-24
            set produces a rate comparable to neither.
          </li>
          <li>
            Nothing is compared below 30 packs, or below five <em>expected</em> hits. At 1-in-72
            odds that means 360 packs — so most rows will say &ldquo;too few packs&rdquo; for a long
            time, which is the honest answer rather than a hedge.
          </li>
          <li>
            The interval is a <strong>Wilson score interval</strong>, and it is widened for the
            number of rarities checked at once. Testing six rarities at 95% gives roughly a one in
            four chance that one of them looks damning through luck alone — and that is exactly the
            one that would get screenshotted.
          </li>
        </ul>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          &ldquo;Above&rdquo; or &ldquo;below published&rdquo; is a statement about one sample. It
          is not a claim about the person, and we do not make one.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Using this data</h2>
        <p className="text-sm">
          The index is published under{' '}
          <a
            href="https://creativecommons.org/licenses/by/4.0/"
            className="underline"
            rel="noreferrer noopener"
            target="_blank"
          >
            CC BY 4.0
          </a>
          : use it for anything, including commercially, as long as you say where it came from. It
          is available from the{' '}
          <a href="/docs" className="underline">
            public API
          </a>
          .
        </p>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Card names, text and images are the publisher&rsquo;s property and are not ours to
          license. This site is not affiliated with Bandai.
        </p>
      </section>

      <p className="text-sm">
        <Link href="/" className="underline">
          Back to search
        </Link>
      </p>
    </article>
  );
}
