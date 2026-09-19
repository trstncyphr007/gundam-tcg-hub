import { type Database, schema } from '@gth/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins/magic-link';

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
}

/** Session lifetimes (SR-1.7): 30-day absolute, refreshed at most once a day. */
const SESSION_EXPIRES_IN_S = 60 * 60 * 24 * 30;
const SESSION_UPDATE_AGE_S = 60 * 60 * 24;
const MAGIC_LINK_EXPIRES_IN_S = 60 * 15;

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
      },
    }),

    // No passwords anywhere (SR-X.1): Discord OAuth or a one-time email link.
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
    ],

    session: {
      expiresIn: SESSION_EXPIRES_IN_S,
      updateAge: SESSION_UPDATE_AGE_S,
      freshAge: 60 * 60, // re-auth window for sensitive actions (step-up, SR-5.4)
    },

    user: {
      additionalFields: {
        // Server-controlled: a client must never be able to promote itself (SR-X.9).
        role: { type: 'string', defaultValue: 'user', input: false },
        displayName: { type: 'string', required: false, input: true },
      },
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
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
