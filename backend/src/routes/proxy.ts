import { Hono } from 'hono';
import { createPlexClient, PlexClient } from '../lib/plex.ts';

const router = new Hono();

const ALLOWED_PREFIXES = ['/library/', '/photo/'];

// Normalize the path using URL parsing so that traversal sequences like
// /library/../../etc/passwd are resolved before the prefix check.
// Returns the normalised pathname, or null if invalid.
function normaliseThumbPath(raw: string): string | null {
  if (!raw.startsWith('/')) return null;
  try {
    const { pathname } = new URL(raw, 'http://x');
    if (ALLOWED_PREFIXES.some((p) => pathname.startsWith(p))) return pathname;
  } catch { /* fall through */ }
  return null;
}

router.get('/thumb', async (c) => {
  const raw = c.req.query('path');
  const path = raw ? normaliseThumbPath(raw) : null;
  if (!path) return c.json({ error: 'invalid or missing path' }, 400);

  let plex: PlexClient;
  try {
    plex = await createPlexClient();
  } catch {
    return c.json({ error: 'Plex not configured' }, 503);
  }

  const width = c.req.query('width');
  const height = c.req.query('height');
  if ((width && !/^[1-9]\d*$/.test(width)) || (height && !/^[1-9]\d*$/.test(height))) {
    return c.json({ error: 'width and height must be positive integers' }, 400);
  }

  const fetchUrl = (width || height)
    ? plex.resizedAssetUrl(path, { width, height })
    : plex.assetUrl(path);

  let res: Response;
  try {
    res = await fetch(fetchUrl, { signal: AbortSignal.timeout(10_000) });
  } catch {
    return c.json({ error: 'failed to fetch from Plex' }, 502);
  }

  if (!res.ok) {
    res.body?.cancel();
    return c.body(null, res.status as Parameters<typeof c.body>[1]);
  }

  const contentType = res.headers.get('content-type') ?? 'image/jpeg';
  return new Response(res.body, {
    headers: {
      'content-type': contentType,
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
    },
  });
});

export default router;
