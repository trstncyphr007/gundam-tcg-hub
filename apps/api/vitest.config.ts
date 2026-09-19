import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Route tests start a real Postgres via Testcontainers; a cold CI runner must pull
    // the image first, which is far slower than a warm local cache.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      thresholds: { lines: 60, functions: 60, branches: 60, statements: 60 },
    },
  },
});
