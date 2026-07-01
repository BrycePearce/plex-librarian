import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { settings } from '../db/schema.ts';
import type { Settings } from '@plex-librarian/shared/types.ts';

const router = new Hono();

// GET /api/settings
router.get('/', async (c) => {
  const [row] = await db.select({ staleMinAgeDays: settings.staleMinAgeDays })
    .from(settings)
    .where(eq(settings.id, 1))
    .limit(1);

  return c.json({ staleMinAgeDays: row?.staleMinAgeDays ?? 90 } satisfies Settings);
});

// PATCH /api/settings
router.patch('/', async (c) => {
  const body = await c.req.json() as { staleMinAgeDays?: unknown };

  if (
    typeof body.staleMinAgeDays !== 'number' || !Number.isInteger(body.staleMinAgeDays) ||
    body.staleMinAgeDays < 0
  ) {
    return c.json({ error: 'staleMinAgeDays must be a non-negative integer' }, 400);
  }

  await db.insert(settings)
    .values({ id: 1, clientId: crypto.randomUUID(), staleMinAgeDays: body.staleMinAgeDays })
    .onConflictDoUpdate({
      target: settings.id,
      set: { staleMinAgeDays: body.staleMinAgeDays },
    });

  return c.json({ staleMinAgeDays: body.staleMinAgeDays } satisfies Settings);
});

export default router;
