import { assertEquals } from '@std/assert';
import type { SharingPlaybackObservation } from './playbackPatterns.ts';
import { buildSharingRiskTrend, SHARING_RISK_TREND_INTERVAL_DAYS } from './sharingRiskTrend.ts';

const DAY = 86_400;
const NOW = 2_000_000_000;
const ACCOUNT_ID = 42;

function play(daysAgo: number, network: string, player: string): SharingPlaybackObservation {
  return {
    accountId: ACCOUNT_ID,
    observedAt: NOW - daysAgo * DAY,
    event: 'media.play',
    ip: network,
    networkKey: network,
    playerUuid: player,
    isLocal: false,
  };
}

Deno.test('sharing risk trend anchors its final point to the current assessment', () => {
  const observations = [
    play(2, 'network-a', 'player-a'),
    play(1, 'network-b', 'player-b'),
  ];
  const points = buildSharingRiskTrend(ACCOUNT_ID, observations, NOW - 35 * DAY, NOW);

  assertEquals(points.at(-1)?.periodEnd, NOW);
  assertEquals(points.at(-1)?.assessment?.observationCount, 2);
  assertEquals(
    points.at(-1)!.periodEnd - points.at(-2)!.periodEnd,
    SHARING_RISK_TREND_INTERVAL_DAYS * DAY,
  );
});

Deno.test('sharing risk trend leaves evidence gaps instead of reporting zero risk', () => {
  const points = buildSharingRiskTrend(
    ACCOUNT_ID,
    [play(1, 'network-a', 'player-a')],
    NOW - 70 * DAY,
    NOW,
  );

  assertEquals(points[0]?.assessment, null);
  assertEquals(points.at(-1)?.assessment?.riskLevel, 'insufficient_data');
});

Deno.test('sharing risk trend applies the existing signal weights to historical windows', () => {
  const observations = Array.from(
    { length: 8 },
    (_, index) => play(index + 1, `network-${index}`, `player-${index}`),
  );
  const points = buildSharingRiskTrend(ACCOUNT_ID, observations, NOW - 7 * DAY, NOW);
  const current = points.at(-1)?.assessment;

  assertEquals(current?.riskScore, 35);
  assertEquals(current?.riskLevel, 'review');
});
