export interface DeletionWorkTarget {
  id: number;
  operationId: string;
  serverId: number;
  targetKind: 'whole_item' | 'movie_version' | 'episode_version';
  targetKey: string;
  snapshot: string;
  logicalSize: number | null;
}

export class DeletionConvergenceError extends Error {}
