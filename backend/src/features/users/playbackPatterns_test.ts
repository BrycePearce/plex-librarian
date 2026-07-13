import { type SharingPlaybackObservation, sharingPlaybackPatterns } from './playbackPatterns.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function observation(
  overrides: Partial<SharingPlaybackObservation>,
): SharingPlaybackObservation {
  return {
    accountId: 1,
    observedAt: 1_700_000_000,
    event: 'media.play',
    ip: '203.0.113.1',
    networkKey: 'v4:203.0.113.0/24',
    playerUuid: 'player-a',
    isLocal: false,
    ...overrides,
  };
}

Deno.test('different remote players and networks overlap until a closing event', () => {
  const patterns = sharingPlaybackPatterns([
    observation({}),
    observation({
      observedAt: 1_700_000_300,
      ip: '198.51.100.1',
      networkKey: 'v4:198.51.100.0/24',
      playerUuid: 'player-b',
    }),
    observation({ observedAt: 1_700_000_600, event: 'media.stop' }),
  ]).get(1)!;
  assert(patterns.concurrentRemotePlaybackDays === 1, 'expected one concurrent day');
});

Deno.test('same-network household playback is not remote concurrency evidence', () => {
  const patterns = sharingPlaybackPatterns([
    observation({}),
    observation({ observedAt: 1_700_000_300, playerUuid: 'player-b' }),
  ]).get(1)!;
  assert(patterns.concurrentRemotePlaybackDays === 0, 'expected no cross-network overlap');
});

Deno.test('pause closes a session and missing close expires after six hours', () => {
  const patterns = sharingPlaybackPatterns([
    observation({}),
    observation({ observedAt: 1_700_000_100, event: 'media.pause' }),
    observation({
      observedAt: 1_700_000_200,
      ip: '198.51.100.1',
      networkKey: 'v4:198.51.100.0/24',
      playerUuid: 'player-b',
    }),
    observation({
      observedAt: 1_700_000_200 + 6 * 3600 + 1,
      ip: '192.0.2.1',
      networkKey: 'v4:192.0.2.0/24',
      playerUuid: 'player-c',
    }),
  ]).get(1)!;
  assert(patterns.concurrentRemotePlaybackDays === 0, 'expected closed and expired sessions');
});

Deno.test('rapid switching uses a rolling hour instead of a calendar day', () => {
  const base = 1_700_000_000;
  const rapid = sharingPlaybackPatterns(
    [0, 600, 1200, 1800].map((offset, index) =>
      observation({
        observedAt: base + offset,
        ip: `203.0.${index}.1`,
        networkKey: `v4:203.0.${index}.0/24`,
        playerUuid: `player-${index}`,
      })
    ),
  ).get(1)!;
  assert(rapid.maxRemoteNetworksPerHour === 4, 'expected four networks in one hour');

  const spreadOut = sharingPlaybackPatterns(
    [0, 2 * 3600, 4 * 3600, 6 * 3600].map((offset, index) =>
      observation({
        observedAt: base + offset,
        ip: `198.51.${index}.1`,
        networkKey: `v4:198.51.${index}.0/24`,
        playerUuid: `spread-player-${index}`,
      })
    ),
  ).get(1)!;
  assert(spreadOut.maxRemoteNetworksPerHour === 1, 'expected spread-out starts not to combine');
});
