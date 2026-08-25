import type { DeleteItemOutcome } from './deletion/cleanup.ts';

export type EventType =
  | 'sync.completed'
  | 'sync.failed'
  | 'items.deleted'
  | 'media.deleted'
  | 'deletion.completed'
  | 'user.removed';

export interface DeletionCompletedPayload {
  operationId: string;
  libraryKey: string;
  kind: 'whole_item' | 'movie_version' | 'episode_version';
  status: 'completed' | 'completed_with_warning' | 'needs_attention' | 'cancelled';
  targetCount: number;
  completedCount: number;
  warningCount: number;
  removalConfirmedCount: number;
  failedCount: number;
  cancelledCount: number;
  supersededCount: number;
  logicalSizeRemoved: number;
  verifiedHardlinkDataRemoved?: number;
  verifiedTargetCount?: number;
  unknownTargetCount?: number;
  mixedTargetCount?: number;
}

export interface SyncCompletedPayload {
  syncId: number;
  libraryKey: string | null;
  itemsProcessed: number;
}

export interface SyncFailedPayload {
  syncId: number;
  libraryKey: string | null;
  error: string;
}

export interface ItemsDeletedPayload {
  libraryKey: string;
  deletedCount: number;
  // Optional so activity rows written before coordinated partial results remain readable.
  partialCount?: number;
  failedCount: number;
  // Decimal KB, matching Library.totalFileSize and StaleItem.fileSize.
  fileSizeFreed: number;
  // Optional for activity rows written before per-system deletion outcomes existed.
  outcomes?: DeleteItemOutcome[];
}

export interface MediaDeletedPayload {
  libraryKey: string;
  ratingKey: string;
  title: string;
  mediaId: number;
  fileSizeFreed: number;
}

export interface UserRemovedPayload {
  accountId: number;
  username: string;
}

export type ActivityEvent =
  | {
    id: number;
    type: 'sync.completed';
    payload: SyncCompletedPayload | null;
    createdAt: number;
  }
  | {
    id: number;
    type: 'sync.failed';
    payload: SyncFailedPayload | null;
    createdAt: number;
  }
  | {
    id: number;
    type: 'items.deleted';
    payload: ItemsDeletedPayload | null;
    createdAt: number;
  }
  | {
    id: number;
    type: 'media.deleted';
    payload: MediaDeletedPayload | null;
    createdAt: number;
  }
  | {
    id: number;
    type: 'deletion.completed';
    payload: DeletionCompletedPayload | null;
    createdAt: number;
  }
  | {
    id: number;
    type: 'user.removed';
    payload: UserRemovedPayload | null;
    createdAt: number;
  };

export interface ActivityEventsResponse {
  limit: number;
  events: ActivityEvent[];
  // Pass as `before` on the next request; null once there is no more history.
  nextCursor: number | null;
}

export interface MediaRemovalSummary {
  // Lifetime logical size of media removed through Plex Librarian, in decimal KB.
  mediaSizeRemoved: number;
  // Lifetime conservative namespace-link proof total, in decimal KB.
  verifiedHardlinkDataRemoved: number;
  removalCount: number;
  unknownSizeCount: number;
}
