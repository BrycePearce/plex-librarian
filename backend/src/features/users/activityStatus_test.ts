import {
  userActivityStatus,
  userHistoryCanBeAttributed,
  userHistoryIsComplete,
} from './activityStatus.ts';

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`Expected ${expected}, received ${actual}`);
}

Deno.test('an observed timestamp is watched even if identity is currently unresolved', () => {
  assertEquals(userActivityStatus(1_700_000_000, null, false), 'watched');
});

Deno.test('a mapped user is never only after all history walks complete', () => {
  assertEquals(userActivityStatus(null, 42, true), 'never');
  assertEquals(userActivityStatus(null, 42, false), 'history_pending');
});

Deno.test('an unmapped user is unresolved after history completes', () => {
  assertEquals(userActivityStatus(null, null, true), 'identity_unresolved');
  assertEquals(userHistoryCanBeAttributed(true, null), false);
  assertEquals(userHistoryCanBeAttributed(true, 42), true);
});

Deno.test('incomplete history takes precedence over an unresolved identity', () => {
  assertEquals(userActivityStatus(null, null, false), 'history_pending');
});

Deno.test('a server with no video libraries has no history walk pending', () => {
  assertEquals(userHistoryIsComplete(123, []), true);
  assertEquals(userHistoryIsComplete(null, []), false);
});

Deno.test('every video history walk must be at least as new as identity reconciliation', () => {
  assertEquals(userHistoryIsComplete(200, [{ historySyncedAt: 200 }]), true);
  assertEquals(userHistoryIsComplete(200, [{ historySyncedAt: 199 }]), false);
  assertEquals(
    userHistoryIsComplete(200, [
      { historySyncedAt: 200 },
      { historySyncedAt: null },
    ]),
    false,
  );
});
