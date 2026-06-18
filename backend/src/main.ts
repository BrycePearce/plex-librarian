import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { bodyLimit } from 'hono/body-limit';
import { eq } from 'drizzle-orm';
import { db } from './db/index.ts';
import { syncLog } from './db/schema.ts';
import { createPlexClient, PlexConfigError } from './lib/plex.ts';
import libraries from './routes/libraries.ts';
import sync from './routes/sync.ts';
import webhook from './routes/webhook.ts';

// Any sync that was 'pending' at startup was orphaned by a previous crash.
await db
  .update(syncLog)
  .set({
    status: 'error',
    finishedAt: Math.floor(Date.now() / 1000),
    error: 'interrupted by server restart',
  })
  .where(eq(syncLog.status, 'pending'));

// Check Plex Pass availability in the background — don't block server startup
void (async () => {
  try {
    const plex = createPlexClient();
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

app.route('/api/libraries', libraries);
app.route('/api/sync', sync);
app.route('/api/webhook', webhook);

const port = parseInt(Deno.env.get('PORT') ?? '', 10) || 8080;
console.log(`plex-purger listening on http://localhost:${port}`);

Deno.serve({ port }, app.fetch);
