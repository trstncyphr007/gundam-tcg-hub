import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.ts'],
      // Security-critical package: 80% floor (plan §18.2).
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
