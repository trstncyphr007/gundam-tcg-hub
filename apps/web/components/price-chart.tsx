import { dollars } from '@/lib/money';
import { type PricePoint, dayNumber, niceCeiling, splitRuns } from '@/lib/price-series';

export type { PricePoint };

/**
 * A price history chart, as server-rendered SVG (FR-3.3).
 *
 * No charting library and no client JavaScript. Three reasons, in order of how much they
 * mattered:
 *
 *  1. Every hosted chart library wants a script tag, and our CSP forbids third-party script
 *     (SR-X.16). A bundled one is allowed but is a large dependency on a page that renders
 *     six polylines.
 *  2. Server-rendered SVG works with JavaScript switched off, in an RSS reader, in a
 *     screenshot, and in the HTML someone pastes into Discord.
 *  3. It is honest about gaps, which a library would smooth over by default — and the gaps
 *     are the point.
 *
 * **The gap rule.** The index publishes nothing on a day with fewer than three observations.
 * A line drawn straight across that gap asserts a price we did not have. So the series is
 * split into runs of consecutive days and each run is drawn separately: a break in the line
 * is a day we could not price, and it looks like one.
 */

const WIDTH = 720;
const HEIGHT = 240;
const PAD = { top: 16, right: 16, bottom: 28, left: 56 };

/** One colour per printing. Deliberately few: more than three lines is a table, not a chart. */
const SERIES_COLOURS = ['#7dd3fc', '#f0abfc', '#fcd34d', '#86efac'];

interface Series {
  key: string;
  label: string;
  colour: string;
  points: PricePoint[];
}

export function PriceChart({
  points,
  currency = 'USD',
}: {
  points: readonly PricePoint[];
  currency?: string;
}): React.JSX.Element {
  if (points.length === 0) {
    return (
      <div
        className="rounded border p-6 text-sm"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
      >
        <p className="font-medium">Not enough data to publish a price</p>
        <p className="mt-1" style={{ color: 'var(--muted)' }}>
          The index needs at least three observations for a day before it will say anything. That is
          not a price of zero — it is us declining to guess.
        </p>
      </div>
    );
  }

  // Group by printing. Condition is chosen above the chart, so a series is one variant.
  const grouped = new Map<string, Series>();
  points.forEach((point) => {
    const key = point.cardVariantId;
    const existing = grouped.get(key);
    if (existing) {
      existing.points.push(point);
      return;
    }
    grouped.set(key, {
      key,
      label: `${point.finish.replace('_', ' ')} · ${point.language.toUpperCase()}`,
      colour: SERIES_COLOURS.at(grouped.size % SERIES_COLOURS.length) ?? '#7dd3fc',
      points: [point],
    });
  });
  const series = [...grouped.values()];

  const days = points.map((p) => dayNumber(p.day));
  const firstDay = Math.min(...days);
  const lastDay = Math.max(...days);
  const span = Math.max(1, lastDay - firstDay);

  // The band is p25–p75, so the scale has to contain it as well as the median.
  const ceiling = niceCeiling(Math.max(...points.map((p) => p.p75Cents)));
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;

  const x = (day: string): number => PAD.left + ((dayNumber(day) - firstDay) / span) * plotWidth;
  const y = (cents: number): number => PAD.top + plotHeight - (cents / ceiling) * plotHeight;

  const gridValues = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(ceiling * f));
  const latest = points.at(-1);

  return (
    <figure className="m-0 space-y-3">
      <div
        className="overflow-x-auto rounded border p-2"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
      >
        <svg
          viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
          width="100%"
          height={HEIGHT}
          role="img"
          aria-label={`Price history: ${series.map((s) => s.label).join(', ')}, ending at ${
            latest ? dollars(latest.medianCents, currency) : 'no data'
          }`}
        >
          {gridValues.map((value) => (
            <g key={value}>
              <line
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={y(value)}
                y2={y(value)}
                stroke="var(--border)"
                strokeWidth="1"
              />
              <text
                x={PAD.left - 8}
                y={y(value) + 4}
                textAnchor="end"
                fontSize="11"
                fill="var(--muted)"
              >
                {dollars(value, currency)}
              </text>
            </g>
          ))}

          {series.map((entry) =>
            splitRuns(entry.points).map((run, index) => {
              const line = run.map((p) => `${String(x(p.day))},${String(y(p.medianCents))}`);
              // The band is the same run forwards along p75 and back along p25.
              const band = [
                ...run.map((p) => `${String(x(p.day))},${String(y(p.p75Cents))}`),
                ...[...run].reverse().map((p) => `${String(x(p.day))},${String(y(p.p25Cents))}`),
              ];
              return (
                <g key={`${entry.key}-${String(index)}`}>
                  {/* The spread, drawn behind the median: one number alone hides it. */}
                  <polygon points={band.join(' ')} fill={entry.colour} opacity="0.15" />
                  <polyline
                    points={line.join(' ')}
                    fill="none"
                    stroke={entry.colour}
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                  {/* A single day cannot be a line, so give it a dot or it renders as nothing. */}
                  {run.length === 1 && run[0] && (
                    <circle
                      cx={x(run[0].day)}
                      cy={y(run[0].medianCents)}
                      r="2.5"
                      fill={entry.colour}
                    />
                  )}
                </g>
              );
            }),
          )}

          <text x={PAD.left} y={HEIGHT - 8} fontSize="11" fill="var(--muted)">
            {points[0]?.day}
          </text>
          <text
            x={WIDTH - PAD.right}
            y={HEIGHT - 8}
            textAnchor="end"
            fontSize="11"
            fill="var(--muted)"
          >
            {latest?.day}
          </text>
        </svg>
      </div>

      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {series.map((entry) => (
          <span key={entry.key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: entry.colour }}
            />
            {entry.label}
          </span>
        ))}
        <span style={{ color: 'var(--muted)' }}>
          Line is the trimmed median; the band is the 25th–75th percentile. A break in the line is a
          day with too little evidence to publish.
        </span>
      </figcaption>
    </figure>
  );
}
