import { assertEquals } from '@std/assert';
import { assessRequestFollowThrough, requestFollowThroughWindow } from './requestFollowThrough.ts';

const healthy = {
  connectionCount: 1,
  successfulSyncCount: 1,
  failedSyncCount: 0,
  unmatchedUserRequestCount: 0,
};

function stats(overrides: Record<string, number> = {}) {
  return {
    eligibleRequestCount: 4,
    watchedRequestCount: 3,
    recentRequestCount: 1,
    estimatedAvailabilityCount: 0,
    uncertainAvailabilityOutcomeCount: 0,
    unmatchedMediaRequestCount: 0,
    unknownRequestScopeCount: 0,
    ...overrides,
  };
}

Deno.test('request follow-through waits for the configured sample', () => {
  const result = assessRequestFollowThrough(stats(), healthy, true, 30, 5);
  assertEquals(result.status, 'insufficient_data');
  assertEquals(result.nonWatchPercent, null);
  assertEquals(result.eligibleRequestCount, 4);
  assertEquals(result.minimumRequests, 5);
  assertEquals(result.windowDays, 365);
});

Deno.test('review begins at an exact 70% ratio and four unwatched requests', () => {
  const result = assessRequestFollowThrough(
    stats({ eligibleRequestCount: 10, watchedRequestCount: 3, recentRequestCount: 0 }),
    healthy,
    true,
    30,
    5,
  );
  assertEquals(result.status, 'review');
  assertEquals(result.nonWatchPercent, 70);
  assertEquals(result.unwatchedRequestCount, 7);
});

Deno.test('rounded display percentage does not cross the review threshold', () => {
  const result = assessRequestFollowThrough(
    stats({ eligibleRequestCount: 23, watchedRequestCount: 7, recentRequestCount: 0 }),
    healthy,
    true,
    30,
    5,
  );
  assertEquals(result.nonWatchPercent, 70);
  assertEquals(result.status, 'watch');
});

Deno.test('review requires four unwatched requests even above the ratio threshold', () => {
  const result = assessRequestFollowThrough(
    stats({ eligibleRequestCount: 4, watchedRequestCount: 1 }),
    healthy,
    true,
    30,
    4,
  );
  assertEquals(result.nonWatchPercent, 75);
  assertEquals(result.unwatchedRequestCount, 3);
  assertEquals(result.status, 'watch');
});

Deno.test('watch begins at an exact 40% ratio and three unwatched requests', () => {
  const result = assessRequestFollowThrough(
    stats({ eligibleRequestCount: 10, watchedRequestCount: 6 }),
    healthy,
    true,
    30,
    5,
  );
  assertEquals(result.status, 'watch');
  assertEquals(result.nonWatchPercent, 40);
});

Deno.test('ratio alone cannot trigger watch without three unwatched requests', () => {
  const result = assessRequestFollowThrough(
    stats({ eligibleRequestCount: 5, watchedRequestCount: 3 }),
    healthy,
    true,
    30,
    5,
  );
  assertEquals(result.status, 'healthy');
  assertEquals(result.nonWatchPercent, 40);
});

Deno.test('sufficient follow-through reports a healthy assessment', () => {
  const result = assessRequestFollowThrough(
    stats({ eligibleRequestCount: 10, watchedRequestCount: 8 }),
    healthy,
    true,
    30,
    5,
  );
  assertEquals(result.status, 'healthy');
  assertEquals(result.nonWatchPercent, 20);
  assertEquals(result.unwatchedRequestCount, 2);
});

Deno.test('incomplete Plex history suppresses measurement and explains why', () => {
  const result = assessRequestFollowThrough(
    stats({ eligibleRequestCount: 5, watchedRequestCount: 0 }),
    healthy,
    false,
    30,
    5,
  );
  assertEquals(result.status, 'unavailable');
  assertEquals(result.watchedRequestCount, null);
  assertEquals(result.unwatchedRequestCount, null);
  assertEquals(result.nonWatchPercent, null);
  assertEquals(result.reasons.some((reason) => reason.type === 'plex_history_incomplete'), true);
});

Deno.test('a current Seerr refresh failure pauses assessment', () => {
  const result = assessRequestFollowThrough(
    stats({ eligibleRequestCount: 10, watchedRequestCount: 0 }),
    { ...healthy, failedSyncCount: 1 },
    true,
    30,
    5,
  );
  assertEquals(result.status, 'unavailable');
  assertEquals(result.nonWatchPercent, null);
});

Deno.test('rolling window remains valid when grace exceeds one year', () => {
  const now = 2_000_000_000;
  const window = requestFollowThroughWindow(now, 400);
  assertEquals(window.cutoff - window.start, 365 * 86400);
  assertEquals(window.cutoff, now - 400 * 86400);
});

Deno.test('unknown request type or TV season scope pauses assessment', () => {
  const result = assessRequestFollowThrough(
    stats({ unknownRequestScopeCount: 2 }),
    healthy,
    true,
    30,
    5,
  );
  assertEquals(result.status, 'unavailable');
  assertEquals(result.unknownRequestScopeCount, 2);
  assertEquals(result.reasons.some((reason) => reason.type === 'request_scope_unknown'), true);
});

Deno.test('unmatched media or requester evidence suppresses classification', () => {
  const mediaResult = assessRequestFollowThrough(
    stats({ eligibleRequestCount: 5, watchedRequestCount: 3, unmatchedMediaRequestCount: 1 }),
    healthy,
    true,
    30,
    5,
  );
  const requesterResult = assessRequestFollowThrough(
    stats({ eligibleRequestCount: 20, watchedRequestCount: 4 }),
    { ...healthy, unmatchedUserRequestCount: 1 },
    true,
    30,
    5,
  );
  assertEquals(mediaResult.status, 'unavailable');
  assertEquals(requesterResult.status, 'unavailable');
});

Deno.test('estimated dates without a later watch pause negative classification', () => {
  const result = assessRequestFollowThrough(
    stats({
      eligibleRequestCount: 20,
      watchedRequestCount: 4,
      estimatedAvailabilityCount: 20,
      uncertainAvailabilityOutcomeCount: 16,
    }),
    healthy,
    true,
    30,
    5,
  );
  assertEquals(result.status, 'unavailable');
  assertEquals(result.nonWatchPercent, null);
});

Deno.test('estimated dates can support confirmed positive follow-through', () => {
  const result = assessRequestFollowThrough(
    stats({
      eligibleRequestCount: 10,
      watchedRequestCount: 10,
      estimatedAvailabilityCount: 10,
      uncertainAvailabilityOutcomeCount: 0,
    }),
    healthy,
    true,
    30,
    5,
  );
  assertEquals(result.status, 'healthy');
  assertEquals(result.nonWatchPercent, 0);
});

Deno.test('assessment response contains only the simplified evidence shape', () => {
  const result = assessRequestFollowThrough(
    stats({ eligibleRequestCount: 10, watchedRequestCount: 8 }),
    healthy,
    true,
    30,
    5,
  );
  assertEquals(Object.keys(result).sort(), [
    'eligibleRequestCount',
    'graceDays',
    'minimumRequests',
    'nonWatchPercent',
    'reasons',
    'recentRequestCount',
    'status',
    'uncertainAvailabilityOutcomeCount',
    'unknownRequestScopeCount',
    'unmatchedMediaRequestCount',
    'unwatchedRequestCount',
    'watchedRequestCount',
    'windowDays',
  ]);
});
