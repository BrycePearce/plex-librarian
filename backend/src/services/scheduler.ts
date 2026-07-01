import { and, desc, eq, lt } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { settings, syncLog } from '../db/schema.ts';
import { triggerFullSync } from './syncManager.ts';

const STALE_THRESHOLD_SECONDS = 24 * 60 * 60;

async function isPlexConfigured(): Promise<boolean> {
  if (Deno.env.get('PLEX_URL') && Deno.env.get('PLEX_TOKEN')) return true;
  const [row] = await db
    .select({ plexUrl: settings.plexUrl, plexToken: settings.plexToken })
    .from(settings)
    .where(eq(settings.id, 1))
    .limit(1);
  return !!(row?.plexUrl && row?.plexToken);
}

async function lastSuccessfulSyncAt(): Promise<number | null> {
  const [row] = await db
    .select({ finishedAt: syncLog.finishedAt })
    .from(syncLog)
    .where(eq(syncLog.status, 'success'))
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
    if (!(await isPlexConfigured())) return;
    const last = await lastSuccessfulSyncAt();
    const cutoff = Math.floor(Date.now() / 1000) - STALE_THRESHOLD_SECONDS;
    if (last !== null && last > cutoff) {
      console.log(`Auto-sync: last sync was recent — skipping startup sync`);
      return;
    }
    console.log('Auto-sync: triggering startup sync');
    const startupResult = triggerFullSync();
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
      if (!(await isPlexConfigured())) return;

      const last = await lastSuccessfulSyncAt();
      const cutoff = Math.floor(Date.now() / 1000) - 23 * 60 * 60;
      if (last !== null && last > cutoff) return;

      console.log(`Auto-sync: triggering scheduled sync (hour=${hour})`);
      const schedResult = triggerFullSync();
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
