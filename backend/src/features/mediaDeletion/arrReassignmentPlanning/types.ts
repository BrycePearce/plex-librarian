import type { RadarrPathAdoptionPreview } from '@plex-librarian/shared/types.ts';
import type { ArrDeleteTarget } from '../../arr/delete.ts';
import type {
  PersistedPathNamespaceEvidence,
  PersistedPhysicalIdentityEvidence,
} from '../pathNamespace.ts';

export interface EligibleArrReassignment {
  target: ArrDeleteTarget;
  recordId: number;
  recordPath: string;
  episodeId: number | null;
  managedFileId: number | null;
  managedFileSize: number | null;
  managedPath: string | null;
  managedMediaId: number | null;
  monitored: boolean;
  candidatePaths: Map<number, string>;
  candidateRecordPaths: Map<number, string>;
  candidateFileSizes: Map<number, number | null>;
  alreadyReassigned: boolean;
  radarrPathPlan?: PersistedRadarrPathPlan;
  radarrPathPlans?: Map<number, PersistedRadarrPathPlan>;
}

export interface PersistedRadarrPathPlan {
  // The consent mode is accepted only for legacy persisted operations. New planning never emits it.
  mode: 'existing_path' | 'adopt_safe_path' | 'adopt_path_with_consent';
  arrInstanceId: number;
  movieId: number;
  retainedMediaId: number;
  originalMoviePath: string;
  targetMoviePath: string;
  retainedPath: string;
  originalMonitored: boolean;
  originalMovieFile: {
    id: number;
    path: string;
    relativePath: string;
    size: number;
  };
  adoptedMovieFile?: {
    id: number;
    path: string;
    relativePath: string;
    size: number;
  };
  pathOwnership: 'ordinary_radarr_library' | 'explicit_user_managed_location';
  userAuthorizedPathManagement: boolean;
  planFingerprint?: string;
  radarrBehaviorFingerprint: string;
  radarrVersion: string;
  behaviorSummary: {
    deleteEmptyFolders: boolean;
    fileDate: string;
    metadataConsumerCount: number;
    notificationConsumerCount: number;
  };
  namespaceEvidence: {
    selected: PersistedPathNamespaceEvidence;
    retained: PersistedPathNamespaceEvidence;
    libraryLocations: PersistedPathNamespaceEvidence[];
  };
  physicalIdentityEvidence: PersistedPhysicalIdentityEvidence;
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
}

export interface PersistedRadarrRemovalFallback {
  mode: 'remove_from_radarr';
  arrInstanceId: number;
  arrConfigurationUpdatedAt: number;
  arrMappingIdentity: string;
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
  originalMoviePath: string;
  originalMonitored: boolean;
  createImportExclusion: true;
  deleteFiles: false;
  addImportExclusion: true;
  userAuthorizedRadarrRemoval: true;
  planFingerprint: string;
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
}

export interface PersistedArrMappingIdentity {
  instanceId: number;
  instanceType: 'radarr' | 'sonarr';
  instanceUrl: string;
  configurationUpdatedAt: number;
  mappingIdentity: string;
}

export interface PersistedArrReassignment extends PersistedArrMappingIdentity {
  recordId: number;
  recordPath: string;
  episodeId: number | null;
  managedFileId: number;
  managedPath: string;
  retainedMediaId: number;
  retainedPath: string;
  retainedRecordPath?: string;
  retainedFileSize?: number | null;
  originalMonitored: boolean;
  radarrPathPlan?: PersistedRadarrPathPlan;
}

export interface PersistedArrOwnership {
  instanceId: number;
  recordId: number | null;
  episodeId: number | null;
  managedFileId: number | null;
  managedPath: string | null;
  managedMediaId: number | null;
}

export interface ArrReassignmentPlanningResult {
  eligibleArrReassignments: EligibleArrReassignment[];
  arrMappingIdentities: PersistedArrMappingIdentity[];
  arrOwnerships: PersistedArrOwnership[];
  arrOwnershipValid: boolean;
  arrOwnershipReason?: string;
  arrManagedMediaIds: number[];
  arrReassignCandidateMediaIds: number[];
  arrReassignStatus: 'resolved' | 'unavailable' | 'error';
  arrReassignReason?: string;
  radarrPathAdoption: RadarrPathAdoptionPreview;
}
