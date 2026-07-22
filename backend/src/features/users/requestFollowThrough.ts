import type {
  RequestFollowThroughAssessment,
  RequestFollowThroughReason,
} from '@plex-librarian/shared/types.ts';

export const REQUEST_FOLLOW_THROUGH_WINDOW_DAYS = 365;

export function requestFollowThroughWindow(now: number, graceDays: number): {
  cutoff: number;
  start: number;
} {
  const cutoff = now - graceDays * 86400;
  return {
    cutoff,
    start: cutoff - REQUEST_FOLLOW_THROUGH_WINDOW_DAYS * 86400,
  };
}

export interface RequestFollowThroughStats {
  eligibleRequestCount: number;
  watchedRequestCount: number;
  recentRequestCount: number;
  estimatedAvailabilityCount: number;
  uncertainAvailabilityOutcomeCount: number;
  unmatchedMediaRequestCount: number;
  unknownRequestScopeCount: number;
}

export interface RequestFollowThroughHealth {
  connectionCount: number;
  successfulSyncCount: number;
  failedSyncCount: number;
  unmatchedUserRequestCount: number;
}

export function assessRequestFollowThrough(
  stats: RequestFollowThroughStats,
  health: RequestFollowThroughHealth,
  historyComplete: boolean,
  graceDays: number,
  minimumRequests: number,
): RequestFollowThroughAssessment {
  const unwatchedRequestCount = Math.max(0, stats.eligibleRequestCount - stats.watchedRequestCount);
  const nonWatchRatio = stats.eligibleRequestCount > 0
    ? unwatchedRequestCount / stats.eligibleRequestCount
    : null;
  const nonWatchPercent = nonWatchRatio === null ? null : Math.round(nonWatchRatio * 100);
  const reasons: RequestFollowThroughReason[] = [];

  if (health.connectionCount === 0) {
    reasons.push({
      type: 'no_seerr_connection',
      summary: 'Connect Seerr in Media Connections to measure request follow-through.',
    });
  } else if (health.successfulSyncCount < health.connectionCount) {
    reasons.push({
      type: 'seerr_not_synced',
      summary: `${health.connectionCount - health.successfulSyncCount} Seerr connection${
        health.connectionCount - health.successfulSyncCount === 1 ? ' has' : 's have'
      } not completed a request sync.`,
    });
  }
  if (health.failedSyncCount > 0) {
    reasons.push({
      type: 'seerr_sync_error',
      summary: `${health.failedSyncCount} Seerr connection${
        health.failedSyncCount === 1 ? '' : 's'
      } could not refresh request data. Measurement is unavailable until all connections recover.`,
    });
  }
  if (!historyComplete) {
    reasons.push({
      type: 'plex_history_incomplete',
      summary:
        'Plex cross-user watch history is not fully synced, so watch results may be incomplete.',
    });
  }
  if (health.unmatchedUserRequestCount > 0) {
    reasons.push({
      type: 'requester_not_matched',
      summary: `${health.unmatchedUserRequestCount} available request${
        health.unmatchedUserRequestCount === 1 ? '' : 's'
      } could not be matched to a unique Plex user and ${
        health.unmatchedUserRequestCount === 1 ? 'is' : 'are'
      } preventing assessment until requester coverage is complete.`,
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
      } use${
        stats.estimatedAvailabilityCount === 1 ? 's' : ''
      } a generic Seerr update time because a dedicated media-added date was unavailable. ${
        stats.uncertainAvailabilityOutcomeCount > 0
          ? `${stats.uncertainAvailabilityOutcomeCount} without a confirmed watch at or after the estimated date ${
            stats.uncertainAvailabilityOutcomeCount === 1 ? 'is' : 'are'
          } unresolved, so assessment is unavailable.`
          : 'Every estimated request has a confirmed watch at or after the estimated date.'
      }`,
    });
  }
  if (stats.unmatchedMediaRequestCount > 0) {
    reasons.push({
      type: 'media_not_matched',
      summary: `${stats.unmatchedMediaRequestCount} available request${
        stats.unmatchedMediaRequestCount === 1 ? ' could' : 's could'
      } not be matched to a synced Plex title and ${
        stats.unmatchedMediaRequestCount === 1 ? 'was' : 'were'
      } left unresolved. Assessment is unavailable rather than assuming an outcome.`,
    });
  }
  if (stats.unknownRequestScopeCount > 0) {
    reasons.push({
      type: 'request_scope_unknown',
      summary: `${stats.unknownRequestScopeCount} request${
        stats.unknownRequestScopeCount === 1 ? '' : 's'
      } did not include a usable media type or requested-season scope and ${
        stats.unknownRequestScopeCount === 1 ? 'was' : 'were'
      } left unresolved. Assessment is unavailable rather than matching unrelated show activity.`,
    });
  }

  const unavailable = health.connectionCount === 0 ||
    health.successfulSyncCount < health.connectionCount || health.failedSyncCount > 0 ||
    !historyComplete || health.unmatchedUserRequestCount > 0 ||
    stats.uncertainAvailabilityOutcomeCount > 0 ||
    stats.unmatchedMediaRequestCount > 0 || stats.unknownRequestScopeCount > 0;
  if (unavailable) {
    return {
      status: 'unavailable',
      eligibleRequestCount: stats.eligibleRequestCount,
      watchedRequestCount: null,
      unwatchedRequestCount: null,
      nonWatchPercent: null,
      recentRequestCount: stats.recentRequestCount,
      uncertainAvailabilityOutcomeCount: stats.uncertainAvailabilityOutcomeCount,
      unmatchedMediaRequestCount: stats.unmatchedMediaRequestCount,
      unknownRequestScopeCount: stats.unknownRequestScopeCount,
      graceDays,
      minimumRequests,
      windowDays: REQUEST_FOLLOW_THROUGH_WINDOW_DAYS,
      reasons,
    };
  }

  if (stats.eligibleRequestCount < minimumRequests) {
    reasons.push({
      type: 'minimum_not_met',
      summary:
        `${stats.eligibleRequestCount} of ${minimumRequests} eligible requests collected in the ${REQUEST_FOLLOW_THROUGH_WINDOW_DAYS}-day window before assessment begins.`,
    });
    return {
      status: 'insufficient_data',
      eligibleRequestCount: stats.eligibleRequestCount,
      watchedRequestCount: stats.watchedRequestCount,
      unwatchedRequestCount,
      nonWatchPercent: null,
      recentRequestCount: stats.recentRequestCount,
      uncertainAvailabilityOutcomeCount: stats.uncertainAvailabilityOutcomeCount,
      unmatchedMediaRequestCount: stats.unmatchedMediaRequestCount,
      unknownRequestScopeCount: stats.unknownRequestScopeCount,
      graceDays,
      minimumRequests,
      windowDays: REQUEST_FOLLOW_THROUGH_WINDOW_DAYS,
      reasons,
    };
  }

  reasons.push({
    type: 'followed_through',
    summary:
      `${stats.watchedRequestCount} of ${stats.eligibleRequestCount} eligible requests were watched at or after becoming available.`,
  });
  if (unwatchedRequestCount > 0) {
    reasons.push({
      type: 'not_watched',
      summary: `${unwatchedRequestCount} eligible request${
        unwatchedRequestCount === 1 ? ' has' : 's have'
      } no Plex watch activity at or after availability.`,
    });
  }

  // Status thresholds use the exact ratio. Percentages are rounded only for display,
  // otherwise a value just below a boundary can be rounded into a stronger assessment.
  const reviewStrength = nonWatchRatio! >= 0.7 && unwatchedRequestCount >= 4;
  const watchStrength = nonWatchRatio! >= 0.4 && unwatchedRequestCount >= 3;
  const status = reviewStrength ? 'review' : watchStrength ? 'watch' : 'healthy';
  reasons.push({
    type: 'habit_assessment',
    summary: status === 'review'
      ? 'A recurring high non-watch rate warrants review.'
      : status === 'watch'
      ? 'The non-watch pattern is worth monitoring, but is not yet review-strength.'
      : 'No recurring requester/non-watcher pattern crosses the monitoring threshold.',
  });

  return {
    status,
    eligibleRequestCount: stats.eligibleRequestCount,
    watchedRequestCount: stats.watchedRequestCount,
    unwatchedRequestCount,
    nonWatchPercent,
    recentRequestCount: stats.recentRequestCount,
    uncertainAvailabilityOutcomeCount: stats.uncertainAvailabilityOutcomeCount,
    unmatchedMediaRequestCount: stats.unmatchedMediaRequestCount,
    unknownRequestScopeCount: stats.unknownRequestScopeCount,
    graceDays,
    minimumRequests,
    windowDays: REQUEST_FOLLOW_THROUGH_WINDOW_DAYS,
    reasons,
  };
}
