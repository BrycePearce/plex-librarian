import { assertEquals } from '@std/assert';
import type { PlexActiveSession } from '../../integrations/plex/index.ts';
import { sessionEventsForSnapshot } from './sessionState.ts';

function session(
  sessionKey: string,
  state: PlexActiveSession['state'] = 'playing',
): PlexActiveSession {
  return {
    sessionKey,
    ratingKey: '10',
    type: 'movie',
    grandparentRatingKey: null,
    state,
    accountId: 1,
    username: 'owner',
    playerUuid: `player-${sessionKey}`,
    playerTitle: 'Test Player',
    ip: '203.0.113.10',
    isLocal: false,
  };
}

Deno.test('session snapshots emit play, pause, resume, and stop once', () => {
  let current = new Map<string, PlexActiveSession>();

  const started = sessionEventsForSnapshot(current, [session('a')]);
  assertEquals(started.events.map((event) => event.event), ['media.play']);
  current = started.next;

  const unchanged = sessionEventsForSnapshot(current, [session('a')]);
  assertEquals(unchanged.events, []);

  const paused = sessionEventsForSnapshot(current, [session('a', 'paused')]);
  assertEquals(paused.events.map((event) => event.event), ['media.pause']);

  const resumed = sessionEventsForSnapshot(paused.next, [session('a', 'playing')]);
  assertEquals(resumed.events.map((event) => event.event), ['media.resume']);

  const stopped = sessionEventsForSnapshot(resumed.next, []);
  assertEquals(stopped.events.map((event) => event.event), ['media.stop']);
});

Deno.test('a monitor starting on a paused session establishes and closes its lifecycle', () => {
  const result = sessionEventsForSnapshot(new Map(), [session('a', 'paused')]);
  assertEquals(result.events.map((event) => event.event), ['media.play', 'media.pause']);
});
