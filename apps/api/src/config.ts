import {
  booleanStringSchema,
  logLevelSchema,
  nodeEnvSchema,
  parseEnv,
  portSchema,
} from '@gth/core';
import { z } from 'zod';

const apiEnvSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  LOG_LEVEL: logLevelSchema,
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: portSchema.default(4000),
  // Only true behind our own reverse proxy (Caddy), otherwise X-Forwarded-For is spoofable.
  API_TRUST_PROXY: booleanStringSchema,
  API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  DATABASE_URL_READONLY: z
    .string()
    .startsWith('postgres', 'must be a postgres connection string')
    .default('postgres://app_readonly:change-me@127.0.0.1:5432/gth'),
  DATABASE_URL_WEB: z
    .string()
    .startsWith('postgres', 'must be a postgres connection string')
    .default('postgres://app_web:change-me@127.0.0.1:5432/gth'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

  // Auth (plan §10, FR-1.10). The secret must be >=32 chars of CSPRNG output (SR-X.16).
  API_BASE_URL: z.url().default('http://127.0.0.1:4000'),
  APP_BASE_URL: z.url().default('http://127.0.0.1:3000'),
  BETTER_AUTH_SECRET: z.string().min(32).default('dev-only-insecure-secret-change-me-32+'),
  DISCORD_CLIENT_ID: z.string().min(1).optional(),
  DISCORD_CLIENT_SECRET: z.string().min(1).optional(),
  SMTP_URL: z.string().startsWith('smtp').optional(),
  EMAIL_FROM: z.string().default('gundam-tcg-hub <no-reply@localhost>'),
});

export type ApiConfig = z.infer<typeof apiEnvSchema>;

export function loadConfig(source: Record<string, string | undefined> = process.env): ApiConfig {
  return parseEnv(apiEnvSchema, source);
}
