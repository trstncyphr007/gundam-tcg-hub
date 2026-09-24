import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Generous, because these tests are CPU-bound rather than waiting on anything.
     *
     * Decoding, resampling and re-encoding a multi-megapixel photograph in pure JavaScript is
     * about a second here, and roughly four times that under V8 coverage instrumentation —
     * which is what CI runs, on a slower machine. Vitest's default of five seconds is a
     * comfortable pass locally and a flake on a shared runner, which is the worst combination.
     */
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
