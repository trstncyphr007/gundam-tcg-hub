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
});

export type ApiConfig = z.infer<typeof apiEnvSchema>;

export function loadConfig(source: Record<string, string | undefined> = process.env): ApiConfig {
  return parseEnv(apiEnvSchema, source);
}
