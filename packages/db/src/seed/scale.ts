import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';

/**
 * A catalog big enough to measure against (plan FR-1.3, §20).
 *
 * The plan promises card search "under 200 ms p95 on 10k cards" and the price endpoint under
 * 300 ms. Both were written before there was anything to measure: the development seed holds
 * **three** cards, at which everything is fast and every index looks unnecessary. A promise
 * tested only at three rows is not tested.
 *
 * This is still placeholder data — no publisher catalog before the IP review (plan §23, open
 * item O2) — but it is placeholder data of a realistic *shape*: names that share prefixes and
 * words, so a trigram search has to discriminate rather than match everything or nothing, and
 * a published price for most variants, so the price endpoint does real work.
 */
export interface ScaleOptions {
  /** How many cards. The plan's figure is 10,000. */
  cards?: number;
  /** Days of published index history per priced variant. */
  priceDays?: number;
}

const UNITS = [
  'Gundam',
  'Zaku',
  'Guncannon',
  'Guntank',
  'Dom',
  'Gouf',
  'Hyaku Shiki',
  'Zeta',
  'Nu',
  'Sazabi',
  'Barbatos',
  'Exia',
  'Wing',
  'Deathscythe',
  'Heavyarms',
];
const QUALIFIERS = [
  'Custom',
  'Kai',
  'Prototype',
  'Ground Type',
  'Full Armor',
  'High Mobility',
  'Assault',
  'Sniper',
  'Trial',
  'Final Battle',
];
const RARITIES = ['C', 'UC', 'R', 'SR', 'LR'];
const TYPES = ['unit', 'pilot', 'command', 'base'];

export interface ScaleResult {
  cards: number;
  variants: number;
  priceRows: number;
}

export async function seedScale(db: Database, options: ScaleOptions = {}): Promise<ScaleResult> {
  const { cards: cardCount = 10_000, priceDays = 30 } = options;

  const [game] = await db.execute<{ id: string }>(sql`
    insert into app.games (slug, name) values ('gundam', 'Gundam Card Game')
    on conflict (slug) do update set name = excluded.name
    returning id
  `);
  if (!game) throw new Error('scale seed: no game');

  // One set per 250 cards, which is roughly a real set's size.
  const setCount = Math.max(1, Math.ceil(cardCount / 250));
  const setRows = await db.execute<{ id: string }>(sql`
    insert into app.sets (game_id, code, name, release_date)
    select ${game.id}, 'SCALE-' || lpad(i::text, 3, '0'),
           'Scale Set ' || i, date '2020-01-01' + (i * 30)
      from generate_series(1, ${setCount}) as i
    on conflict (game_id, code) do update set name = excluded.name
    returning id
  `);
  if (setRows.length === 0) throw new Error('scale seed: no sets');

  // Built in the database rather than round-tripped: ten thousand inserts from Node take
  // minutes, and the point here is to have the data, not to measure the seeding.
  const names = sql`
    select (${sql.join(
      [
        sql`(array[${sql.join(
          UNITS.map((u) => sql`${u}`),
          sql`, `,
        )}])[1 + (i % ${UNITS.length})]`,
        sql`' '`,
        sql`(array[${sql.join(
          QUALIFIERS.map((q) => sql`${q}`),
          sql`, `,
        )}])[1 + ((i / 7)::int % ${QUALIFIERS.length})]`,
        sql`' '`,
        sql`chr(65 + (i % 26))`,
        sql`(i % 97)::text`,
      ],
      sql` || `,
    )}) as name, i
    from generate_series(1, ${cardCount}) as i
  `;

  const inserted = await db.execute<{ n: number }>(sql`
    with n as (${names}),
    ins as (
      insert into app.cards (set_id, number, name, card_type, rarity)
      select (array[${sql.join(
        setRows.map((s) => sql`${s.id}::uuid`),
        sql`, `,
      )}])[1 + (n.i % ${setRows.length})],
             lpad(n.i::text, 4, '0'),
             n.name,
             (array[${sql.join(
               TYPES.map((t) => sql`${t}`),
               sql`, `,
             )}])[1 + (n.i % ${TYPES.length})],
             (array[${sql.join(
               RARITIES.map((r) => sql`${r}`),
               sql`, `,
             )}])[1 + (n.i % ${RARITIES.length})]
        from n
      on conflict (set_id, number) do nothing
      returning 1
    )
    select count(*)::int as n from ins
  `);

  const variants = await db.execute<{ n: number }>(sql`
    with ins as (
      insert into app.card_variants (card_id, finish, language)
      select c.id, 'normal', 'en'
        from app.cards c
        join app.sets s on s.id = c.set_id
       where s.code like 'SCALE-%'
      on conflict (card_id, finish, language) do nothing
      returning 1
    )
    select count(*)::int as n from ins
  `);

  // A published index for four cards in five, so "insufficient data" is also exercised.
  const priceRows = await db.execute<{ n: number }>(sql`
    with v as (
      select cv.id, row_number() over (order by cv.id) as rn
        from app.card_variants cv
        join app.cards c on c.id = cv.card_id
        join app.sets s on s.id = c.set_id
       where s.code like 'SCALE-%'
    ),
    ins as (
      insert into app.price_index_daily
        (card_variant_id, condition, day, median_cents, p25_cents, p75_cents,
         low_cents, high_cents, observation_count, currency)
      select v.id, 'nm', current_date - d,
             200 + (v.rn % 5000), 150 + (v.rn % 5000), 260 + (v.rn % 5000),
             100 + (v.rn % 5000), 400 + (v.rn % 5000), 3 + (v.rn % 12), 'USD'
        from v cross join generate_series(0, ${priceDays - 1}) as d
       where v.rn % 5 <> 0
      on conflict (card_variant_id, condition, day, currency) do nothing
      returning 1
    )
    select count(*)::int as n from ins
  `);

  // Planner statistics, or the first queries measure a table Postgres thinks is empty — which
  // is its own kind of wrong answer.
  await db.execute(sql`analyze app.cards`);
  await db.execute(sql`analyze app.card_variants`);
  await db.execute(sql`analyze app.price_index_daily`);

  return {
    cards: inserted[0]?.n ?? 0,
    variants: variants[0]?.n ?? 0,
    priceRows: priceRows[0]?.n ?? 0,
  };
}
