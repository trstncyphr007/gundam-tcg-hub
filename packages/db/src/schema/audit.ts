import { sql } from 'drizzle-orm';
import { index, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { app } from './catalog.js';

/**
 * Append-only audit trail (SR-X.21). UPDATE/DELETE are revoked from the app roles in the
 * migration, so history cannot be rewritten by the application.
 */
export const auditLog = app.table(
  'audit_log',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Text, not uuid: auth user ids are opaque strings (see schema/auth.ts). */
    actorId: text('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    /** Hashed, never raw: PII minimisation (SR-X.24). */
    ipHash: text('ip_hash'),
    uaHash: text('ua_hash'),
    diff: jsonb('diff'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_at_idx').on(t.at.desc()), index('audit_log_actor_idx').on(t.actorId)],
);
