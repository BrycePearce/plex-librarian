import { assertEquals } from '@std/assert';
import type { PlexActiveSession } from '../../integrations/plex/types.ts';
import { activeWholeItemRatingKeys, mediaRatingKeyIsPlaying } from './activePlayback.ts';

function session(
  ratingKey: string,
  grandparentRatingKey: string | null = null,
): PlexActiveSession {
  return {
    sessionKey: ratingKey,
    ratingKey,
    type: grandparentRatingKey ? 'episode' : 'movie',
    grandparentRatingKey,
    state: 'playing',
    accountId: null,
    username: null,
    playerUuid: null,
    playerTitle: null,
    ip: null,
    isLocal: null,
  };
}

Deno.test('whole-item playback detection maps episodes back to their selected show', () => {
  assertEquals(
    activeWholeItemRatingKeys(
      new Set(['movie-1', 'show-1', 'unrelated']),
      [session('movie-1'), session('episode-3', 'show-1'), session('other')],
    ),
    new Set(['movie-1', 'show-1']),
  );
});

Deno.test('version playback detection requires the exact movie or episode key', () => {
  const sessions = [session('episode-3', 'show-1')];
  assertEquals(mediaRatingKeyIsPlaying('episode-3', sessions), true);
  assertEquals(mediaRatingKeyIsPlaying('show-1', sessions), false);
});
