import { and, desc, eq, lt } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { settings, syncLog } from '../db/schema.ts';
import { PlexConfigError, resolveActiveServer } from '../lib/plex.ts';
import type { PlexClient } from '../lib/plex.ts';
import { triggerFullSync } from './syncManager.ts';

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

// Marks any 'pending' sync_log rows older than 1 hour as 'error'. Covers rows left
// behind by a process crash or a double-failure (worker start + DB error) where
// finalizeSyncLog never ran. Without this, the pending conflict check blocks all
// future syncs until the row is manually cleared.
async function sweepStalePendingRows(): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - 60 * 60;
  const finishedAt = Math.floor(Date.now() / 1000);
  await db
    .update(syncLog)
    .set({ status: 'error', error: 'interrupted — server restarted', finishedAt })
    .where(and(eq(syncLog.status, 'pending'), lt(syncLog.startedAt, cutoff)));
}

// Called at server startup. Triggers a full sync if Plex is configured and no
// successful sync has run in the last 24 hours (covers first boot and stale restarts).
export async function startupSyncIfStale(): Promise<void> {
  try {
    await sweepStalePendingRows();
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
