import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  EnvValidationError,
  booleanStringSchema,
  logLevelSchema,
  nodeEnvSchema,
  parseEnv,
  portSchema,
} from './env.js';

const schema = z.object({
  NODE_ENV: nodeEnvSchema,
  LOG_LEVEL: logLevelSchema,
  PORT: portSchema.default(4000),
  TRUST_PROXY: booleanStringSchema,
  SECRET: z.string().min(32),
});

const validSecret = 'x'.repeat(32);

describe('parseEnv', () => {
  it('applies defaults and coerces types', () => {
    const env = parseEnv(schema, { SECRET: validSecret });
    expect(env).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      PORT: 4000,
      TRUST_PROXY: false,
      SECRET: validSecret,
    });
  });

  it('coerces a port string and a boolean string', () => {
    const env = parseEnv(schema, { SECRET: validSecret, PORT: '8080', TRUST_PROXY: 'true' });
    expect(env.PORT).toBe(8080);
    expect(env.TRUST_PROXY).toBe(true);
  });

  it('rejects invalid values with the variable name', () => {
    expect(() => parseEnv(schema, { SECRET: validSecret, PORT: '70000' })).toThrow(
      EnvValidationError,
    );
    try {
      parseEnv(schema, { SECRET: validSecret, NODE_ENV: 'staging', PORT: 'abc' });
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const { issues } = error as EnvValidationError;
      expect(issues.some((i) => i.startsWith('NODE_ENV:'))).toBe(true);
      expect(issues.some((i) => i.startsWith('PORT:'))).toBe(true);
    }
  });

  it('never echoes secret values in error messages', () => {
    const leakedValue = 'hunter2-super-secret-value';
    try {
      parseEnv(schema, { SECRET: leakedValue });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as Error).message).toContain('SECRET');
      expect((error as Error).message).not.toContain(leakedValue);
    }
  });

  it('reports a missing required variable', () => {
    expect(() => parseEnv(schema, {})).toThrow(/SECRET/);
  });

  it('labels root-level failures', () => {
    expect(() => parseEnv(z.string(), {})).toThrow(/\(root\)/);
  });

  it('defaults to process.env', () => {
    expect(() => parseEnv(z.object({}))).not.toThrow();
  });
});
