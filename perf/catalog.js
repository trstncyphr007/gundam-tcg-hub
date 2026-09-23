import http from 'k6/http';
import { check } from 'k6';

/**
 * The two promises the plan makes about speed (FR-1.3, §20 SLOs), as a runnable check.
 *
 *   bash scripts/measure-slos.sh
 *
 * The thresholds below are the promises. k6 exits non-zero when one is missed, so "the API is
 * fast enough" stops being a belief and becomes something that fails out loud.
 *
 * Measured through the API, not against the database: a query that takes 6 ms and an endpoint
 * that takes 300 ms are both possible at once, and only one of them is what a visitor waits
 * for.
 */
const BASE = __ENV.BASE_URL || 'http://127.0.0.1:4000';

// Terms that actually match the seeded catalog, in the shapes people type: a whole name, a
// fragment, a qualifier shared by thousands of rows, and one that matches nothing.
const TERMS = [
  'Zaku Custom',
  'Gundam',
  'Barbatos',
  'Sniper',
  'Exia Final',
  'zaku',
  'Guncannon Kai',
  'Wing Prototype',
  'qqqqqq',
];

export const options = {
  scenarios: {
    search: {
      executor: 'constant-arrival-rate',
      rate: 20,
      timeUnit: '1s',
      duration: __ENV.DURATION || '30s',
      preAllocatedVUs: 10,
      maxVUs: 50,
      exec: 'search',
    },
    prices: {
      executor: 'constant-arrival-rate',
      rate: 20,
      timeUnit: '1s',
      duration: __ENV.DURATION || '30s',
      preAllocatedVUs: 10,
      maxVUs: 50,
      exec: 'prices',
      startTime: '0s',
    },
  },
  thresholds: {
    // FR-1.3: card search under 200 ms p95.
    'http_req_duration{endpoint:search}': ['p(95)<200'],
    // §20 SLO: /v1/cards/{id}/prices under 300 ms p95.
    'http_req_duration{endpoint:prices}': ['p(95)<300'],
    // A fast error is not a pass.
    checks: ['rate>0.99'],
  },
};

/** One page of ids to ask about, fetched once per VU rather than per iteration. */
let ids = [];

function loadIds() {
  if (ids.length > 0) return;
  const response = http.get(`${BASE}/v1/cards?limit=50`, { tags: { endpoint: 'setup' } });
  const body = response.json();
  ids = (body.items || []).map((item) => item.id).filter(Boolean);
}

export function search() {
  const term = TERMS[Math.floor(Math.random() * TERMS.length)];
  const response = http.get(`${BASE}/v1/cards?q=${encodeURIComponent(term)}&limit=20`, {
    tags: { endpoint: 'search' },
  });
  check(response, { 'search answered 200': (r) => r.status === 200 });
}

export function prices() {
  loadIds();
  if (ids.length === 0) return;
  const id = ids[Math.floor(Math.random() * ids.length)];
  const response = http.get(`${BASE}/v1/cards/${id}/prices`, { tags: { endpoint: 'prices' } });
  // 404 is a legitimate answer for a variant with no published index, and still has to be
  // fast — an endpoint that is quick only when it finds something is not quick.
  check(response, { 'prices answered': (r) => r.status === 200 || r.status === 404 });
}
