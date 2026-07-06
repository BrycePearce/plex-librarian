import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from 'hono/deno';
import { join, resolve } from '@std/path';
import { runMigrations } from './db/migrate.ts';
import { createPlexClient, PlexConfigError } from './lib/plex.ts';
import { failAllPendingSyncs } from './services/sync.ts';
import { startScheduler, startupSyncIfStale } from './services/scheduler.ts';
import auth from './routes/auth.ts';
import events from './routes/events.ts';
import libraries from './routes/libraries.ts';
import proxy from './routes/proxy.ts';
import settings from './routes/settings.ts';
import sync from './routes/sync.ts';
import webhook from './routes/webhook.ts';

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
    const secret = Deno.env.get('PLEX_WEBHOOK_SECRET');
    if (hasPass) {
      const hint = secret ? ` (append ?token=<PLEX_WEBHOOK_SECRET> to the URL)` : '';
      console.log(`Plex Pass detected — register your webhook URL: /api/webhook/plex${hint}`);
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

const app = new Hono();

app.use('*', logger());
app.use('*', bodyLimit({ maxSize: 1 * 1024 * 1024 })); // 1MB

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'internal server error' }, 500);
});

app.get('/health', (c) => c.json({ ok: true, time: new Date().toISOString() }));

app.route('/api/auth', auth);
app.route('/api/events', events);
app.route('/api/libraries', libraries);
app.route('/api/proxy', proxy);
app.route('/api/settings', settings);
app.route('/api/sync', sync);
app.route('/api/webhook', webhook);

const staticDir = Deno.env.get('STATIC_DIR');
if (staticDir) {
  app.use('/*', serveStatic({ root: staticDir }));
  app.get('/*', async (c) => c.html(await Deno.readTextFile(join(staticDir, 'index.html'))));
}

const port = parseInt(Deno.env.get('PORT') ?? '', 10) || 8080;
console.log(`plex-librarian listening on http://localhost:${port}`);

Deno.serve({ port }, app.fetch);
