import { expect, test } from '@playwright/test';
import {
  PASSKEY_BASE_URL,
  type VirtualAuthenticator,
  addVirtualAuthenticator,
  asNewClient,
  clearMailbox,
  exportCredentials,
  importCredential,
  mailboxSubjects,
  removeVirtualAuthenticator,
  signIn,
} from './helpers';

/**
 * Passkeys end to end, with Chrome's virtual authenticator doing real WebAuthn (ADR-025).
 *
 * Serial, on one account that global setup leaves with no passkeys: each test builds on the
 * last, the way a person's account would.
 */
test.use({ baseURL: PASSKEY_BASE_URL });
test.describe.configure({ mode: 'serial' });

const EMAIL = 'passkey-user@example.test';

/**
 * The credential enrolled in the first test, carried to the rest — and re-exported after each
 * sign-in, because its signature counter moves on and the server refuses a replayed one.
 */
let enrolled: Awaited<ReturnType<typeof exportCredentials>>[number] | undefined;

async function keepCounter(auth: VirtualAuthenticator): Promise<void> {
  [enrolled] = await exportCredentials(auth);
}

test.describe('passkeys', () => {
  test('a fresh email sign-in can add the first passkey, and the owner is told', async ({
    page,
  }) => {
    const auth = await addVirtualAuthenticator(page, { verifies: true });
    await signIn(page, EMAIL);
    await clearMailbox(page);

    await page.goto('/account/security');
    await expect(page.getByTestId('no-passkeys')).toBeVisible();
    await page.getByTestId('passkey-name').fill('Test laptop');
    await page.getByTestId('add-passkey').click();

    await expect(page.getByTestId('passkey-added')).toBeVisible();
    await expect(page.getByTestId('passkey-row')).toHaveCount(1);
    await expect(page.getByTestId('passkey-row')).toContainText('Test laptop');

    // A new way into the account was just created; the owner hears about it at once (SR-X.5).
    await expect
      .poll(async () => mailboxSubjects(page))
      .toContain('A passkey was added to your account');

    [enrolled] = await exportCredentials(auth);
    expect(enrolled).toBeDefined();
  });

  test('signs in with the passkey, with no email at all', async ({ page }) => {
    if (!enrolled) throw new Error('first test did not enrol a passkey');
    const auth = await addVirtualAuthenticator(page, { verifies: true });
    await importCredential(auth, enrolled);
    await asNewClient(page);

    await page.goto('/sign-in?next=%2Faccount%2Fsecurity');
    await page.getByTestId('passkey-sign-in').click();
    await page.waitForURL('**/account/security');
    await keepCounter(auth);
    await expect(page.getByTestId('passkey-row')).toHaveCount(1);
  });

  test('will not add a second passkey to a session opened by email', async ({ page }) => {
    await addVirtualAuthenticator(page, { verifies: true });
    await signIn(page, EMAIL);
    await page.goto('/account/security');

    // Whoever can read the inbox gets exactly this session. Letting it add a passkey would
    // let them enrol their own and pass the admin gate as the owner.
    await page.getByTestId('add-passkey').click();
    await expect(page.getByTestId('passkey-problem')).toContainText('sign in with that one first');
    await expect(page.getByTestId('passkey-reauth')).toBeVisible();
    await expect(page.getByTestId('passkey-row')).toHaveCount(1);
  });

  test('adds a second passkey from a session opened with the first', async ({ page }) => {
    if (!enrolled) throw new Error('first test did not enrol a passkey');
    const auth = await addVirtualAuthenticator(page, { verifies: true });
    await importCredential(auth, enrolled);
    await asNewClient(page);
    await page.goto('/sign-in?next=%2Faccount%2Fsecurity');
    await page.getByTestId('passkey-sign-in').click();
    await page.waitForURL('**/account/security');
    await keepCounter(auth);

    // A second passkey lives on a second device. The first authenticator already holds a
    // credential for this account, and the server lists it in `excludeCredentials`, so
    // WebAuthn itself would refuse to enrol it twice — swap in a fresh one, like picking up a
    // phone.
    await removeVirtualAuthenticator(auth);
    await addVirtualAuthenticator(page, { verifies: true });
    await page.getByTestId('passkey-name').fill('Test phone');
    await page.getByTestId('add-passkey').click();
    await expect(page.getByTestId('passkey-row')).toHaveCount(2);
  });

  test('refuses a passkey that did not verify the person (SR-1.10)', async ({ page }) => {
    if (!enrolled) throw new Error('first test did not enrol a passkey');
    // The same real credential, on an authenticator that skips its PIN or biometric.
    //
    // Our own sign-in button cannot even produce this: it asks for a *discoverable*
    // credential, and Chrome's authenticator will not offer one without verification
    // (credProtect). A client that names the credential and asks for no verification gets
    // UV=0 back, signed — that is the request the server check exists for, so the test sends
    // exactly that, with real WebAuthn in the browser.
    const auth = await addVirtualAuthenticator(page, { verifies: false });
    await importCredential(auth, enrolled);
    await asNewClient(page);
    await page.goto('/sign-in');

    const verdict = await page.evaluate(async (credentialId) => {
      const bytes = (text: string): Uint8Array<ArrayBuffer> => {
        const b64 = text.replaceAll('-', '+').replaceAll('_', '/');
        const raw = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
        return Uint8Array.from(raw, (c) => c.charCodeAt(0));
      };
      const text = (buffer: ArrayBuffer): string =>
        btoa(String.fromCharCode(...new Uint8Array(buffer)))
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replace(/=+$/, '');

      const optionsResponse = await fetch('/api/auth/passkey/generate-authenticate-options');
      const options = (await optionsResponse.json()) as { challenge: string; rpId?: string };
      const credential = (await navigator.credentials.get({
        publicKey: {
          challenge: bytes(options.challenge),
          ...(options.rpId ? { rpId: options.rpId } : {}),
          allowCredentials: [{ type: 'public-key', id: bytes(credentialId) }],
          userVerification: 'discouraged',
        },
      })) as PublicKeyCredential;
      const assertion = credential.response as AuthenticatorAssertionResponse;
      const flags = new Uint8Array(assertion.authenticatorData)[32] ?? 0;

      const res = await fetch('/api/auth/passkey/verify-authentication', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          response: {
            id: credential.id,
            rawId: text(credential.rawId),
            type: credential.type,
            clientExtensionResults: {},
            response: {
              authenticatorData: text(assertion.authenticatorData),
              clientDataJSON: text(assertion.clientDataJSON),
              signature: text(assertion.signature),
            },
          },
        }),
      });
      return { flags, status: res.status, body: (await res.json()) as { code?: string } };
    }, enrolled.credentialId);

    // A genuine, correctly signed assertion from the right credential, present but unverified…
    expect(verdict.flags & 0x01).toBe(0x01);
    expect(verdict.flags & 0x04).toBe(0);
    // …and the server still says no, before any session exists.
    expect(verdict.status).toBe(400);
    expect(verdict.body.code).toBe('USER_VERIFICATION_REQUIRED');
    const cookies = await page.context().cookies();
    expect(cookies.some((c) => c.name.includes('session_token'))).toBe(false);
  });

  test('will not remove a passkey for a session opened by email', async ({ page }) => {
    await signIn(page, EMAIL);
    await page.goto('/account/security');
    await expect(page.getByTestId('passkey-row')).toHaveCount(2);

    // Removal reopens the "first passkey by email" path, so the inbox alone must not be
    // enough to clear the way for an attacker's own passkey.
    await page.getByTestId('remove-passkey').first().click();
    await expect(page.getByTestId('passkey-problem')).toContainText('sign in with a passkey first');
    await page.reload();
    await expect(page.getByTestId('passkey-row')).toHaveCount(2);
  });

  test('removes a passkey from a passkey session, and tells the owner', async ({ page }) => {
    if (!enrolled) throw new Error('first test did not enrol a passkey');
    const auth = await addVirtualAuthenticator(page, { verifies: true });
    await importCredential(auth, enrolled);
    await asNewClient(page);
    await clearMailbox(page);
    await page.goto('/sign-in?next=%2Faccount%2Fsecurity');
    await page.getByTestId('passkey-sign-in').click();
    await page.waitForURL('**/account/security');
    await keepCounter(auth);
    await expect(page.getByTestId('passkey-row')).toHaveCount(2);

    await page
      .getByTestId('passkey-row')
      .filter({ hasText: 'Test phone' })
      .getByTestId('remove-passkey')
      .click();
    await expect(page.getByTestId('passkey-row')).toHaveCount(1);
    await expect
      .poll(async () => mailboxSubjects(page))
      .toContain('A passkey was removed from your account');
  });
});
