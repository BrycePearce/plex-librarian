import type { DeletionOperationTarget } from './relocation.ts';

export type DeletionOperationStatus =
  | 'queued'
  | 'running'
  | 'waiting_retry'
  | 'completed'
  | 'completed_with_warning'
  | 'needs_attention'
  | 'cancelled';

export interface DeletionOperationCreated {
  operationId: string;
  status: DeletionOperationStatus;
}

export interface DeletionOperationListItem {
  id: string;
  libraryKey: string;
  kind: 'whole_item' | 'movie_version' | 'episode_version';
  status: DeletionOperationStatus;
  targetCount: number;
  createdAt: number;
  updatedAt: number;
  titles: string[];
  failureReasons: string[];
  arrDestinations: Array<{
    instanceId: number;
    instanceName: string;
    instanceType: 'sonarr' | 'radarr';
  }>;
  retryable: boolean;
}

export interface DeletionOperationArrLinksResponse {
  links: Array<{
    targetId: number;
    targetTitle: string;
    instanceId: number;
    instanceName: string;
    instanceType: 'sonarr' | 'radarr';
    href: string;
  }>;
}

export interface DeletionOperationsResponse {
  status: DeletionOperationStatus | null;
  attention: boolean;
  limit: number;
  offset: number;
  total: number;
  operations: DeletionOperationListItem[];
}

export interface DeletionOperation {
  id: string;
  clientRequestId: string;
  libraryKey: string;
  kind: 'whole_item' | 'movie_version' | 'episode_version';
  status: DeletionOperationStatus;
  targetCount: number;
  completedCount: number;
  warningCount: number;
  cancelledCount: number;
  supersededCount: number;
  libraryRecoveryTargetCount: number;
  removalConfirmedCount: number;
  failedCount: number;
  logicalSizeRemoved: number;
  nextRetryAt: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
  targets: DeletionOperationTarget[];
}

export type DeletionTargetResolutionState = 'management_hold';

export interface FinishRelocationResponse {
  operation: DeletionOperation;
  sync: { syncId: number } | { conflict: number } | { deferred: true } | { completed: true };
}
