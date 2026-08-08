interface DeletionOperationTargetBase {
  id: number;
  ordinal: number;
  targetKind: 'whole_item' | 'movie_version' | 'episode_version';
  targetKey: string;
  title: string;
  status:
    | 'queued'
    | 'running'
    | 'waiting_retry'
    | 'completed'
    | 'completed_with_warning'
    | 'needs_attention'
    | 'cancelled';
  attemptCount: number;
  phase:
    | 'validating'
    | 'download_cleanup'
    | 'arr_coordination'
    | 'plex_reconciliation'
    | 'finalizing';
  removalConfirmedAt: number | null;
  plexReconciledAt: number | null;
  plexAttemptCount: number;
  warning: string | null;
  downloadCleanupSelected: boolean;
  arrCoordinationConfigured: boolean;
  nextRetryAt: number | null;
  error: string | null;
  logicalSize: number | null;
  supersededReason: string | null;
  resolutionState?: 'management_hold';
  radarrPathAdoption?: {
    mode: 'existing_path' | 'adopt_safe_path' | 'adopt_path_with_consent';
    originalMoviePath: string;
    targetMoviePath: string;
    retainedPath: string;
    originalMonitored: boolean;
    userAuthorizedPathManagement: boolean;
    adoptedMovieFile?: {
      id: number;
      path: string;
      relativePath: string;
      size: number;
    };
    transition?: {
      monitoringProtectionAttemptedAt?: number;
      monitoringProtectedAt?: number;
      pathUpdateAttemptedAt?: number;
      pathConfirmedAt?: number;
      rescanAttemptedAt?: number;
      rescanCommandId?: number;
      rescanCommandStatus?: string;
      adoptedAt?: number;
      monitoringRestoredAt?: number;
    };
  };
  radarrRemovalFallback?: {
    mode: 'remove_from_radarr';
    movieId: number;
    tmdbId: number;
    movieTitle: string;
    movieYear: number;
    selectedMediaId: number;
    retainedMediaId: number;
    selectedPlexPath: string;
    managedPath: string;
    retainedPlexPath: string;
    retainedFileSize: number;
    originalMonitored: boolean;
    exclusionPreexisting?: boolean;
    createdExclusionId?: number;
    transition?: {
      monitoringProtectionAttemptedAt?: number;
      monitoringProtectedAt?: number;
      exclusionCreationAttemptedAt?: number;
      exclusionConfirmedAt?: number;
      removalAttemptedAt?: number;
      movieAbsenceConfirmedAt?: number;
      plexDeletionAttemptedAt?: number;
      retainedSurvivalConfirmedAt?: number;
    };
  };
}

export interface RadarrMovieRelocationGuidanceV1 {
  schemaVersion: 1;
  workflow: 'retained_version_relocation';
  service: 'radarr';
  mediaType: 'movie';
  reason: 'retained_parent_mismatch';
  guidanceId: string;
  selectedMediaId: number;
  selectedPlexPath: string;
  selectedArrPath: string;
  retainedMediaId: number;
  retainedPlexPath: string;
  retainedFileSize: number;
  managedDirectoryPath: string;
  sourceArrPath: string;
  destinationArrPath: string;
  destinationPlexPath: string;
  arrInstanceId: number;
  arrInstanceName: string;
  arrRecordId: number;
  arrManagedFileId: number;
  mappingIdentity: string;
  observedAt: number;
}

export type RelocationGuidance = RadarrMovieRelocationGuidanceV1;

export interface IncompleteRelocationSyncBarrier {
  guidanceId: string;
  supersededAt: number;
  syncId?: never;
  finishedAt?: never;
}

export interface CompletedRelocationSyncBarrier {
  guidanceId: string;
  supersededAt: number;
  syncId: number;
  finishedAt: number;
}

export type RelocationSyncBarrier =
  | IncompleteRelocationSyncBarrier
  | CompletedRelocationSyncBarrier;

type RelocationGuidanceApiState =
  | { relocationGuidanceState: 'none'; relocationGuidance?: never }
  | { relocationGuidanceState: 'invalid'; relocationGuidance?: never }
  | {
    relocationGuidanceState: 'valid';
    relocationGuidance: RelocationGuidance;
  };

type RelocationBarrierApiState =
  | { relocationSyncBarrierState: 'none'; relocationSyncBarrier?: never }
  | { relocationSyncBarrierState: 'invalid'; relocationSyncBarrier?: never }
  | {
    relocationSyncBarrierState: 'incomplete';
    relocationSyncBarrier: IncompleteRelocationSyncBarrier;
  }
  | {
    relocationSyncBarrierState: 'completed';
    relocationSyncBarrier: CompletedRelocationSyncBarrier;
  };

export type DeletionOperationTarget =
  & DeletionOperationTargetBase
  & RelocationGuidanceApiState
  & RelocationBarrierApiState;

export function hasValidRelocationGuidance(
  target: DeletionOperationTarget,
): target is DeletionOperationTarget & {
  relocationGuidanceState: 'valid';
  relocationGuidance: RelocationGuidance;
} {
  return target.relocationGuidanceState === 'valid';
}

export function hasIncompleteRelocationSyncBarrier(
  target: DeletionOperationTarget,
): target is DeletionOperationTarget & {
  relocationSyncBarrierState: 'incomplete';
  relocationSyncBarrier: IncompleteRelocationSyncBarrier;
} {
  return target.relocationSyncBarrierState === 'incomplete';
}

export function hasCompletedRelocationSyncBarrier(
  target: DeletionOperationTarget,
): target is DeletionOperationTarget & {
  relocationSyncBarrierState: 'completed';
  relocationSyncBarrier: CompletedRelocationSyncBarrier;
} {
  return target.relocationSyncBarrierState === 'completed';
}
