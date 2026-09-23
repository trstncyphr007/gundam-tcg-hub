/**
 * How the OBS overlay behaves with a hundred viewers (plan §24).
 *
 *   bash scripts/measure-overlays.sh          # 100 streams across 20 breaks
 *   STREAMS=200 bash scripts/measure-overlays.sh
 *
 * k6 has no server-sent events without a custom build, and this needs to measure something
 * k6 would not anyway: **how long a pull takes to reach every open overlay**. So it opens the
 * connections itself, logs a pull, and times the arrival at each one.
 *
 * What it is really testing is the design. Each connection polls the database on its own
 * timer (`OVERLAY_POLL_MS`), so a hundred overlays is a hundred queries a second whether or
 * not anything is happening — the cost of the simplest thing that works, and worth knowing
 * the size of before a break night rather than during one.
 *
 * Needs: the API running, and `DATABASE_URL_MIGRATOR` for the fixtures it creates and removes.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

// The Postgres driver belongs to `packages/db`, and ESM resolves from *this file's* location
// rather than the working directory — so resolution is pointed there explicitly instead of
// duplicating a dependency into the repository root for one measurement script.
const requireFromDb = createRequire(new URL('../packages/db/package.json', import.meta.url));
const postgres = requireFromDb('postgres');

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4000';
const STREAMS = Number(process.env.STREAMS ?? 100);
const PER_TOKEN = Number(process.env.PER_TOKEN ?? 5); // MAX_OVERLAY_CONNECTIONS
const PEPPER = process.env.TOKEN_PEPPER ?? 'dev-only-insecure-pepper-change-me-32+';
const DB_URL = process.env.DATABASE_URL_MIGRATOR;
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 4000);

if (!DB_URL) {
  console.error('DATABASE_URL_MIGRATOR is required (it creates and removes its own fixtures)');
  process.exit(1);
}

const breaks = Math.ceil(STREAMS / PER_TOKEN);
const sql = postgres(DB_URL, { max: 4 });
// Exactly what packages/security does — hex, not base64url. Getting this wrong makes every
// stream a 404, which looks like a broken endpoint rather than a broken fixture.
const hash = (token) => createHmac('sha256', PEPPER).update(token, 'utf8').digest('hex');

const percentile = (values, p) => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

async function fixtures() {
  const [creator] = await sql`
    insert into app.users (id, name, email, role)
    values ('sse-perf-creator', 'SSE perf', 'sse-perf@example.invalid', 'creator')
    on conflict (id) do update set role = 'creator'
    returning id`;

  const [product] = await sql`
    select p.id from app.sealed_products p limit 1`;
  if (!product) throw new Error('seed a catalog first (pnpm db:seed)');

  // Breaks force row-level security, for the table owner too, so the fixtures declare who
  // they are acting as exactly like the application does (ADR-011).
  const tokens = [];
  await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${creator.id}, true)`;
    for (let i = 0; i < breaks; i += 1) {
      const token = randomBytes(24).toString('base64url');
      await tx`
        insert into app.breaks (creator_id, title, sealed_product_id, status, overlay_token_hash, started_at)
        values (${creator.id}, ${'SSE perf ' + i}, ${product.id}, 'live', ${hash(token)}, now())`;
      tokens.push(token);
    }
  });
  return { creatorId: creator.id, tokens };
}

async function cleanup() {
  await sql`delete from app.breaks where creator_id = 'sse-perf-creator'`;
  await sql`delete from app.users where id = 'sse-perf-creator'`;
  await sql.end();
}

/** One overlay. Resolves its own state events onto `onState`. */
async function openStream(token, onState, onError) {
  const response = await fetch(`${BASE}/v1/overlay/${token}/stream`, {
    headers: { accept: 'text/event-stream' },
  });
  if (!response.ok) {
    onError(`HTTP ${response.status}`);
    return null;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (event === 'state' && data) onState(JSON.parse(data));
        }
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  })();
  return reader;
}

const main = async () => {
  console.log(`opening ${STREAMS} overlays across ${breaks} breaks on ${BASE}`);
  const { tokens } = await fixtures();

  const errors = [];
  const readers = [];
  /** Per stream: how many pulls it has seen, and when the newest arrived. */
  const seen = new Map();

  // The one break everything is timed against, plus its own viewers.
  const watched = tokens[0];

  await Promise.all(
    Array.from({ length: STREAMS }, async (_, i) => {
      const token = tokens[i % tokens.length];
      const key = `${i}`;
      seen.set(key, { token, pulls: 0, at: 0 });
      const reader = await openStream(
        token,
        (state) => {
          const entry = seen.get(key);
          entry.pulls = state.pulls?.length ?? 0;
          entry.at = performance.now();
        },
        (message) => errors.push(`stream ${key}: ${message}`),
      );
      if (reader) readers.push(reader);
    }),
  );

  const opened = readers.length;
  console.log(`opened ${opened}/${STREAMS}${errors.length ? ` · ${errors.length} refused` : ''}`);

  // Let the initial state and the first poll cycle settle before timing anything.
  await new Promise((r) => setTimeout(r, SETTLE_MS));

  // What a hundred idle overlays cost. Each connection polls on its own timer, so this is the
  // standing load with nothing whatsoever happening — the number worth knowing before a break
  // night rather than during one.
  const commits = async () => {
    const [row] =
      await sql`select xact_commit from pg_stat_database where datname = current_database()`;
    return Number(row.xact_commit);
  };
  const idleStart = await commits();
  await new Promise((r) => setTimeout(r, 5000));
  const idleRate = Math.round(((await commits()) - idleStart) / 5);

  const before = new Map([...seen].map(([k, v]) => [k, v.pulls]));
  const [target] = await sql`select id from app.breaks where overlay_token_hash = ${hash(watched)}`;
  const sent = performance.now();
  await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', 'sse-perf-creator', true)`;
    await tx`
      insert into app.break_pulls (break_id, seq, label, value_cents_at_pull, value_source, pulled_at)
      values (${target.id}, 1, 'Perf Pull', 1234, 'manual', now())`;
  });

  // Wait for the watchers of that break to notice.
  const watchers = [...seen].filter(([, v]) => v.token === watched).map(([k]) => k);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (watchers.every((k) => seen.get(k).pulls > before.get(k))) break;
    await new Promise((r) => setTimeout(r, 25));
  }

  const latencies = watchers
    .filter((k) => seen.get(k).pulls > before.get(k))
    .map((k) => seen.get(k).at - sent);

  console.log('');
  console.log(`streams opened......... ${opened}`);
  console.log(`refused................ ${errors.length}`);
  console.log(`idle database load..... ${idleRate} transactions/second with nothing happening`);
  console.log(`watchers of the pull... ${watchers.length}, ${latencies.length} received it`);
  if (latencies.length > 0) {
    console.log(`delivery p50........... ${Math.round(percentile(latencies, 50))} ms`);
    console.log(`delivery p95........... ${Math.round(percentile(latencies, 95))} ms`);
    console.log(`delivery max........... ${Math.round(Math.max(...latencies))} ms`);
  }
  // Every other stream must still be alive and must NOT have seen another break's pull.
  const crossTalk = [...seen].filter(
    ([k, v]) => v.token !== watched && v.pulls > before.get(k),
  ).length;
  console.log(`cross-talk............. ${crossTalk} (streams shown another break's pull)`);
  if (errors.length > 0) console.log(`first error............ ${errors[0]}`);

  for (const reader of readers) void reader.cancel().catch(() => {});
  await cleanup();
  process.exit(crossTalk === 0 && latencies.length === watchers.length ? 0 : 1);
};

main().catch(async (error) => {
  console.error(error);
  await cleanup().catch(() => {});
  process.exit(1);
});
