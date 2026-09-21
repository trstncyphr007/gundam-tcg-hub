import { passkey } from '@better-auth/passkey';
import { type Database, countPasskeys, schema } from '@gth/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { magicLink } from 'better-auth/plugins/magic-link';
import {
  PasskeyPolicyError,
  assertionFlags,
  authMethodForPath,
  registrationFlags,
  requireVerifiedUser,
} from './passkeys.js';

export interface AuthConfig {
  /** Public origin of the API, used to build callback URLs. */
  baseURL: string;
  /** >=32 bytes of CSPRNG output; signs session tokens (SR-X.16). */
  secret: string;
  /** Origins allowed to start an auth flow (CSRF defence, SR-1.8). */
  trustedOrigins: string[];
  production: boolean;
  /**
   * Read the client IP from X-Forwarded-For. Only true when we sit behind our own proxy
   * (Caddy/Cloudflare): otherwise the header is attacker-controlled. Without it, everyone
   * behind the proxy shares one IP and per-IP rate limits become a single global bucket.
   */
  trustProxyHeaders: boolean;
  discord?: { clientId: string; clientSecret: string } | undefined;
  /** Delivers the sign-in link. Tests capture it; dev uses Mailpit. */
  sendMagicLink: (args: { email: string; url: string }) => Promise<void>;
  /**
   * WebAuthn relying party (ADR-025). `rpID` is a bare domain — never an IP address, which
   * WebAuthn forbids — and `origin` is where the ceremony runs: the *site*, not the API.
   */
  passkey: { rpID: string; rpName: string; origin: string };
  /**
   * Tell someone their sign-in methods changed (SR-X.5). A passkey added by somebody else is a
   * new way into the account, and the owner hearing about it at once is the only defence that
   * still works after the fact. Optional so tests can capture it; a failure is swallowed, not
   * fatal, because the change itself already happened.
   */
  sendSecurityNotice?:
    | ((args: { email: string; event: 'passkey_added' | 'passkey_removed' }) => Promise<void>)
    | undefined;
}

/** Session lifetimes (SR-1.7): 30-day absolute, refreshed at most once a day. */
const SESSION_EXPIRES_IN_S = 60 * 60 * 24 * 30;
const SESSION_UPDATE_AGE_S = 60 * 60 * 24;
const MAGIC_LINK_EXPIRES_IN_S = 60 * 15;

/**
 * How recent a sign-in must be to add or remove a passkey (SR-5.4's ten minutes).
 *
 * Better Auth's `freshAge`, which its own registration endpoint enforces, and which the removal
 * hook below enforces too. Ten minutes rather than the previous hour: changing how an account
 * can be entered is the most sensitive thing a session can do.
 */
export const PASSKEY_CHANGE_MAX_AGE_S = 60 * 10;

const REGISTRATION_PATHS = new Set([
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
]);

/**
 * Field access on an untrusted request body, without trusting its shape.
 *
 * Own enumerable properties only, via `Object.entries`: a body cannot reach `__proto__` or an
 * inherited property through this, whatever keys it arrives with.
 */
function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = new Map(Object.entries(current)).get(key);
  }
  return current;
}

/** A policy refusal as Better Auth's own error, so the client sees an ordinary failure. */
function refuse(error: PasskeyPolicyError): APIError {
  const status =
    error.code === 'passkey_session_required' || error.code === 'session_not_fresh'
      ? 'FORBIDDEN'
      : 'BAD_REQUEST';
  return new APIError(status, { code: error.code.toUpperCase(), message: error.message });
}

export function createAuth(db: Database, config: AuthConfig) {
  return betterAuth({
    appName: 'gundam-tcg-hub',
    baseURL: config.baseURL,
    basePath: '/api/auth',
    secret: config.secret,
    trustedOrigins: config.trustedOrigins,

    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
        passkey: schema.passkeys,
      },
    }),

    // No passwords anywhere (SR-X.1): Discord OAuth, a one-time email link, or a passkey.
    emailAndPassword: { enabled: false },

    ...(config.discord
      ? {
          socialProviders: {
            discord: {
              clientId: config.discord.clientId,
              clientSecret: config.discord.clientSecret,
              // Minimum scopes: identify + email only (FR-1.10).
              scope: ['identify', 'email'],
            },
          },
        }
      : {}),

    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_EXPIRES_IN_S,
        disableSignUp: false,
        sendMagicLink: async ({ email, url }) => {
          await config.sendMagicLink({ email, url });
        },
      }),
      passkey({
        rpID: config.passkey.rpID,
        rpName: config.passkey.rpName,
        origin: config.passkey.origin,
        authenticatorSelection: {
          // Discoverable where the device supports it, so "sign in with a passkey" needs no
          // email first. And *required* user verification — which the browser is asked for
          // here, and which the before-hook then insists on, because the plugin's own
          // verification does not (see passkeys.ts).
          residentKey: 'preferred',
          userVerification: 'required',
        },
      }),
    ],

    session: {
      expiresIn: SESSION_EXPIRES_IN_S,
      updateAge: SESSION_UPDATE_AGE_S,
      freshAge: PASSKEY_CHANGE_MAX_AGE_S,
      additionalFields: {
        // Server-set from the endpoint that created the session; never accepted as input.
        authMethod: { type: 'string', required: false, input: false },
      },
    },

    user: {
      additionalFields: {
        // Server-controlled: a client must never be able to promote itself (SR-X.9).
        role: { type: 'string', defaultValue: 'user', input: false },
        displayName: { type: 'string', required: false, input: true },
      },
    },

    hooks: {
      /**
       * Passkey policy the plugin does not enforce itself (ADR-025).
       *
       * Runs before the plugin's handler, so a refusal here means the plugin never sees the
       * request. Everything read from the body is re-verified by the plugin afterwards — the
       * flags are inside signed data — so this only ever says "no" earlier, never "yes".
       */
      before: createAuthMiddleware(async (ctx) => {
        try {
          if (ctx.path === '/passkey/verify-authentication') {
            requireVerifiedUser(
              assertionFlags(field(ctx.body, 'response', 'response', 'authenticatorData')),
            );
            return;
          }

          if (REGISTRATION_PATHS.has(ctx.path)) {
            const session = await getSessionFromCtx(ctx);
            if (session) {
              // The first passkey can be added by a fresh email or Discord sign-in — there is
              // no other way to begin. Every one after that needs a session opened *with* a
              // passkey, or whoever can read the inbox could add their own and pass the admin
              // gate as the owner.
              const existing = await countPasskeys(db, session.user.id);
              const method = (session.session as { authMethod?: unknown }).authMethod;
              if (existing > 0 && method !== 'passkey') {
                throw new PasskeyPolicyError(
                  'passkey_session_required',
                  'to add another passkey, sign in with one you already have',
                );
              }
            }
            if (ctx.path === '/passkey/verify-registration') {
              requireVerifiedUser(
                registrationFlags(field(ctx.body, 'response', 'response', 'attestationObject')),
              );
            }
            return;
          }

          if (ctx.path === '/passkey/delete-passkey') {
            // The plugin guards removal with an ordinary session. That is not enough: removing
            // the last passkey reopens the "add the first by email" path, so an inbox alone
            // could delete the owner's passkey, enrol its own, and pass the admin gate. Removal
            // is held to the same rule as adding a second one — a passkey session — and to
            // freshness on top.
            const session = await getSessionFromCtx(ctx);
            if (!session) return;
            const method = (session.session as { authMethod?: unknown }).authMethod;
            if (method !== 'passkey') {
              throw new PasskeyPolicyError(
                'passkey_session_required',
                'to remove a passkey, sign in with a passkey first',
              );
            }
            const created = new Date(session.session.createdAt).getTime();
            if (Date.now() - created > PASSKEY_CHANGE_MAX_AGE_S * 1000) {
              throw new PasskeyPolicyError(
                'session_not_fresh',
                'sign in again (within ten minutes) to remove a passkey',
              );
            }
          }
        } catch (error) {
          if (error instanceof PasskeyPolicyError) throw refuse(error);
          throw error;
        }
      }),

      /** Audit and notify on any change to how an account can be entered (SR-X.5, SR-X.21). */
      after: createAuthMiddleware(async (ctx) => {
        const event =
          ctx.path === '/passkey/verify-registration'
            ? 'passkey_added'
            : ctx.path === '/passkey/delete-passkey'
              ? 'passkey_removed'
              : null;
        if (event === null) return;
        // Only on success: a refused or failed request changed nothing worth reporting.
        if (ctx.context.returned instanceof Error) return;

        const session = ctx.context.session ?? (await getSessionFromCtx(ctx));
        if (!session) return;

        await db
          .insert(schema.auditLog)
          .values({
            actorId: session.user.id,
            action: `auth.${event}`,
            targetType: 'user',
            targetId: session.user.id,
          })
          .catch(() => undefined);

        await config
          .sendSecurityNotice?.({ email: session.user.email, event })
          .catch(() => undefined);
      }),
    },

    advanced: {
      ipAddress: {
        ipAddressHeaders: config.trustProxyHeaders ? ['x-forwarded-for'] : [],
        disableIpTracking: false,
      },
      useSecureCookies: config.production,
      // __Host- requires Secure + Path=/ + no Domain, so it can only be used over HTTPS.
      cookiePrefix: config.production ? '__Host-gth' : 'gth',
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      },
    },

    databaseHooks: {
      // Security-relevant auth events go to the append-only audit log (SR-X.21).
      user: {
        create: {
          after: async () => {
            await db
              .insert(schema.auditLog)
              .values({ actorId: null, action: 'auth.user.created', targetType: 'user' })
              .catch(() => undefined);
          },
        },
      },
      session: {
        create: {
          // Record how the session was opened, from the endpoint doing the opening. The one
          // place `authMethod` is ever written, and it reads nothing the client sent.
          before: (session, context) =>
            Promise.resolve({
              data: { ...session, authMethod: authMethodForPath(context?.path) },
            }),
          after: async (session) => {
            await db
              .insert(schema.auditLog)
              .values({
                actorId: null,
                action: 'auth.session.created',
                targetType: 'session',
                targetId: session.userId,
              })
              .catch(() => undefined);
          },
        },
      },
    },

    // Built-in limiter (in-memory for a single instance; Valkey when we scale, SR-1.9).
    rateLimit: {
      enabled: true,
      window: 60,
      max: 60,
      customRules: {
        '/sign-in/magic-link': { window: 60, max: 5 },
        '/magic-link/verify': { window: 60, max: 10 },
        '/sign-in/social': { window: 60, max: 10 },
        // Assertions are cheap to attempt and each one is a guess at a credential.
        '/passkey/verify-authentication': { window: 60, max: 10 },
        '/passkey/verify-registration': { window: 60, max: 5 },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
