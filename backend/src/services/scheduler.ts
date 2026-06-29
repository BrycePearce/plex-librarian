import { desc, eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { settings, syncLog } from '../db/schema.ts';
import { triggerFullSync } from './sync.ts';

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

// Called at server startup. Triggers a full sync if Plex is configured and no
// successful sync has run in the last 24 hours (covers first boot and stale restarts).
export async function startupSyncIfStale(): Promise<void> {
  try {
    if (!(await isPlexConfigured())) return;
    const last = await lastSuccessfulSyncAt();
    const cutoff = Math.floor(Date.now() / 1000) - STALE_THRESHOLD_SECONDS;
    if (last !== null && last > cutoff) {
      console.log(`Auto-sync: last sync was recent — skipping startup sync`);
      return;
    }
    console.log('Auto-sync: triggering startup sync');
    triggerFullSync();
  } catch (err) {
    console.error('Auto-sync: startup check failed:', err);
  }
}

// Fires once per hour. Runs a full sync when the current hour matches autoSyncHour
// and no successful sync has run in the last 23 hours (threshold slightly under 24h
// to tolerate drift from the hourly interval firing a few minutes past the hour).
export function startScheduler(): void {
  setInterval(async () => {
    try {
      const { enabled, hour } = await getAutoSyncSettings();
      if (!enabled) return;
      if (new Date().getHours() !== hour) return;
      if (!(await isPlexConfigured())) return;

      const last = await lastSuccessfulSyncAt();
      const cutoff = Math.floor(Date.now() / 1000) - 23 * 60 * 60;
      if (last !== null && last > cutoff) return;

      console.log(`Auto-sync: triggering scheduled sync (hour=${hour})`);
      triggerFullSync();
    } catch (err) {
      console.error('Auto-sync: scheduled check failed:', err);
    }
  }, 60 * 60 * 1000);
}
