import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { settings } from '../db/schema.ts';
import { buildPlexHeaders, clearPlexClientCache, PLEX_CLIENT_PRODUCT } from '../lib/plex.ts';

const router = new Hono();

const PLEX_TV = 'https://plex.tv';

// Cached after first read — clientId is a stable UUID for the lifetime of the installation.
let cachedClientId: string | null = null;

async function getOrCreateClientId(): Promise<string> {
  if (cachedClientId) return cachedClientId;
  await db.insert(settings)
    .values({ id: 1, clientId: crypto.randomUUID() })
    .onConflictDoNothing();
  const [row] = await db.select({ clientId: settings.clientId })
    .from(settings)
    .where(eq(settings.id, 1))
    .limit(1);
  cachedClientId = row!.clientId;
  return cachedClientId;
}

// POST /api/auth/plex/pin
// Creates a Plex PIN and returns the auth URL to redirect the user to.
router.post('/plex/pin', async (c) => {
  const clientId = await getOrCreateClientId();

  const res = await fetch(`${PLEX_TV}/api/v2/pins?strong=true`, {
    method: 'POST',
    headers: buildPlexHeaders(clientId),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    res.body?.cancel();
    return c.json({ error: `Plex returned ${res.status} creating PIN` }, 502);
  }

  const data = await res.json() as { id: number; code: string };

  const authUrl = `https://app.plex.tv/auth#?` +
    `clientID=${encodeURIComponent(clientId)}` +
    `&code=${encodeURIComponent(data.code)}` +
    `&${encodeURIComponent('context[device][product]')}=${encodeURIComponent(PLEX_CLIENT_PRODUCT)}`;

  return c.json({ pinId: data.id, code: data.code, authUrl });
});

// GET /api/auth/plex/pin/:id
// Polls Plex for PIN completion. On success returns available servers.
router.get('/plex/pin/:id', async (c) => {
  const pinId = c.req.param('id');
  const clientId = await getOrCreateClientId();

  const res = await fetch(`${PLEX_TV}/api/v2/pins/${pinId}`, {
    headers: buildPlexHeaders(clientId),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    res.body?.cancel();
    return c.json({ error: `Plex returned ${res.status}` }, 502);
  }

  const data = await res.json() as { authToken: string | null };

  if (!data.authToken) return c.json({ status: 'pending' });

  // Token obtained — fetch available servers so the client can let the user pick.
  const resourcesRes = await fetch(
    `${PLEX_TV}/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1`,
    {
      headers: buildPlexHeaders(clientId, data.authToken),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!resourcesRes.ok) {
    resourcesRes.body?.cancel();
    return c.json({ error: `Plex returned ${resourcesRes.status} fetching resources` }, 502);
  }

  const resources = await resourcesRes.json() as Array<{
    name: string;
    provides: string;
    owned: boolean;
    accessToken: string;
    connections: Array<{ uri: string; local: boolean; relay: boolean }>;
  }>;

  const connScore = (conn: { local: boolean; relay: boolean }) =>
    conn.local ? 0 : conn.relay ? 2 : 1;
  const servers = resources
    .filter((r) => r.owned && r.provides.split(',').map((s) => s.trim()).includes('server'))
    .map((r) => ({
      name: r.name,
      accessToken: r.accessToken,
      connections: r.connections.sort((a, b) => connScore(a) - connScore(b)),
    }));

  return c.json({ status: 'complete', servers });
});

// POST /api/auth/plex/server
// Saves the user's chosen server URL and token to settings.
router.post('/plex/server', async (c) => {
  if (Deno.env.get('PLEX_URL') || Deno.env.get('PLEX_TOKEN')) {
    return c.json({ error: 'credentials are set via environment variables and cannot be overridden here' }, 409);
  }

  const body = await c.req.json() as { serverUrl?: string; accessToken?: string };

  if (!body.serverUrl || !body.accessToken) {
    return c.json({ error: 'serverUrl and accessToken are required' }, 400);
  }

  try {
    const u = new URL(body.serverUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
  } catch {
    return c.json({ error: 'serverUrl must be a valid http/https URL' }, 400);
  }

  await getOrCreateClientId();
  await db.update(settings)
    .set({ plexUrl: body.serverUrl, plexToken: body.accessToken })
    .where(eq(settings.id, 1));

  clearPlexClientCache();

  return c.json({ ok: true });
});

// DELETE /api/auth/plex
// Clears stored Plex credentials so the user can reconnect or switch servers.
// No-op when credentials come from env vars (can't clear those at runtime).
router.delete('/plex', async (c) => {
  if (Deno.env.get('PLEX_URL') || Deno.env.get('PLEX_TOKEN')) {
    return c.json({ error: 'credentials are set via environment variables and cannot be cleared here' }, 409);
  }

  await db.update(settings)
    .set({ plexUrl: null, plexToken: null })
    .where(eq(settings.id, 1));

  clearPlexClientCache();

  return c.json({ ok: true });
});

// GET /api/auth/status
// Returns whether Plex is configured (used by the client for first-run detection).
// Also validates the stored token against Plex so a revoked token shows as unconfigured.
router.get('/status', async (c) => {
  // Env vars count as configured — skip live validation for simplicity.
  // Use || so a partial env-var set (one var missing) surfaces as misconfigured
  // rather than falling through to DB credentials that createPlexClient() would ignore.
  if (Deno.env.get('PLEX_URL') || Deno.env.get('PLEX_TOKEN')) {
    const configured = !!(Deno.env.get('PLEX_URL') && Deno.env.get('PLEX_TOKEN'));
    return c.json({ configured, source: 'env' });
  }

  const [row] = await db.select({
    clientId: settings.clientId,
    plexUrl: settings.plexUrl,
    plexToken: settings.plexToken,
  }).from(settings).where(eq(settings.id, 1)).limit(1);

  if (!row?.plexUrl || !row?.plexToken) {
    return c.json({ configured: false, source: null });
  }

  // Validate the token is still accepted by Plex.
  try {
    const res = await fetch(`${PLEX_TV}/api/v2/user`, {
      headers: buildPlexHeaders(row.clientId, row.plexToken),
      signal: AbortSignal.timeout(5_000),
    });

    if (res.status === 401) {
      res.body?.cancel();
      // Token revoked — clear it so the client redirects to setup.
      await db.update(settings).set({ plexToken: null }).where(eq(settings.id, 1));
      clearPlexClientCache();
      return c.json({ configured: false, source: null, reason: 'token_revoked' });
    }
    if (!res.ok) {
      res.body?.cancel();
      return c.json({ configured: true, source: 'db', reachable: false });
    }
    res.body?.cancel();
  } catch {
    // Plex unreachable — treat as configured but warn so the client can surface it.
    return c.json({ configured: true, source: 'db', reachable: false });
  }

  return c.json({ configured: true, source: 'db', reachable: true });
});

export default router;
