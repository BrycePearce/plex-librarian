export interface DeletionWorkTarget {
  id: number;
  operationId: string;
  serverId: number;
  targetKind: 'whole_item' | 'movie_version' | 'episode_version' | 'sonarr_series';
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
