import { createApiKey, createDb } from '@gth/db';
import { generateToken, hashToken } from '@gth/security';
import { expect, test } from '@playwright/test';
import { clearMailbox, signIn } from './helpers';

/**
 * AC-1.1, the acceptance criterion Phase 1 exists for: a box comes back in stock and the
 * person who asked to be told is told — once.
 *
 * Every piece of this chain had tests. The chain itself did not, and the pieces were tested
 * with a stub in place of the mail server, so "an email is sent" meant "a function was
 * called". The words in the subject line appeared nowhere but the source file.
 *
 * This drives the whole thing through the real parts: a real sign-in, the Watch button in a
 * real browser, a real HTTP call to the ingest endpoint with a real API key, a real SMTP
 * delivery, and a real mailbox read back over Mailpit's API. Nothing here is a mock.
 */
const MAILPIT = process.env['MAILPIT_URL'] ?? 'http://127.0.0.1:8025';
const API = process.env['API_BASE_URL'] ?? 'http://127.0.0.1:4000';

let scannerKey: string;
let listingId: string;

test.beforeAll(async () => {
  const url = process.env['DATABASE_URL_MIGRATOR'];
  if (!url) throw new Error('DATABASE_URL_MIGRATOR is required');
  const { db, close } = createDb({ url, max: 1 });
  try {
    // The scanner's own credential, minted the way an operator would at the CLI: no owner,
    // ingest scope, and a secret that exists only for this run.
    const prefix = `e2e${Date.now().toString(36).slice(-5)}`;
    const secret = generateToken(32);
    const pepper = process.env['TOKEN_PEPPER'];
    if (!pepper) throw new Error('TOKEN_PEPPER is required');
    await createApiKey(db, {
      name: 'e2e restock scanner',
      prefix,
      keyHash: hashToken(secret, pepper),
      scopes: ['ingest:write'],
    });
    scannerKey = `gth_test_${prefix}_${secret}`;

    const rows = await db.execute<{ id: string }>(`select id from app.retailer_products limit 1`);
    listingId = String(rows[0]?.id);
  } finally {
    await close();
  }
});

/** What the scanner sends. */
async function reportStock(
  request: import('@playwright/test').APIRequestContext,
  inStock: boolean,
): Promise<void> {
  const response = await request.post(`${API}/v1/ingest/stock`, {
    headers: { authorization: `Bearer ${scannerKey}` },
    data: { reports: [{ retailerProductId: listingId, inStock, priceCents: 9999 }] },
  });
  expect(response.status(), await response.text()).toBe(202);
}

/**
 * Restock emails addressed to one person.
 *
 * Filtered by recipient on purpose. Earlier runs leave their watchers behind, so one restock
 * legitimately reaches several mailboxes — the feature working — and an earlier version of
 * this test counted somebody else's mail as a duplicate of its own.
 */
async function restockEmails(
  request: import('@playwright/test').APIRequestContext,
  recipient: string,
): Promise<{ ID: string; Subject: string }[]> {
  const list = await request.get(`${MAILPIT}/api/v1/messages?limit=200`);
  const body = (await list.json()) as {
    messages: { ID: string; Subject: string; To: { Address: string }[] }[];
  };
  return body.messages.filter(
    (m) =>
      m.Subject.startsWith('Back in stock:') &&
      m.To.some((to) => to.Address.toLowerCase() === recipient.toLowerCase()),
  );
}

test.describe('a restock reaches the person who asked (AC-1.1)', () => {
  test('watch a product, and the email arrives once, saying where to go', async ({
    page,
    request,
  }) => {
    const watcher = `restock-${String(Date.now())}@example.com`;
    await signIn(page, watcher);

    // Through the UI, because a watch created by an insert would not prove the button works.
    await page.goto('/products');
    await page.getByRole('button', { name: 'Watch' }).first().click();
    await expect(page.getByRole('button', { name: 'Watching' }).first()).toBeVisible();

    // The sign-in link is in the mailbox too. Clear it so what is left is the alert itself.
    await clearMailbox(page);

    // Out of stock, then back: the transition is the event, not the state (FR-1.7).
    await reportStock(request, false);
    await reportStock(request, true);

    await expect
      .poll(async () => (await restockEmails(request, watcher)).length, { timeout: 15_000 })
      .toBe(1);

    const [summary] = await restockEmails(request, watcher);
    const detail = await request.get(`${MAILPIT}/api/v1/message/${String(summary?.ID)}`);
    const mail = (await detail.json()) as { Subject: string; Text: string };

    // What the reader actually needs: which product, where to buy it, and at what price.
    expect(mail.Subject).toContain('Sample Set One Booster Box');
    expect(mail.Text).toContain('Sample Retailer');
    expect(mail.Text).toMatch(/https?:\/\//);
    expect(mail.Text).toContain('99.99');

    // An unsubscribe header, checked on the message as it was actually sent (SR-1.12). A
    // header the code sets and the mail server drops is the same as no header at all.
    //
    // Note what this does *not* yet prove: the link points at the watches page, which asks
    // the reader to sign in. That is a place to unsubscribe, not one-click unsubscribing —
    // RFC 8058 wants a `List-Unsubscribe-Post` and a link that works without a session, and
    // Gmail now expects it of anyone sending in bulk. Worth its own change, with thought
    // given to what unsubscribing from one alert should mean.
    const raw = await request.get(`${MAILPIT}/api/v1/message/${String(summary?.ID)}/raw`);
    const headers = (await raw.text()).split('\r\n\r\n')[0] ?? '';
    expect(headers).toContain('List-Unsubscribe:');

    // A second report of the same state must not produce a second email. The unique index on
    // (event, subscription, channel) is the guard, and this is the proof that it holds all the
    // way out to the mailbox rather than only in the table.
    await reportStock(request, true);
    await page.waitForTimeout(2000);
    expect(await restockEmails(request, watcher)).toHaveLength(1);
  });
});
