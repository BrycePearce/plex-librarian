import { assertEquals } from '@std/assert';
import { assessRequestFollowThrough } from './requestFollowThrough.ts';

const healthy = { connectionCount: 1, successfulSyncCount: 1, failedSyncCount: 0 };

Deno.test('request follow-through waits for the configured sample', () => {
  const result = assessRequestFollowThrough(
    {
      eligibleRequestCount: 4,
      watchedRequestCount: 3,
      recentRequestCount: 1,
      estimatedAvailabilityCount: 4,
      unmatchedMediaRequestCount: 0,
    },
    healthy,
    true,
    30,
    5,
  );
  assertEquals(result.status, 'insufficient_data');
  assertEquals(result.followThroughPercent, null);
});

Deno.test('request follow-through reports the direct watched percentage', () => {
  const result = assessRequestFollowThrough(
    {
      eligibleRequestCount: 5,
      watchedRequestCount: 3,
      recentRequestCount: 0,
      estimatedAvailabilityCount: 5,
      unmatchedMediaRequestCount: 0,
    },
    healthy,
    true,
    30,
    5,
  );
  assertEquals(result.status, 'measured');
  assertEquals(result.followThroughPercent, 60);
  assertEquals(result.unwatchedRequestCount, 2);
});

Deno.test('incomplete Plex history suppresses measurement and explains why', () => {
  const result = assessRequestFollowThrough(
    {
      eligibleRequestCount: 5,
      watchedRequestCount: 0,
      recentRequestCount: 0,
      estimatedAvailabilityCount: 0,
      unmatchedMediaRequestCount: 0,
    },
    healthy,
    false,
    30,
    5,
  );
  assertEquals(result.status, 'unavailable');
  assertEquals(result.reasons.some((reason) => reason.type === 'plex_history_incomplete'), true);
});
