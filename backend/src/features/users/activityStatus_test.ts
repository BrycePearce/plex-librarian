import { userActivityStatus } from './activityStatus.ts';

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`Expected ${expected}, received ${actual}`);
}

Deno.test('an observed timestamp is watched even if identity is currently unresolved', () => {
  assertEquals(userActivityStatus(1_700_000_000, null, false), 'watched');
});

Deno.test('a mapped user is never only after all history walks complete', () => {
  assertEquals(userActivityStatus(null, 42, true), 'never');
  assertEquals(userActivityStatus(null, 42, false), 'unknown');
});

Deno.test('an unmapped user is unknown rather than never', () => {
  assertEquals(userActivityStatus(null, null, true), 'unknown');
});
