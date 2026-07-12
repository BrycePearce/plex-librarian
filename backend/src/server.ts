import { resolve } from '@std/path';
import { createApp } from './app.ts';
import { runMigrations } from './db/migrate.ts';
import { failAllPendingSyncs } from './features/sync/syncLog.ts';
import { startScheduler, startupSyncIfStale } from './features/sync/scheduler.ts';
import { createPlexClient, PlexConfigError } from './integrations/plex/index.ts';

await runMigrations(
  Deno.env.get('DB_PATH') ?? './data/librarian.db',
  resolve(import.meta.dirname!, '../drizzle'),
);

// Any sync that was 'pending' at startup was orphaned by a previous crash.
await failAllPendingSyncs();

void startupSyncIfStale();
startScheduler();

// Check Plex Pass availability in the background — don't block server startup
void (async () => {
  try {
    const plex = await createPlexClient();
    const hasPass = await plex.hasPlexPass();
    if (hasPass) {
      console.log('Plex Pass detected — register your webhook URL: /api/webhook/plex');
    } else {
      console.log('No Plex Pass detected — webhook ingestion unavailable (manual sync only)');
    }
  } catch (err) {
    const msg = err instanceof PlexConfigError
      ? `${err.message} — skipping Plex Pass check`
      : 'Could not reach Plex at startup — skipping Plex Pass check';
    console.log(msg);
  }
})();

const port = parseInt(Deno.env.get('PORT') ?? '', 10) || 8080;
console.log(`plex-librarian listening on http://localhost:${port}`);

Deno.serve({ port }, createApp().fetch);
