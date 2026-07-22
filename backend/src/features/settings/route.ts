import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { settings } from '../../db/schema.ts';
import type { Settings } from '@plex-librarian/shared/types.ts';
import { MAX_INACTIVITY_DAYS, MIN_USER_ACTIVITY_RETENTION_DAYS } from '../../configLimits.ts';
import {
  DEFAULT_AUTO_SYNC_HOUR,
  DEFAULT_AUTO_SYNC_TIME_ZONE,
  isValidTimeZone,
} from '@plex-librarian/shared/schedule.ts';

const router = new Hono();

// GET /api/settings
router.get('/', async (c) => {
  const [row] = await db.select({
    autoSyncEnabled: settings.autoSyncEnabled,
    autoSyncHour: settings.autoSyncHour,
    autoSyncTimeZone: settings.autoSyncTimeZone,
    autoSyncCatchUp: settings.autoSyncCatchUp,
    staleMinAgeDays: settings.staleMinAgeDays,
    inactiveUserDays: settings.inactiveUserDays,
    requestFollowThroughGraceDays: settings.requestFollowThroughGraceDays,
    requestFollowThroughMinRequests: settings.requestFollowThroughMinRequests,
    pendingInviteStaleDays: settings.pendingInviteStaleDays,
    pendingInviteCriticalDays: settings.pendingInviteCriticalDays,
    ipHistoryRetentionDays: settings.ipHistoryRetentionDays,
  })
    .from(settings)
    .where(eq(settings.id, 1))
    .limit(1);

  return c.json(
    {
      autoSyncEnabled: row?.autoSyncEnabled ?? true,
      autoSyncHour: row?.autoSyncHour ?? DEFAULT_AUTO_SYNC_HOUR,
      autoSyncTimeZone: row?.autoSyncTimeZone ?? DEFAULT_AUTO_SYNC_TIME_ZONE,
      autoSyncCatchUp: row?.autoSyncCatchUp ?? true,
      staleMinAgeDays: row?.staleMinAgeDays ?? 90,
      inactiveUserDays: row?.inactiveUserDays ?? 90,
      requestFollowThroughGraceDays: row?.requestFollowThroughGraceDays ?? 30,
      requestFollowThroughMinRequests: row?.requestFollowThroughMinRequests ?? 5,
      pendingInviteStaleDays: row?.pendingInviteStaleDays ?? 30,
      pendingInviteCriticalDays: row?.pendingInviteCriticalDays ?? 90,
      ipHistoryRetentionDays: row?.ipHistoryRetentionDays ?? 365,
    } satisfies Settings,
  );
});

// PATCH /api/settings
// Only the keys present in the body are touched — omitting a key never resets it — so
// independently-saving Settings controls cannot clobber each other. Every supplied
// field is validated before the update is written, making a multi-field request
// all-or-nothing rather than silently applying only its valid values.
router.patch('/', async (c) => {
  const body = await c.req.json() as {
    autoSyncEnabled?: unknown;
    autoSyncHour?: unknown;
    autoSyncTimeZone?: unknown;
    autoSyncCatchUp?: unknown;
    staleMinAgeDays?: unknown;
    inactiveUserDays?: unknown;
    requestFollowThroughGraceDays?: unknown;
    requestFollowThroughMinRequests?: unknown;
    pendingInviteStaleDays?: unknown;
    pendingInviteCriticalDays?: unknown;
    ipHistoryRetentionDays?: unknown;
  };

  const set: Partial<typeof settings.$inferInsert> = {};

  if (body.autoSyncEnabled !== undefined) {
    if (typeof body.autoSyncEnabled !== 'boolean') {
      return c.json({ error: 'autoSyncEnabled must be a boolean' }, 400);
    }
    set.autoSyncEnabled = body.autoSyncEnabled;
  }

  if (body.autoSyncHour !== undefined) {
    if (
      typeof body.autoSyncHour !== 'number' || !Number.isInteger(body.autoSyncHour) ||
      body.autoSyncHour < 0 || body.autoSyncHour > 23
    ) {
      return c.json({ error: 'autoSyncHour must be an integer between 0 and 23' }, 400);
    }
    set.autoSyncHour = body.autoSyncHour;
  }

  if (body.autoSyncTimeZone !== undefined) {
    if (typeof body.autoSyncTimeZone !== 'string' || !isValidTimeZone(body.autoSyncTimeZone)) {
      return c.json({ error: 'autoSyncTimeZone must be a valid IANA time zone' }, 400);
    }
    set.autoSyncTimeZone = body.autoSyncTimeZone;
  }

  if (body.autoSyncCatchUp !== undefined) {
    if (typeof body.autoSyncCatchUp !== 'boolean') {
      return c.json({ error: 'autoSyncCatchUp must be a boolean' }, 400);
    }
    set.autoSyncCatchUp = body.autoSyncCatchUp;
  }

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

  if (body.requestFollowThroughGraceDays !== undefined) {
    if (
      typeof body.requestFollowThroughGraceDays !== 'number' ||
      !Number.isInteger(body.requestFollowThroughGraceDays) ||
      body.requestFollowThroughGraceDays < 0 ||
      body.requestFollowThroughGraceDays > MAX_INACTIVITY_DAYS
    ) {
      return c.json({
        error:
          `requestFollowThroughGraceDays must be an integer between 0 and ${MAX_INACTIVITY_DAYS}`,
      }, 400);
    }
    set.requestFollowThroughGraceDays = body.requestFollowThroughGraceDays;
  }

  if (body.requestFollowThroughMinRequests !== undefined) {
    if (
      typeof body.requestFollowThroughMinRequests !== 'number' ||
      !Number.isInteger(body.requestFollowThroughMinRequests) ||
      body.requestFollowThroughMinRequests < 1 || body.requestFollowThroughMinRequests > 10_000
    ) {
      return c.json({
        error: 'requestFollowThroughMinRequests must be an integer between 1 and 10000',
      }, 400);
    }
    set.requestFollowThroughMinRequests = body.requestFollowThroughMinRequests;
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
    autoSyncEnabled: settings.autoSyncEnabled,
    autoSyncHour: settings.autoSyncHour,
    autoSyncTimeZone: settings.autoSyncTimeZone,
    autoSyncCatchUp: settings.autoSyncCatchUp,
    staleMinAgeDays: settings.staleMinAgeDays,
    inactiveUserDays: settings.inactiveUserDays,
    requestFollowThroughGraceDays: settings.requestFollowThroughGraceDays,
    requestFollowThroughMinRequests: settings.requestFollowThroughMinRequests,
    pendingInviteStaleDays: settings.pendingInviteStaleDays,
    pendingInviteCriticalDays: settings.pendingInviteCriticalDays,
    ipHistoryRetentionDays: settings.ipHistoryRetentionDays,
  })
    .from(settings)
    .where(eq(settings.id, 1))
    .limit(1);

  return c.json(
    {
      autoSyncEnabled: row!.autoSyncEnabled,
      autoSyncHour: row!.autoSyncHour,
      autoSyncTimeZone: row!.autoSyncTimeZone ?? DEFAULT_AUTO_SYNC_TIME_ZONE,
      autoSyncCatchUp: row!.autoSyncCatchUp,
      staleMinAgeDays: row!.staleMinAgeDays,
      inactiveUserDays: row!.inactiveUserDays,
      requestFollowThroughGraceDays: row!.requestFollowThroughGraceDays,
      requestFollowThroughMinRequests: row!.requestFollowThroughMinRequests,
      pendingInviteStaleDays: row!.pendingInviteStaleDays,
      pendingInviteCriticalDays: row!.pendingInviteCriticalDays,
      ipHistoryRetentionDays: row!.ipHistoryRetentionDays,
    } satisfies Settings,
  );
});

export default router;
