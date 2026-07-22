import type {
  RequestFollowThroughAssessment,
  RequestFollowThroughReason,
} from '@plex-librarian/shared/types.ts';

export interface RequestFollowThroughStats {
  eligibleRequestCount: number;
  watchedRequestCount: number;
  recentRequestCount: number;
  estimatedAvailabilityCount: number;
  unmatchedMediaRequestCount: number;
}

export interface RequestFollowThroughHealth {
  connectionCount: number;
  successfulSyncCount: number;
  failedSyncCount: number;
}

export function assessRequestFollowThrough(
  stats: RequestFollowThroughStats,
  health: RequestFollowThroughHealth,
  historyComplete: boolean,
  graceDays: number,
  minimumRequests: number,
): RequestFollowThroughAssessment {
  const unwatchedRequestCount = Math.max(0, stats.eligibleRequestCount - stats.watchedRequestCount);
  const reasons: RequestFollowThroughReason[] = [];

  if (health.connectionCount === 0) {
    reasons.push({
      type: 'no_seerr_connection',
      summary: 'Connect Seerr in Media Connections to measure request follow-through.',
    });
  } else if (health.successfulSyncCount === 0) {
    reasons.push({
      type: 'seerr_not_synced',
      summary: 'Seerr requests have not completed their first sync yet.',
    });
  }
  if (health.failedSyncCount > 0) {
    reasons.push({
      type: 'seerr_sync_error',
      summary: `${health.failedSyncCount} Seerr connection${
        health.failedSyncCount === 1 ? '' : 's'
      } could not refresh request data.`,
    });
  }
  if (!historyComplete) {
    reasons.push({
      type: 'plex_history_incomplete',
      summary:
        'Plex cross-user watch history is not fully synced, so watch results may be incomplete.',
    });
  }
  if (stats.recentRequestCount > 0) {
    reasons.push({
      type: 'grace_period_exclusions',
      summary: `${stats.recentRequestCount} available request${
        stats.recentRequestCount === 1 ? ' is' : 's are'
      } still inside the ${graceDays}-day grace period.`,
    });
  }
  if (stats.estimatedAvailabilityCount > 0) {
    reasons.push({
      type: 'availability_estimated',
      summary: `${stats.estimatedAvailabilityCount} eligible availability date${
        stats.estimatedAvailabilityCount === 1 ? ' is' : 's are'
      } estimated from Seerr's media update time.`,
    });
  }
  if (stats.unmatchedMediaRequestCount > 0) {
    reasons.push({
      type: 'media_not_matched',
      summary: `${stats.unmatchedMediaRequestCount} available request${
        stats.unmatchedMediaRequestCount === 1 ? ' could' : 's could'
      } not be matched to a synced Plex title and ${
        stats.unmatchedMediaRequestCount === 1 ? 'was' : 'were'
      } excluded.`,
    });
  }

  const unavailable = health.connectionCount === 0 || health.successfulSyncCount === 0 ||
    !historyComplete;
  if (unavailable) {
    return {
      status: 'unavailable',
      ...stats,
      unwatchedRequestCount,
      followThroughPercent: null,
      graceDays,
      minimumRequests,
      reasons,
    };
  }

  if (stats.eligibleRequestCount < minimumRequests) {
    reasons.push({
      type: 'minimum_not_met',
      summary:
        `${stats.eligibleRequestCount} of ${minimumRequests} eligible requests collected before measurement begins.`,
    });
    return {
      status: 'insufficient_data',
      ...stats,
      unwatchedRequestCount,
      followThroughPercent: null,
      graceDays,
      minimumRequests,
      reasons,
    };
  }

  reasons.push({
    type: 'followed_through',
    summary:
      `${stats.watchedRequestCount} of ${stats.eligibleRequestCount} eligible requests were watched after becoming available.`,
  });
  if (unwatchedRequestCount > 0) {
    reasons.push({
      type: 'not_watched',
      summary: `${unwatchedRequestCount} eligible request${
        unwatchedRequestCount === 1 ? ' has' : 's have'
      } no later Plex watch activity.`,
    });
  }
  return {
    status: 'measured',
    ...stats,
    unwatchedRequestCount,
    followThroughPercent: Math.round(stats.watchedRequestCount / stats.eligibleRequestCount * 100),
    graceDays,
    minimumRequests,
    reasons,
  };
}
