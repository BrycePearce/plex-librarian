import { join } from '@std/path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from 'hono/deno';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import auth from './features/auth/route.ts';
import arr from './features/arr/route.ts';
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
  app.use(
    '*',
    secureHeaders({
      // The setup flow closes the cross-origin Plex OAuth popup programmatically
      // (setup.tsx); the default `same-origin` severs that window reference.
      crossOriginOpenerPolicy: 'same-origin-allow-popups',
      // TLS (and therefore HSTS) is the fronting reverse proxy's decision — the app
      // itself serves plain HTTP on a trusted LAN and must not commit a user's whole
      // domain to HTTPS from here.
      strictTransportSecurity: false,
    }),
  );
  app.use('*', bodyLimit({ maxSize: 1 * 1024 * 1024 }));

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal server error' }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true, time: new Date().toISOString() }));

  app.route('/api/auth', auth);
  app.route('/api/integrations/arr', arr);
  app.route('/api/duplicates', duplicates);
  app.route('/api/events', events);
  app.route('/api/libraries', libraries);
  app.route('/api/proxy', proxy);
  app.route('/api/settings', settings);
  app.route('/api/sync', sync);
  app.route('/api/users', users);
  app.route('/api/webhook', webhook);

  if (staticDir) {
    // Vite fingerprints every production asset filename, so these responses can be
    // cached permanently: a changed file gets a new URL on the next deployment. HTML
    // keeps revalidating so clients promptly discover those new asset URLs.
    app.use('/*', async (c, next) => {
      await next();
      if (c.res.status !== 200) return;

      if (c.req.path.startsWith('/assets/')) {
        c.header('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (c.res.headers.get('Content-Type')?.includes('text/html')) {
        c.header('Cache-Control', 'no-cache');
      }
    });
    app.use('/*', serveStatic({ root: staticDir }));
    app.get('/*', async (c) => c.html(await Deno.readTextFile(join(staticDir, 'index.html'))));
  }

  return app;
}
