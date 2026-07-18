import { assertEquals } from '@std/assert';
import { isRetryableDeletionFailure } from './policy.ts';

Deno.test('deletion retry policy retries transient failures only', () => {
  assertEquals(isRetryableDeletionFailure(429, 'rate limited'), true);
  assertEquals(isRetryableDeletionFailure(503, 'unavailable'), true);
  assertEquals(isRetryableDeletionFailure(null, 'fetch failed', true), true);
  assertEquals(isRetryableDeletionFailure(400, 'bad request'), false);
  assertEquals(isRetryableDeletionFailure(401, 'unauthorized'), false);
});
