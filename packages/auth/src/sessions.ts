import type { Subject } from './authorize.js';

type AuthMethod = Subject['authMethod'];

/**
 * May a session opened one way end a session opened another way? (ADR-026)
 *
 * The same ladder ADR-025 draws for passkeys: something only a passkey could have opened is
 * only closed by a passkey. Without it, whoever holds the inbox could sign the owner's
 * passkey session out — not a way in, but a way to keep the owner out of the admin console
 * for as long as they cared to keep clicking.
 *
 * Everything below a passkey session may be ended by any session on the account. That is the
 * point of the page: someone who spots a sign-in they do not recognise must be able to end it
 * from wherever they are, however they got there.
 */
export function mayRevoke(current: AuthMethod, target: AuthMethod): boolean {
  return target !== 'passkey' || current === 'passkey';
}
