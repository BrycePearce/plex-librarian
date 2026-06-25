-- Drop the one-pending-sync-at-a-time global unique index so that per-library
-- syncs can run concurrently with each other. Conflict detection is now handled
-- at the application level in the sync routes.
DROP INDEX IF EXISTS `sync_log_one_pending_idx`;
