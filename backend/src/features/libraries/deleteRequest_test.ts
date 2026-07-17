import { assertEquals } from '@std/assert';
import { isDeletionMode } from './deleteRequest.ts';

Deno.test('whole-item deletion mode must always be explicit', () => {
  assertEquals(isDeletionMode('coordinated'), true);
  assertEquals(isDeletionMode('plex-only'), true);
  assertEquals(isDeletionMode(undefined), false);
  assertEquals(isDeletionMode(null), false);
  assertEquals(isDeletionMode(''), false);
});
