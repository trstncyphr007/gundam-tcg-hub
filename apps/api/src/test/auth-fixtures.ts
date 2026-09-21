/**
 * The WebAuthn relying party the API tests run as.
 *
 * `localhost`, matching the development default: WebAuthn forbids an IP address as an RP ID,
 * so this cannot be the 127.0.0.1 the rest of the test harness uses.
 */
export const TEST_PASSKEY = {
  rpID: 'localhost',
  rpName: 'Gundam TCG Hub (test)',
  origin: 'http://localhost:3000',
} as const;
