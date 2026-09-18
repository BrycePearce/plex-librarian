export interface DeletionWorkTarget {
  id: number;
  operationId: string;
  serverId: number;
  targetKind: 'whole_item' | 'movie_version' | 'episode_version';
  targetKey: string;
  snapshot: string;
  logicalSize: number | null;
  phase: DeletionPhase;
  removalConfirmedAt: number | null;
  plexAttemptCount: number;
}

export type DeletionPhase =
  | 'validating'
  | 'download_cleanup'
  | 'arr_coordination'
  | 'plex_reconciliation'
  | 'finalizing';

export class DeletionConvergenceError extends Error {}

/** Read-only verification can resume; never grants permission to replay a request. */
export class ServiceOwnedVerificationPending extends Error {}

/** Count checkpoint transitions, not read timestamps, so repeated reads cannot extend the budget. */
export function serviceOwnedVerificationProgress(
  attempts: Record<string, {
    response?: unknown;
    outcome?: unknown;
    monitoring?: Record<string, { response?: unknown; noRequest?: boolean; observedAt?: number }>;
    recordCleanup?: { response?: unknown; observedAt?: number };
  }>,
): number {
  return Object.values(attempts).reduce((sum, attempt) =>
    sum + Number(!!attempt.response) +
    Number(!!attempt.outcome) + Number(!!attempt.recordCleanup?.response) +
    Number(!!attempt.recordCleanup?.observedAt) + Object.values(attempt.monitoring ?? {}).reduce(
      (count, entry) =>
        count + Number(!!entry.response || !!entry.noRequest) + Number(!!entry.observedAt),
      0,
    ), 0);
}

export class PlexReconciliationError extends Error {
  constructor(
    message: string,
    readonly permanent = false,
    readonly warningAllowed = true,
  ) {
    super(message);
  }
}

// Monitoring restoration is a strict postcondition, not a Plex warning. Keep
// its bounded retries separate from plex_attempt_count because no Plex request
// is made while this error is being reconciled.
export class ArrMonitoringReconciliationError extends PlexReconciliationError {
  constructor(message: string, permanent = false) {
    super(message, permanent, false);
  }
}
