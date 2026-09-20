/**
 * Human-readable docs at /docs (FR-3.6), rendered from the OpenAPI document.
 *
 * Plain HTML with no JavaScript at all. Swagger UI and Scalar both want a script from a CDN,
 * which our own content-security policy forbids (SR-X.16), and vendoring either means
 * shipping and patching a megabyte of someone else's code to render six endpoints. The spec
 * itself is at /docs/openapi.json for anything that wants to generate a client.
 */

const ESCAPES = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&#39;'],
]);

/** Everything interpolated below goes through this, including our own descriptions. */
export function escapeHtml(value: unknown): string {
  return String(value).replaceAll(/[&<>"']/gu, (c) => ESCAPES.get(c) ?? c);
}

interface Operation {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: { name: string; in: string; required?: boolean; description?: string }[];
}

const STYLE = `
:root { color-scheme: dark; --bg:#0b0d10; --surface:#14171c; --border:#272c34;
        --text:#e6e8eb; --muted:#9aa4b2; --accent:#7dd3fc; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); line-height:1.6;
       font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 52rem; margin: 0 auto; padding: 3rem 1.25rem 6rem; }
h1 { font-size: 1.9rem; letter-spacing:-0.02em; margin:0 0 .25rem; }
h2 { font-size: 1.1rem; margin: 2.5rem 0 .75rem; }
p { color: var(--muted); }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .875rem; }
pre { background: var(--surface); border:1px solid var(--border); border-radius:.5rem;
      padding: .9rem 1rem; overflow-x:auto; }
.op { border:1px solid var(--border); background:var(--surface); border-radius:.5rem;
      padding:1rem 1.15rem; margin-bottom:.85rem; }
.op h3 { margin:0 0 .4rem; font-size:1rem; font-family: ui-monospace, monospace; }
.method { color: var(--accent); }
.op p { margin:.35rem 0 0; font-size:.9rem; }
table { border-collapse: collapse; width:100%; margin-top:.75rem; font-size:.85rem; }
th, td { text-align:left; padding:.35rem .6rem .35rem 0; vertical-align: top; }
th { color: var(--muted); font-weight:500; }
a { color: var(--accent); }
.note { border-left:2px solid var(--border); padding-left:1rem; }
`;

export function renderDocsPage(spec: Record<string, unknown>): string {
  const info = (spec['info'] ?? {}) as { title?: string; version?: string; description?: string };
  const paths = (spec['paths'] ?? {}) as Record<string, Record<string, Operation>>;
  const servers = (spec['servers'] ?? []) as { url?: string }[];
  const base = servers[0]?.url ?? '';

  const operations = Object.entries(paths)
    .map(([path, methods]) =>
      Object.entries(methods)
        .map(([method, op]) => {
          const params = op.parameters ?? [];
          const table =
            params.length === 0
              ? ''
              : `<table><tr><th>Parameter</th><th>In</th><th>Notes</th></tr>${params
                  .map(
                    (p) =>
                      `<tr><td><code>${escapeHtml(p.name)}</code>${
                        p.required === true ? ' *' : ''
                      }</td><td>${escapeHtml(p.in)}</td><td>${escapeHtml(
                        p.description ?? '',
                      )}</td></tr>`,
                  )
                  .join('')}</table>`;
          return `<div class="op">
  <h3><span class="method">${escapeHtml(method.toUpperCase())}</span> ${escapeHtml(path)}</h3>
  <p><strong>${escapeHtml(op.summary ?? '')}</strong></p>
  <p>${escapeHtml(op.description ?? '')}</p>
  ${table}
</div>`;
        })
        .join(''),
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(info.title ?? 'API')}</title>
<meta name="robots" content="noindex">
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>${escapeHtml(info.title ?? 'API')}</h1>
  <p>Version ${escapeHtml(info.version ?? '')} · <a href="/docs/openapi.json">OpenAPI 3.1 document</a></p>
  <p class="note">${escapeHtml(info.description ?? '')}</p>

  <h2>Authentication</h2>
  <p>Optional. Without a key you share an allowance with everyone at your IP address. With
  one you get your own, and we can tell you when something changes.</p>
  <pre>curl ${escapeHtml(base)}/v1/cards?q=gundam \\
  -H "Authorization: Bearer gth_live_xxxxxxxx_…"</pre>
  <p>Create a key at <code>/account/developer</code>. It is shown once. If you lose it,
  revoke it and make another — we cannot recover it, because we never stored it.</p>

  <h2>Rate limits</h2>
  <p>Every response carries <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code> and
  <code>RateLimit-Reset</code> (seconds). A 429 also carries <code>Retry-After</code>.
  The free tier is 60 requests a minute and 1,000 a day.</p>

  <h2>Paging</h2>
  <p>List endpoints return <code>{ items, nextCursor }</code>. Pass <code>nextCursor</code>
  back as <code>cursor</code>. There is no offset paging: it would skip or repeat rows when
  the catalog changes underneath you.</p>

  <h2>Caching</h2>
  <p>Responses carry an <code>ETag</code>. Send it back as <code>If-None-Match</code> and a
  304 costs you nothing against your quota's usefulness — and nothing to transfer.</p>

  <h2>Endpoints</h2>
  ${operations}

  <h2>Prices</h2>
  <p>An empty <code>points</code> array means the index has nothing to say about that card —
  not that it is worthless. Nothing is published below three observations. The method is
  written up at <a href="/methodology">/methodology</a>.</p>
</main>
</body>
</html>`;
}
