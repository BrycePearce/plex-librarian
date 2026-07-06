import { and, lt, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { db } from './index.ts';

// Shared by events.ts's pruneOldEvents and scheduler.ts's pruneOldSyncLogs — both prune
// on the same window so the activity feed and its underlying sync_log rows age out
// together. Env-var overridable (like LIBRARY_SYNC_CONCURRENCY etc.) so an install that
// wants to keep longer history isn't stuck with a hardcoded, silently-enforced cutoff.
// Both tables grow by roughly one row per sync run or delete-batch (not per item), so
// even "forever" retention stays tiny — 0 (or below) means "never prune" rather than
// being clamped to some minimum, since there's no real storage-growth risk to guard
// against here. Uses Number.isNaN rather than `parsed || 180` so an explicit
// `LOG_RETENTION_DAYS=0` is honored as "disable pruning" instead of being silently
// treated as unset and falling back to the 180-day default.
const parsedRetentionDays = parseInt(Deno.env.get('LOG_RETENTION_DAYS') ?? '', 10);
export const LOG_RETENTION_DAYS = Math.max(
  0,
  Number.isNaN(parsedRetentionDays) ? 180 : parsedRetentionDays,
);

// Shared by events.ts's pruneOldEvents and scheduler.ts's pruneOldSyncLogs — both just
// delete rows past a fixed retention window, keyed off a different table/date column.
// `extraWhere` lets a caller narrow the delete further (see pruneOldSyncLogs in
// scheduler.ts, which must never delete a still-'pending' row regardless of age).
// retentionDays <= 0 means "keep forever" — skips the delete entirely rather than
// computing a cutoff of "now" (which would otherwise prune everything immediately).
export async function pruneOlderThan(
  table: SQLiteTable,
  dateColumn: SQLiteColumn,
  retentionDays: number,
  extraWhere?: SQL,
): Promise<void> {
  if (retentionDays <= 0) return;
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 24 * 60 * 60;
  const where = extraWhere ? and(lt(dateColumn, cutoff), extraWhere) : lt(dateColumn, cutoff);
  await db.delete(table).where(where);
}
