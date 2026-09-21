import type { BrowserContext, CDPSession, Page } from '@playwright/test';

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
      // The decoded `Text` field, not the raw response. Mailpit's JSON escapes an ampersand
      // as a unicode escape (backslash, u, 0026), and a regex over the raw body stopped at
      // that backslash — cutting every link off after its token and silently dropping
      // `callbackURL`. Nothing noticed until a test needed the redirect itself.
      const { Text: text = '' } = (await message.json()) as { Text?: string };
      const match = /https?:\/\/\S+\/api\/auth\/magic-link\/verify\?\S+/.exec(text);
      if (match) {
        // The link points at the API origin. Follow it on the origin the test is using, so
        // the proxy sets the cookie there — 127.0.0.1 for most suites, localhost for the
        // passkey ones (WebAuthn does not allow an IP address as a relying party).
        const link = new URL(match[0]);
        const site = new URL(page.url());
        link.protocol = site.protocol;
        link.host = site.host;
        return link.toString();
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error('no magic link arrived in Mailpit');
}

/** Subjects of every message currently in Mailpit, newest first. */
export async function mailboxSubjects(page: Page): Promise<string[]> {
  const list = await page.request.get(`${MAILPIT}/api/v1/messages?limit=20`);
  const body = (await list.json()) as { messages?: { Subject?: string }[] };
  return (body.messages ?? []).map((m) => String(m.Subject));
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

// --------------------------------------------------------------------------------------- //
// Passkeys (ADR-025)
// --------------------------------------------------------------------------------------- //

/**
 * The passkey suites run on localhost: WebAuthn forbids an IP address as a relying party, so
 * the 127.0.0.1 the rest of the suite uses cannot hold a passkey at all.
 */
export const PASSKEY_BASE_URL =
  process.env['PLAYWRIGHT_PASSKEY_BASE_URL'] ?? 'http://localhost:3000';

export interface VirtualAuthenticator {
  client: CDPSession;
  authenticatorId: string;
}

/**
 * Attach Chrome's virtual authenticator to this page (via the DevTools protocol).
 *
 * `verifies` decides whether it performs user verification. A verifying one behaves like a
 * laptop's fingerprint reader; a non-verifying one like a bare security key tapped with no
 * PIN — which sends UV=0, and which the server must refuse (ADR-025).
 */
export async function addVirtualAuthenticator(
  page: Page,
  options: { verifies: boolean },
): Promise<VirtualAuthenticator> {
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable');
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: options.verifies,
      isUserVerified: options.verifies,
      automaticPresenceSimulation: true,
    },
  });
  return { client, authenticatorId };
}

/** Unplug a virtual authenticator, e.g. to enrol a second passkey on a different "device". */
export async function removeVirtualAuthenticator(auth: VirtualAuthenticator): Promise<void> {
  await auth.client.send('WebAuthn.removeVirtualAuthenticator', {
    authenticatorId: auth.authenticatorId,
  });
}

/** A credential as Chrome's DevTools protocol represents it, private key included. */
interface Credential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
}

/** The credentials a virtual authenticator holds, private keys included. */
export async function exportCredentials(auth: VirtualAuthenticator): Promise<Credential[]> {
  const { credentials } = await auth.client.send('WebAuthn.getCredentials', {
    authenticatorId: auth.authenticatorId,
  });
  return credentials;
}

/** Put a previously exported credential onto a (new) virtual authenticator. */
export async function importCredential(
  auth: VirtualAuthenticator,
  credential: Credential,
): Promise<void> {
  await auth.client.send('WebAuthn.addCredential', {
    authenticatorId: auth.authenticatorId,
    credential,
  });
}

const passkeyCredentials = new Map<string, Credential>();
const passkeySessions = new Map<string, Cookies>();

/**
 * Put an account's already-enrolled passkey on a fresh virtual authenticator for this page.
 * Fails loudly if the account has not enrolled one earlier in the run.
 */
export async function restorePasskey(page: Page, email: string): Promise<VirtualAuthenticator> {
  const known = passkeyCredentials.get(email);
  if (!known) throw new Error(`no passkey enrolled for ${email} earlier in this run`);
  const auth = await addVirtualAuthenticator(page, { verifies: true });
  await importCredential(auth, known);
  return auth;
}

/**
 * Sign in with a passkey, enrolling one the first time (ADR-025).
 *
 * The first call for an account does the whole journey a person would: email link, security
 * page, add a passkey, then sign in *with* it — and keeps the credential (private key and all)
 * so later tests can put it back on a fresh virtual authenticator. Global setup deletes the
 * account's passkeys before each run, so the server and this cache always agree.
 */
export async function signInWithPasskey(page: Page, email: string): Promise<VirtualAuthenticator> {
  const auth = await addVirtualAuthenticator(page, { verifies: true });
  const known = passkeyCredentials.get(email);

  if (known) {
    await importCredential(auth, known);
  } else {
    await signIn(page, email);
    await page.goto('/account/security');
    await page.getByTestId('passkey-name').fill('E2E virtual authenticator');
    await page.getByTestId('add-passkey').click();
    await page.getByTestId('passkey-added').waitFor();
    const [credential] = await exportCredentials(auth);
    if (!credential)
      throw new Error('the virtual authenticator holds no credential after enrolment');
    passkeyCredentials.set(email, credential);
  }

  // A passkey session, not the email one: sign out of that first by starting clean.
  await page.context().clearCookies();
  await asNewClient(page);
  await page.goto('/sign-in');
  await page.getByTestId('passkey-sign-in').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
  passkeySessions.set(email, await page.context().cookies());
  // Keep the copy that has just signed: its counter is now the one the server stored. Putting
  // the enrolment-time copy back later would replay an old counter, which the server rightly
  // refuses as a possible clone.
  await rememberPasskey(auth, email);
  return auth;
}

/** Re-export an account's credential after it has signed, so its counter stays current. */
export async function rememberPasskey(auth: VirtualAuthenticator, email: string): Promise<void> {
  const [credential] = await exportCredentials(auth);
  if (credential) passkeyCredentials.set(email, credential);
}

/** Reuse a passkey session opened earlier in the run, or open one. */
export async function signInWithPasskeyOnce(page: Page, email: string): Promise<void> {
  const cached = passkeySessions.get(email);
  if (cached) {
    await asNewClient(page);
    await page.context().addCookies(cached);
    return;
  }
  await signInWithPasskey(page, email);
}

/** Forget cached passkey sessions for an account, e.g. after a test aged them. */
export function forgetPasskeySession(email: string): void {
  passkeySessions.delete(email);
}
