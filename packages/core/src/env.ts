import { z } from 'zod';

/** Thrown when env vars fail validation. Messages name the variable, never its value. */
export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Validate environment variables against a zod schema and fail fast at boot (FR-0.7).
 * Error output lists variable names and rules only, so secrets never reach logs.
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => {
        const name = issue.path.map(String).join('.') || '(root)';
        return `${name}: ${issue.code}`;
      }),
    );
  }
  return result.data;
}

export const nodeEnvSchema = z.enum(['development', 'test', 'production']).default('development');

export const logLevelSchema = z
  .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  .default('info');

export const portSchema = z.coerce.number().int().min(1).max(65535);

export const booleanStringSchema = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');
