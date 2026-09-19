import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      thresholds: { lines: 60, functions: 60, branches: 60, statements: 60 },
    },
  },
});
