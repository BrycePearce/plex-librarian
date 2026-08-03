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

export class PlexReconciliationError extends Error {
  constructor(
    message: string,
    readonly permanent = false,
    readonly warningAllowed = true,
  ) {
    super(message);
  }
}
