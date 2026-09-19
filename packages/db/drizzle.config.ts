import { defineConfig } from 'drizzle-kit';

// DDL is generated from src/schema and applied by app_migrator only.
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  casing: 'snake_case',
  schemaFilter: ['app'],
  dbCredentials: {
    url: process.env['DATABASE_URL_MIGRATOR'] ?? '',
  },
  strict: true,
  verbose: true,
});
