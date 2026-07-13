import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { settings } from '../../db/schema.ts';
import type { Settings } from '@plex-librarian/shared/types.ts';
import { MAX_INACTIVITY_DAYS, MIN_USER_ACTIVITY_RETENTION_DAYS } from '../../configLimits.ts';

const router = new Hono();

// GET /api/settings
router.get('/', async (c) => {
  const [row] = await db.select({
    staleMinAgeDays: settings.staleMinAgeDays,
    inactiveUserDays: settings.inactiveUserDays,
    pendingInviteStaleDays: settings.pendingInviteStaleDays,
    pendingInviteCriticalDays: settings.pendingInviteCriticalDays,
    ipHistoryRetentionDays: settings.ipHistoryRetentionDays,
  })
    .from(settings)
    .where(eq(settings.id, 1))
    .limit(1);

  return c.json(
    {
      staleMinAgeDays: row?.staleMinAgeDays ?? 90,
      inactiveUserDays: row?.inactiveUserDays ?? 90,
      pendingInviteStaleDays: row?.pendingInviteStaleDays ?? 30,
      pendingInviteCriticalDays: row?.pendingInviteCriticalDays ?? 90,
      ipHistoryRetentionDays: row?.ipHistoryRetentionDays ?? 365,
    } satisfies Settings,
  );
});

// PATCH /api/settings
// Only the keys present in the body are touched — omitting a key never resets it — so
// the Settings-page inputs (which save on their own debounce) can never clobber
// each other's value. Validation for both keys runs before either is written, so a
// request naming both keys is all-or-nothing: if either fails validation, the request
// is rejected and nothing is written, rather than applying the valid key silently.
router.patch('/', async (c) => {
  const body = await c.req.json() as {
    staleMinAgeDays?: unknown;
    inactiveUserDays?: unknown;
    pendingInviteStaleDays?: unknown;
    pendingInviteCriticalDays?: unknown;
    ipHistoryRetentionDays?: unknown;
  };

  const set: Partial<typeof settings.$inferInsert> = {};

  if (body.staleMinAgeDays !== undefined) {
    if (
      typeof body.staleMinAgeDays !== 'number' || !Number.isInteger(body.staleMinAgeDays) ||
      body.staleMinAgeDays < 0
    ) {
      return c.json({ error: 'staleMinAgeDays must be a non-negative integer' }, 400);
    }
    set.staleMinAgeDays = body.staleMinAgeDays;
  }

  if (body.inactiveUserDays !== undefined) {
    if (
      typeof body.inactiveUserDays !== 'number' || !Number.isInteger(body.inactiveUserDays) ||
      body.inactiveUserDays < 0 || body.inactiveUserDays > MAX_INACTIVITY_DAYS
    ) {
      return c.json({
        error: `inactiveUserDays must be an integer between 0 and ${MAX_INACTIVITY_DAYS}`,
      }, 400);
    }
    set.inactiveUserDays = body.inactiveUserDays;
  }

  if (body.pendingInviteStaleDays !== undefined) {
    if (
      typeof body.pendingInviteStaleDays !== 'number' ||
      !Number.isInteger(body.pendingInviteStaleDays) || body.pendingInviteStaleDays < 0 ||
      body.pendingInviteStaleDays > MAX_INACTIVITY_DAYS
    ) {
      return c.json({
        error: `pendingInviteStaleDays must be an integer between 0 and ${MAX_INACTIVITY_DAYS}`,
      }, 400);
    }
    set.pendingInviteStaleDays = body.pendingInviteStaleDays;
  }

  if (body.pendingInviteCriticalDays !== undefined) {
    if (
      typeof body.pendingInviteCriticalDays !== 'number' ||
      !Number.isInteger(body.pendingInviteCriticalDays) || body.pendingInviteCriticalDays < 0 ||
      body.pendingInviteCriticalDays > MAX_INACTIVITY_DAYS
    ) {
      return c.json({
        error:
          `overdue invitation threshold must be an integer between 0 and ${MAX_INACTIVITY_DAYS}`,
      }, 400);
    }
    set.pendingInviteCriticalDays = body.pendingInviteCriticalDays;
  }

  if (body.ipHistoryRetentionDays !== undefined) {
    if (
      typeof body.ipHistoryRetentionDays !== 'number' ||
      !Number.isInteger(body.ipHistoryRetentionDays) || body.ipHistoryRetentionDays < 0 ||
      (body.ipHistoryRetentionDays > 0 &&
        body.ipHistoryRetentionDays < MIN_USER_ACTIVITY_RETENTION_DAYS)
    ) {
      return c.json({
        error:
          `ipHistoryRetentionDays must be 0 (keep forever) or at least ${MIN_USER_ACTIVITY_RETENTION_DAYS}`,
      }, 400);
    }
    set.ipHistoryRetentionDays = body.ipHistoryRetentionDays;
  }

  if (body.pendingInviteStaleDays !== undefined || body.pendingInviteCriticalDays !== undefined) {
    const [current] = await db.select({
      stale: settings.pendingInviteStaleDays,
      critical: settings.pendingInviteCriticalDays,
    }).from(settings).where(eq(settings.id, 1)).limit(1);
    const effectiveStale = (body.pendingInviteStaleDays as number | undefined) ??
      current?.stale ?? 30;
    const effectiveCritical = (body.pendingInviteCriticalDays as number | undefined) ??
      current?.critical ?? 90;
    if (effectiveCritical < effectiveStale) {
      return c.json(
        { error: 'overdue invitation threshold must be at least the aging threshold' },
        400,
      );
    }
  }

  if (Object.keys(set).length === 0) {
    return c.json({ error: 'at least one settings field is required' }, 400);
  }

  await db.insert(settings)
    .values({ id: 1, clientId: crypto.randomUUID(), ...set })
    .onConflictDoUpdate({
      target: settings.id,
      set,
    });

  const [row] = await db.select({
    staleMinAgeDays: settings.staleMinAgeDays,
    inactiveUserDays: settings.inactiveUserDays,
    pendingInviteStaleDays: settings.pendingInviteStaleDays,
    pendingInviteCriticalDays: settings.pendingInviteCriticalDays,
    ipHistoryRetentionDays: settings.ipHistoryRetentionDays,
  })
    .from(settings)
    .where(eq(settings.id, 1))
    .limit(1);

  return c.json(
    {
      staleMinAgeDays: row!.staleMinAgeDays,
      inactiveUserDays: row!.inactiveUserDays,
      pendingInviteStaleDays: row!.pendingInviteStaleDays,
      pendingInviteCriticalDays: row!.pendingInviteCriticalDays,
      ipHistoryRetentionDays: row!.ipHistoryRetentionDays,
    } satisfies Settings,
  );
});

export default router;
