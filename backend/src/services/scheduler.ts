import { and, desc, eq, lt, ne } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { LOG_RETENTION_DAYS, pruneOlderThan } from '../db/prune.ts';
import { settings, syncLog, userIpHistory } from '../db/schema.ts';
import { PlexConfigError, resolveActiveServer } from '../lib/plex.ts';
import type { PlexClient } from '../lib/plex.ts';
import { sweepStalePendingSyncs, triggerFullSync } from './syncManager.ts';
import { pruneOldEvents } from './events.ts';

// Prunes by finishedAt (not startedAt) so a sync's row survives for the full retention
// window counted from when it actually finished, not from when it started — otherwise a
// long-running sync on a low LOG_RETENTION_DAYS install could have its row deleted on the
// very next hourly tick after it completes. The explicit `ne(status,'pending')` guard is a
// backstop on top of that: a still-'pending' row has no finishedAt to compare against and
// is already excluded by `lt(finishedAt, cutoff)`, but a pending row must never be silently
// deleted out from under a sync that's still writing to it, so this stays explicit rather
// than relying on the NULL comparison alone.
async function pruneOldSyncLogs(): Promise<void> {
  await pruneOlderThan(
    syncLog,
    syncLog.finishedAt,
    LOG_RETENTION_DAYS,
    ne(syncLog.status, 'pending'),
  );
}

async function pruneOldUserIpHistory(): Promise<void> {
  const [row] = await db.select({ days: settings.ipHistoryRetentionDays })
    .from(settings)
    .where(eq(settings.id, 1))
    .limit(1);
  const days = row?.days ?? 365;
  if (days === 0) return;
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  await db.delete(userIpHistory).where(lt(userIpHistory.lastSeenAt, cutoff));
}

const STALE_THRESHOLD_SECONDS = 24 * 60 * 60;

// Resolves the active server (see resolveActiveServer() in lib/plex.ts) rather than
// reading settings.activeServerId directly, so an env-var-configured server that's
// never been touched this process gets its `servers` row/activeServerId resolved here —
// otherwise the staleness check below wouldn't yet know which server's history to look
// at. Returns the full {client, serverId} pair (not just the id) so the caller can
// thread it straight into triggerFullSync() without a second, possibly-divergent
// resolution. Deliberately narrower than getActiveServerIdOrNull()'s catch-everything
// semantics: a transient error here should still surface (via the outer try/catch below)
// as a distinct "check failed" log rather than being silently treated as "not configured".
async function resolveActiveServerOrNull(): Promise<
  { client: PlexClient; serverId: number } | null
> {
  try {
    return await resolveActiveServer();
  } catch (err) {
    if (err instanceof PlexConfigError) return null;
    throw err;
  }
}

// Scoped to the active server — an unscoped "any server's last success" check would
// wrongly treat a freshly-switched-to server as already synced if some other server
// (including one no longer connected) happened to sync recently.
async function lastSuccessfulSyncAt(serverId: number): Promise<number | null> {
  const [row] = await db
    .select({ finishedAt: syncLog.finishedAt })
    .from(syncLog)
    .where(and(eq(syncLog.serverId, serverId), eq(syncLog.status, 'success')))
    .orderBy(desc(syncLog.finishedAt))
    .limit(1);
  return row?.finishedAt ?? null;
}

async function getAutoSyncSettings(): Promise<{ enabled: boolean; hour: number }> {
  const [row] = await db
    .select({ autoSyncEnabled: settings.autoSyncEnabled, autoSyncHour: settings.autoSyncHour })
    .from(settings)
    .where(eq(settings.id, 1))
    .limit(1);
  return {
    enabled: row?.autoSyncEnabled ?? true,
    hour: row?.autoSyncHour ?? 3,
  };
}

// Marks any 'pending' sync_log rows older than 1 hour as 'error' (and records a
// sync.failed activity event for each — see failStalePendingSyncs). Covers rows left
// behind by a process crash or a double-failure (worker start + DB error) where
// finalizeSyncLog never ran. Without this, the pending conflict check blocks all
// future syncs until the row is manually cleared.
//
// Excludes syncIds this same process still considers active: those are protected by
// syncManager's own in-process watchdog (which fails a sync the moment it actually
// stalls, regardless of total elapsed time), so a large library sync that's still
// making real progress past the 1-hour mark must not be second-guessed and marked
// 'error' by this wall-clock-only sweep — doing so would silently discard the sync's
// real outcome once it does finish (see finalizeSyncLog's status='pending' guard).
async function sweepStalePendingRows(): Promise<void> {
  await sweepStalePendingSyncs(60 * 60);
}

// Called at server startup. Triggers a full sync if Plex is configured and no
// successful sync has run in the last 24 hours (covers first boot and stale restarts).
//
// Deliberately doesn't call sweepStalePendingRows() here — main.ts already runs
// failAllPendingSyncs() unconditionally before this function is invoked, and a fresh
// boot means nothing can legitimately still be 'pending', so a second sweep this early
// would always find zero rows. sweepStalePendingRows only earns its keep on the hourly
// interval below, where a sync can legitimately still be mid-flight.
//
// The prune step gets its own try/catch (matching startScheduler's pattern below) so a
// pruning failure can't silently skip the sync-trigger check that follows it.
export async function startupSyncIfStale(): Promise<void> {
  try {
    await Promise.all([pruneOldEvents(), pruneOldSyncLogs(), pruneOldUserIpHistory()]);
  } catch (err) {
    console.error('Scheduled data pruning failed:', err);
  }
  try {
    const active = await resolveActiveServerOrNull();
    if (active === null) return;
    const last = await lastSuccessfulSyncAt(active.serverId);
    const cutoff = Math.floor(Date.now() / 1000) - STALE_THRESHOLD_SECONDS;
    if (last !== null && last > cutoff) {
      console.log(`Auto-sync: last sync was recent — skipping startup sync`);
      return;
    }
    console.log('Auto-sync: triggering startup sync');
    const startupResult = await triggerFullSync(active);
    if ('conflict' in startupResult) {
      console.log(
        `Auto-sync: sync ${startupResult.conflict} already running — startup sync skipped`,
      );
    }
  } catch (err) {
    console.error('Auto-sync: startup check failed:', err);
  }
}

// Fires once per hour. Runs a full sync when the current hour matches autoSyncHour
// and no successful sync has run in the last 23 hours (threshold slightly under 24h
// to tolerate drift from the hourly interval firing a few minutes past the hour).
// autoSyncHour is compared against the server's local hour — Docker containers default
// to UTC, so set the TZ env var if you need a different timezone.
export function startScheduler(): void {
  const id = setInterval(async () => {
    try {
      await sweepStalePendingRows();
    } catch (err) {
      console.error('Stale-pending sync sweep failed:', err);
    }
    try {
      await Promise.all([pruneOldEvents(), pruneOldSyncLogs(), pruneOldUserIpHistory()]);
    } catch (err) {
      console.error('Scheduled data pruning failed:', err);
    }
    try {
      const { enabled, hour } = await getAutoSyncSettings();
      if (!enabled) return;
      if (new Date().getHours() !== hour) return;
      const active = await resolveActiveServerOrNull();
      if (active === null) return;

      const last = await lastSuccessfulSyncAt(active.serverId);
      const cutoff = Math.floor(Date.now() / 1000) - 23 * 60 * 60;
      if (last !== null && last > cutoff) return;

      console.log(`Auto-sync: triggering scheduled sync (hour=${hour})`);
      const schedResult = await triggerFullSync(active);
      if ('conflict' in schedResult) {
        console.log(
          `Auto-sync: sync ${schedResult.conflict} already running — scheduled sync skipped`,
        );
      }
    } catch (err) {
      console.error('Auto-sync: scheduled check failed:', err);
    }
  }, 60 * 60 * 1000);
  // Unref so a pending tick doesn't block clean process exit on SIGTERM.
  Deno.unrefTimer(id);
}
