import { assessUserSharingRisk, type SharingObservationStats } from './userSharingRisk.ts';
import { networkKeyForIp } from '../lib/network.ts';

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
  maxRemoteNetworksPerDay30d: 0,
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
    maxRemoteNetworksPerDay30d: 4,
  });
  assert(result.riskLevel === 'review', 'expected review risk');
  assert(result.riskScore === 50, 'expected deterministic signal weights');
  assert(result.dataConfidence === 'medium', 'expected medium evidence confidence');
  assert(result.signals.length === 3, 'expected three supporting signals');
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
