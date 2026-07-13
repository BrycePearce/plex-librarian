import type {
  SharingDataConfidence,
  SharingRiskAssessment,
  SharingRiskSignal,
} from '@plex-librarian/shared/types.ts';

// These are intentionally product constants, not user-facing settings. They should be
// revisited only after real installations have accumulated enough observations to
// validate the distributions. The score is a review aid, not a probability.
const MIN_MEDIUM_OBSERVATIONS = 5;
const MIN_MEDIUM_SPAN_DAYS = 7;
const MIN_MEDIUM_ACTIVE_DAYS = 3;
const MIN_MEDIUM_FIELD_COVERAGE = 0.5;
const MIN_HIGH_OBSERVATIONS = 20;
const MIN_HIGH_SPAN_DAYS = 30;
const MIN_HIGH_ACTIVE_DAYS = 10;
const MIN_HIGH_FIELD_COVERAGE = 0.8;

export interface SharingObservationStats {
  observationCount: number;
  firstObservedAt: number | null;
  lastObservedAt: number | null;
  activeDays: number;
  completeObservationCount: number;
  remoteNetworks30d: number;
  remotePlayers30d: number;
  maxRemoteNetworksPerHour30d: number;
  concurrentRemotePlaybackDays30d: number;
}

function dataConfidence(stats: SharingObservationStats, spanDays: number): SharingDataConfidence {
  if (stats.observationCount === 0) return 'none';

  const coverage = stats.observationCount === 0
    ? 0
    : stats.completeObservationCount / stats.observationCount;
  if (
    stats.observationCount >= MIN_HIGH_OBSERVATIONS &&
    spanDays >= MIN_HIGH_SPAN_DAYS &&
    stats.activeDays >= MIN_HIGH_ACTIVE_DAYS &&
    coverage >= MIN_HIGH_FIELD_COVERAGE
  ) return 'high';

  if (
    stats.observationCount >= MIN_MEDIUM_OBSERVATIONS &&
    spanDays >= MIN_MEDIUM_SPAN_DAYS &&
    stats.activeDays >= MIN_MEDIUM_ACTIVE_DAYS &&
    coverage >= MIN_MEDIUM_FIELD_COVERAGE
  ) return 'medium';

  return 'low';
}

export function assessUserSharingRisk(stats: SharingObservationStats): SharingRiskAssessment {
  const spanDays = stats.firstObservedAt !== null && stats.lastObservedAt !== null
    ? Math.floor((stats.lastObservedAt - stats.firstObservedAt) / 86400) + 1
    : 0;
  const confidence = dataConfidence(stats, spanDays);

  if (stats.observationCount === 0) {
    return {
      riskScore: 0,
      riskLevel: 'insufficient_data',
      dataConfidence: 'none',
      observationCount: 0,
      activeDays: 0,
      observationSpanDays: 0,
      observedSince: null,
      signals: [],
    };
  }

  const signals: SharingRiskSignal[] = [];

  // Exact public-IP diversity is deliberately low weight: VPNs, mobile networks,
  // CGNAT, and IPv6 privacy addressing can all inflate it legitimately.
  if (stats.remoteNetworks30d >= 8) {
    signals.push({
      type: 'remote_network_diversity',
      weight: 15,
      summary: `${stats.remoteNetworks30d} remote networks observed in 30 days`,
    });
  } else if (stats.remoteNetworks30d >= 4) {
    signals.push({
      type: 'remote_network_diversity',
      weight: 8,
      summary: `${stats.remoteNetworks30d} remote networks observed in 30 days`,
    });
  }

  if (stats.remotePlayers30d >= 8) {
    signals.push({
      type: 'remote_device_diversity',
      weight: 20,
      summary: `${stats.remotePlayers30d} remote players observed in 30 days`,
    });
  } else if (stats.remotePlayers30d >= 5) {
    signals.push({
      type: 'remote_device_diversity',
      weight: 10,
      summary: `${stats.remotePlayers30d} remote players observed in 30 days`,
    });
  }

  // Still only a supporting signal—not proof of impossible travel. Unlike the old
  // calendar-day bucket, this is a real rolling time window.
  if (stats.maxRemoteNetworksPerHour30d >= 4) {
    signals.push({
      type: 'rapid_network_switching',
      weight: 15,
      summary: `${stats.maxRemoteNetworksPerHour30d} remote networks observed within one hour`,
    });
  }

  if (stats.concurrentRemotePlaybackDays30d >= 2) {
    signals.push({
      type: 'concurrent_remote_playback',
      weight: 35,
      summary:
        `Concurrent remote playback from different networks on ${stats.concurrentRemotePlaybackDays30d} days`,
    });
  } else if (stats.concurrentRemotePlaybackDays30d === 1) {
    signals.push({
      type: 'concurrent_remote_playback',
      weight: 20,
      summary: 'Concurrent remote playback from different networks observed once',
    });
  }

  const riskScore = Math.min(100, signals.reduce((sum, signal) => sum + signal.weight, 0));
  // Sparse evidence with no meaningful signal is not affirmative low risk. Strong
  // early signals still surface immediately instead of waiting weeks for confidence.
  const riskLevel = confidence === 'low' && riskScore < 15
    ? 'insufficient_data'
    : riskScore >= 35
    ? 'review'
    : riskScore >= 15
    ? 'watch'
    : 'low';

  return {
    riskScore,
    riskLevel,
    dataConfidence: confidence,
    observationCount: stats.observationCount,
    activeDays: stats.activeDays,
    observationSpanDays: spanDays,
    observedSince: stats.firstObservedAt,
    signals,
  };
}
