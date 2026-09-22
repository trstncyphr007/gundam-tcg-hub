import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { app } from './catalog.js';

/**
 * Better Auth tables (plan ADR-005). Property names must match Better Auth's field names;
 * column names stay snake_case. No password column exists: sign-in is OAuth or magic link
 * only (SR-X.1).
 */
export const userRole = app.enum('user_role', ['user', 'creator', 'seller', 'admin']);

export const users = app.table(
  'users',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    /** Elevated roles are admin-granted only; `input: false` keeps clients from setting it. */
    role: userRole('role').notNull().default('user'),
    /** Public-facing name; never expose email in public views (SR-X.24, SR-3.8). */
    displayName: text('display_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
);

export const sessions = app.table(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /**
     * Where the sign-in came from — as a hash under that day's key, never the address
     * (SR-X.24, ADR-028). Same network, same day: same value. Nothing more can be read from
     * it. The name is Better Auth's; the content is ours, set by the session-create hook,
     * and the check below refuses anything else. (An earlier comment here said Better Auth
     * truncated the address. It did not; it stored it whole.)
     */
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    /**
     * How this session was opened (SR-1.10, ADR-025): `passkey`, `magic_link` or `discord`.
     *
     * Set on the server by the hook that runs when a session is created, from *which endpoint*
     * created it — never from anything the client sent. Admin routes require `passkey`, which
     * is what makes the admin gate multi-factor rather than merely recent. Null for sessions
     * that predate this column: unknown, and treated as not a passkey.
     */
    authMethod: text('auth_method'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sessions_token_key').on(t.token),
    index('sessions_user_idx').on(t.userId),
    index('sessions_expires_idx').on(t.expiresAt),
    check(
      'sessions_auth_method_known',
      sql`${t.authMethod} is null or ${t.authMethod} in ('passkey', 'magic_link', 'discord')`,
    ),
    // A raw address written by a future bug, a library upgrade or a hand-run script fails
    // here instead of sitting in the table.
    check(
      'sessions_ip_hashed',
      sql`${t.ipAddress} is null or ${t.ipAddress} ~ '^iph1:[0-9]{4}-[0-9]{2}-[0-9]{2}:[A-Za-z0-9_-]{22}$'`,
    ),
  ],
);

/**
 * WebAuthn credentials (SR-X.3, SR-1.10). Property names match the Better Auth passkey plugin.
 *
 * Nothing here is secret — `publicKey` is a *public* key, and a credential cannot be used
 * without the authenticator holding the private half. The sensitive operations are adding
 * and removing a row, which the auth layer guards (ADR-025), not reading one.
 */
export const passkeys = app.table(
  'passkeys',
  {
    id: text('id').primaryKey(),
    /** A label the user chose, e.g. "MacBook Touch ID". Shown on their security page. */
    name: text('name'),
    publicKey: text('public_key').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialID: text('credential_id').notNull(),
    /** Signature counter; a counter going backwards is how a cloned authenticator shows up. */
    counter: integer('counter').notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull(),
    transports: text('transports'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    aaguid: text('aaguid'),
  },
  (t) => [
    uniqueIndex('passkeys_credential_id_key').on(t.credentialID),
    index('passkeys_user_idx').on(t.userId),
    check('passkeys_counter_non_negative', sql`${t.counter} >= 0`),
  ],
);

/**
 * The devices an account has signed in from, coarsely named: "Chrome on Windows" (ADR-026).
 *
 * Exists so a sign-in from somewhere new can be told to the owner (SR-X.5). It cannot be
 * derived from `sessions`, which forgets: signing out deletes the row, so the next sign-in
 * from the same laptop would look new every time, and a notice that always fires is one
 * people learn to ignore.
 *
 * The name is a label the owner reads, not a fingerprint: no versions, no IP, nothing that
 * would identify a device across accounts (SR-X.24).
 */
export const signInDevices = app.table(
  'sign_in_devices',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    device: text('device').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.device] }),
    check('sign_in_devices_device_short', sql`length(${t.device}) between 1 and 64`),
  ],
);

export const accounts = app.table(
  'accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    idToken: text('id_token'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('accounts_provider_account_key').on(t.providerId, t.accountId),
    index('accounts_user_idx').on(t.userId),
  ],
);

export const verifications = app.table(
  'verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    /** Single-use magic-link/OTP material; rows are deleted once consumed (SR-X.2). */
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('verifications_identifier_idx').on(t.identifier),
    index('verifications_expires_idx').on(t.expiresAt),
  ],
);
