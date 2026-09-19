// Production-dependency license allowlist check (plan §18.2 "sca" job).
// Fails on any license not in ALLOWED; REVIEW licenses warn but pass.
import { execFileSync } from 'node:child_process';

const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
]);
const REVIEW = new Set(['MPL-2.0', 'CC-BY-4.0', 'Python-2.0']);

/** Evaluate a simple SPDX expression like "(MIT OR Apache-2.0)" or "MIT AND ISC". */
function verdict(expression) {
  const expr = expression.replace(/[()]/g, '').trim();
  const check = (id) => (ALLOWED.has(id) ? 'ok' : REVIEW.has(id) ? 'review' : 'deny');
  const rank = new Map([
    ['ok', 0],
    ['review', 1],
    ['deny', 2],
  ]);
  if (expr.includes(' OR ')) {
    return expr
      .split(' OR ')
      .map((s) => check(s.trim()))
      .reduce((best, v) => (rank.get(v) < rank.get(best) ? v : best), 'deny');
  }
  return expr
    .split(' AND ')
    .map((s) => check(s.trim()))
    .reduce((worst, v) => (rank.get(v) > rank.get(worst) ? v : worst), 'ok');
}

const raw = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], { encoding: 'utf8' });
const byLicense = JSON.parse(raw);

let failed = false;
for (const [license, packages] of Object.entries(byLicense)) {
  const v = verdict(license);
  if (v === 'ok') continue;
  const names = packages.map((p) => `${p.name}@${(p.versions ?? []).join(',')}`).join(', ');
  if (v === 'review') {
    console.warn(`REVIEW  ${license}: ${names}`);
  } else {
    console.error(`DENIED  ${license}: ${names}`);
    failed = true;
  }
}

if (failed) {
  console.error('\nLicense check failed. Add an exception only after review (plan §18.2).');
  process.exit(1);
}
console.log(`License check passed (${Object.keys(byLicense).length} license types).`);
