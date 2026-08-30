import type { SharingRiskAssessment, SharingRiskTrendPoint } from '@plex-librarian/shared/types.ts';
import { assessUserSharingRisk, type SharingObservationStats } from './sharingRisk.ts';
import { type SharingPlaybackObservation, sharingPlaybackPatterns } from './playbackPatterns.ts';

export const SHARING_RISK_WINDOW_DAYS = 30;
export const SHARING_RISK_TREND_INTERVAL_DAYS = 7;
export const SHARING_RISK_TREND_LOOKBACK_DAYS = 365;
const DAY_SECONDS = 86_400;

function assessmentForWindow(
  accountId: number,
  observations: SharingPlaybackObservation[],
): SharingRiskAssessment | null {
  const plays = observations.filter((observation) => observation.event === 'media.play');
  if (plays.length === 0) return null;

  const remoteNetworks = new Set<string>();
  const remotePlayers = new Set<string>();
  const activeDays = new Set<number>();
  let completeObservationCount = 0;
  let firstObservedAt = Number.POSITIVE_INFINITY;
  let lastObservedAt = Number.NEGATIVE_INFINITY;

  for (const observation of plays) {
    firstObservedAt = Math.min(firstObservedAt, observation.observedAt);
    lastObservedAt = Math.max(lastObservedAt, observation.observedAt);
    activeDays.add(Math.floor(observation.observedAt / DAY_SECONDS));
    if (observation.ip !== null && observation.playerUuid !== null) {
      completeObservationCount++;
    }
    if (observation.isLocal !== false) continue;
    const network = observation.networkKey ?? observation.ip;
    if (network) remoteNetworks.add(network);
    if (observation.playerUuid) remotePlayers.add(observation.playerUuid);
  }

  const patterns = sharingPlaybackPatterns(observations).get(accountId);
  const stats: SharingObservationStats = {
    observationCount: plays.length,
    firstObservedAt,
    lastObservedAt,
    activeDays: activeDays.size,
    completeObservationCount,
    remoteNetworks30d: remoteNetworks.size,
    remotePlayers30d: remotePlayers.size,
    maxRemoteNetworksPerHour30d: patterns?.maxRemoteNetworksPerHour ?? 0,
    concurrentRemotePlaybackDays30d: patterns?.concurrentRemotePlaybackDays ?? 0,
  };
  return assessUserSharingRisk(stats);
}

export function buildSharingRiskTrend(
  accountId: number,
  observations: SharingPlaybackObservation[],
  trendStart: number,
  trendEnd: number,
): SharingRiskTrendPoint[] {
  if (trendEnd < trendStart) return [];
  const windowSeconds = SHARING_RISK_WINDOW_DAYS * DAY_SECONDS;
  const intervalSeconds = SHARING_RISK_TREND_INTERVAL_DAYS * DAY_SECONDS;
  const ends: number[] = [];

  // Anchor samples to "now" so the final point exactly matches the current assessment.
  for (let periodEnd = trendEnd; periodEnd >= trendStart; periodEnd -= intervalSeconds) {
    ends.push(periodEnd);
  }
  ends.reverse();

  return ends.map((periodEnd) => {
    const periodStart = periodEnd - windowSeconds;
    const windowObservations = observations.filter((observation) =>
      observation.observedAt >= periodStart && observation.observedAt <= periodEnd
    );
    return {
      periodStart,
      periodEnd,
      assessment: assessmentForWindow(accountId, windowObservations),
    };
  });
}
