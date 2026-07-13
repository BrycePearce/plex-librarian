import { assessUserSharingRisk, type SharingObservationStats } from './sharingRisk.ts';
import { networkKeyForIp } from './network.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const EMPTY_STATS: SharingObservationStats = {
  observationCount: 0,
  firstObservedAt: null,
  lastObservedAt: null,
  activeDays: 0,
  completeObservationCount: 0,
  remoteNetworks30d: 0,
  remotePlayers30d: 0,
  maxRemoteNetworksPerHour30d: 0,
  concurrentRemotePlaybackDays30d: 0,
};

Deno.test('sharing risk reports insufficient data instead of low risk for a new user', () => {
  const result = assessUserSharingRisk(EMPTY_STATS);
  assert(result.riskLevel === 'insufficient_data', 'expected insufficient_data');
  assert(result.dataConfidence === 'none', 'expected no confidence');
  assert(result.riskScore === 0, 'expected a zero score');
  assert(result.observedSince === null, 'expected no observation start');
});

Deno.test('sharing confidence matures independently of risk', () => {
  const result = assessUserSharingRisk({
    ...EMPTY_STATS,
    observationCount: 24,
    firstObservedAt: 1_700_000_000,
    lastObservedAt: 1_700_000_000 + 31 * 86400,
    activeDays: 12,
    completeObservationCount: 22,
  });
  assert(result.riskLevel === 'low', 'expected low risk with no signals');
  assert(result.dataConfidence === 'high', 'expected high confidence');
  assert(result.riskScore === 0, 'expected confidence not to inflate risk');
});

Deno.test('sparse clean observations remain insufficient rather than affirmative low risk', () => {
  const result = assessUserSharingRisk({
    ...EMPTY_STATS,
    observationCount: 1,
    firstObservedAt: 1_700_000_000,
    lastObservedAt: 1_700_000_000,
    activeDays: 1,
    completeObservationCount: 1,
  });
  assert(result.riskLevel === 'insufficient_data', 'expected limited data');
  assert(result.dataConfidence === 'low', 'expected low confidence');
});

Deno.test('multiple supporting signals produce an explainable review result', () => {
  const result = assessUserSharingRisk({
    ...EMPTY_STATS,
    observationCount: 12,
    firstObservedAt: 1_700_000_000,
    lastObservedAt: 1_700_000_000 + 10 * 86400,
    activeDays: 6,
    completeObservationCount: 12,
    remoteNetworks30d: 9,
    remotePlayers30d: 8,
    maxRemoteNetworksPerHour30d: 4,
  });
  assert(result.riskLevel === 'review', 'expected review risk');
  assert(result.riskScore === 50, 'expected deterministic signal weights');
  assert(result.dataConfidence === 'medium', 'expected medium evidence confidence');
  assert(result.signals.length === 3, 'expected three supporting signals');
});

Deno.test('recurring concurrent remote playback is review strength on its own', () => {
  const result = assessUserSharingRisk({
    ...EMPTY_STATS,
    observationCount: 8,
    firstObservedAt: 1_700_000_000,
    lastObservedAt: 1_700_000_000 + 8 * 86400,
    activeDays: 4,
    completeObservationCount: 8,
    concurrentRemotePlaybackDays30d: 2,
  });
  assert(result.riskLevel === 'review', 'expected recurring concurrency to require review');
  assert(result.riskScore === 35, 'expected recurring concurrency weight');
});

Deno.test('network keys group address churn into stable prefixes', () => {
  assert(
    networkKeyForIp('203.0.113.42') === networkKeyForIp('203.0.113.99'),
    'expected IPv4 addresses in one /24 to share a key',
  );
  assert(
    networkKeyForIp('2001:db8:abcd:12::1') ===
      networkKeyForIp('2001:db8:abcd:12:ffff:eeee:dddd:cccc'),
    'expected IPv6 addresses in one /64 to share a key',
  );
  assert(networkKeyForIp('not-an-ip') === null, 'expected invalid addresses to be ignored');
});
