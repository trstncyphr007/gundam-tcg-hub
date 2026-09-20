import type { BrowserContext, Page } from '@playwright/test';

const MAILPIT = process.env['MAILPIT_URL'] ?? 'http://127.0.0.1:8025';

interface MailpitMessage {
  ID: string;
}

/** Pull the newest sign-in link out of Mailpit (the local mail catcher). */
export async function fetchLatestMagicLink(page: Page): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const list = await page.request.get(`${MAILPIT}/api/v1/messages?limit=1`);
    const body = (await list.json()) as { messages?: MailpitMessage[] };
    const id = body.messages?.[0]?.ID;
    if (id) {
      const message = await page.request.get(`${MAILPIT}/api/v1/message/${id}`);
      const text = await message.text();
      const match = /https?:\/\/[^\s"\\]+\/api\/auth\/magic-link\/verify\?[^\s"\\]+/.exec(text);
      if (match) {
        // The link points at the API origin; use the web origin so the proxy sets the cookie.
        return match[0].replace('127.0.0.1:4000', '127.0.0.1:3000');
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error('no magic link arrived in Mailpit');
}

export async function clearMailbox(page: Page): Promise<void> {
  await page.request.delete(`${MAILPIT}/api/v1/messages`);
}

let clientIpCounter = 0;

/**
 * Act as a distinct client. Sign-in links are rate limited per IP (5/min), and every test
 * here shares one machine, so without this the suite would trip a real security control.
 * Mirrors production, where the proxy sets the client IP for each visitor.
 */
export async function asNewClient(page: Page): Promise<void> {
  clientIpCounter += 1;
  await page.context().setExtraHTTPHeaders({
    'x-forwarded-for': `203.0.113.${String(clientIpCounter % 250)}`,
  });
}

type Cookies = Awaited<ReturnType<BrowserContext['cookies']>>;

const sessions = new Map<string, Cookies>();

/**
 * Sign in once per account, then reuse the session.
 *
 * Sign-in links are rate limited to five a minute **per account identifier** (SR-1.9), which
 * is a real control we want. A suite whose every test signs in as the same seeded account
 * trips it, and then fails somewhere unrelated with "you need to sign in" — the control
 * working, looking like a bug.
 *
 * The full form → email → link journey is still exercised end to end by the sign-in suite;
 * repeating it before every test proved nothing extra and cost the run its reliability.
 */
export async function signInOnce(page: Page, email: string): Promise<void> {
  const cached = sessions.get(email);
  if (cached) {
    // Still a new client: reusing the session must not also mean reusing the IP. Every
    // endpoint is rate limited per IP, and a whole suite arriving from one address
    // eventually gets 429s that surface as "you need to sign in" — the API refusing, the
    // page unable to tell that apart from a missing session.
    await asNewClient(page);
    await page.context().addCookies(cached);
    return;
  }
  await signIn(page, email);
  sessions.set(email, await page.context().cookies());
}

/** Complete a full sign-in the way a person would: form → email → link. */
export async function signIn(page: Page, email: string): Promise<void> {
  await asNewClient(page);
  await clearMailbox(page);
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: /email me a sign-in link/i }).click();
  await page.getByText(/check your email/i).waitFor();
  const link = await fetchLatestMagicLink(page);
  await page.goto(link);
}
