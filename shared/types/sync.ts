export type LibraryPhase =
  | 'pending'
  | 'items'
  | 'episodes'
  | 'tracks'
  | 'history'
  | 'done';

export interface LibrarySyncProgress {
  key: string;
  title: string;
  phase: LibraryPhase;
  count: number;
  elapsedSeconds?: number;
}

export interface SyncLog {
  id: number;
  libraryKey: string | null;
  startedAt: number;
  finishedAt: number | null;
  status: 'pending' | 'success' | 'error';
  itemsProcessed: number | null;
  error: string | null;
  progress?: LibrarySyncProgress[];
}

export interface SyncTriggerResponse {
  syncId: number;
  status: 'pending';
}
