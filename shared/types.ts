// Shared API contracts imported by both the backend and frontend.
// Keep this compatibility barrel stable; domain definitions live under shared/types/.

export type * from './types/auth.ts';
export type * from './types/settings.ts';
export type * from './types/libraries.ts';
export type * from './types/users.ts';
export type * from './types/sync.ts';
export type * from './types/activity.ts';
export type * from './types/episodeGaps.ts';

export type * from './types/integrations/arr.ts';
export type * from './types/integrations/qbittorrent.ts';
export type * from './types/integrations/seerr.ts';

export type * from './types/media/versions.ts';
export type * from './types/media/duplicates.ts';
export type * from './types/media/smartDuplicates.ts';
export type * from './types/media/seasonProfiles.ts';

export type * from './types/deletion/cleanup.ts';
export type * from './types/deletion/operations.ts';
export type * from './types/deletion/previews.ts';
export type * from './types/deletion/relocation.ts';
export {
  hasCompletedRelocationSyncBarrier,
  hasIncompleteRelocationSyncBarrier,
  hasValidRelocationGuidance,
} from './types/deletion/relocation.ts';
