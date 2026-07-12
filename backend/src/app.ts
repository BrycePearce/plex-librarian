import { join } from '@std/path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from 'hono/deno';
import { logger } from 'hono/logger';
import auth from './features/auth/route.ts';
import duplicates from './features/duplicates/route.ts';
import events from './features/events/route.ts';
import libraries from './features/libraries/route.ts';
import proxy from './features/proxy/route.ts';
import settings from './features/settings/route.ts';
import sync from './features/sync/route.ts';
import users from './features/users/route.ts';
import webhook from './features/webhook/route.ts';

export function createApp(staticDir = Deno.env.get('STATIC_DIR')): Hono {
  const app = new Hono();

  app.use('*', logger());
  app.use('*', bodyLimit({ maxSize: 1 * 1024 * 1024 }));

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal server error' }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true, time: new Date().toISOString() }));

  app.route('/api/auth', auth);
  app.route('/api/duplicates', duplicates);
  app.route('/api/events', events);
  app.route('/api/libraries', libraries);
  app.route('/api/proxy', proxy);
  app.route('/api/settings', settings);
  app.route('/api/sync', sync);
  app.route('/api/users', users);
  app.route('/api/webhook', webhook);

  if (staticDir) {
    app.use('/*', serveStatic({ root: staticDir }));
    app.get('/*', async (c) => c.html(await Deno.readTextFile(join(staticDir, 'index.html'))));
  }

  return app;
}
