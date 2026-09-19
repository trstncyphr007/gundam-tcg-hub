import { expect } from 'vitest';

/**
 * Assert a query failed for the expected reason. postgres.js wraps failures, so the
 * constraint/permission/RLS text lives on `cause` rather than the top-level message.
 */
export async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected the query to fail').toBeDefined();
  const messages: string[] = [];
  for (let e: unknown = caught; e instanceof Error; e = e.cause) {
    messages.push(e.message);
  }
  expect(messages.join(' | ')).toMatch(pattern);
}
