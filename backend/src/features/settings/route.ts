import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withTransaction } from '../../db/index.ts';
import { settings } from '../../db/schema.ts';
import type {
  PlexPathMapping,
  SavePlexPathMappingRequest,
  Settings,
} from '@plex-librarian/shared/types.ts';
import { resolveActiveServer } from '../../integrations/plex/index.ts';
import { MAX_INACTIVITY_DAYS, MIN_USER_ACTIVITY_RETENTION_DAYS } from '../../configLimits.ts';
import {
  DEFAULT_AUTO_SYNC_HOUR,
  DEFAULT_AUTO_SYNC_TIME_ZONE,
  isValidTimeZone,
} from '@plex-librarian/shared/schedule.ts';

const router = new Hono();

function normalizedPrefix(value: string, local: boolean): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  if (local && (!trimmed.startsWith('/') || trimmed.includes('\\'))) return null;
  const windows = !local && /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(trimmed);
  if (!local && !windows && !trimmed.startsWith('/')) return null;
  const separator = windows ? '\\' : '/';
  const normalized = trimmed.replace(windows ? /\//g : /\\/g, separator);
  if (normalized.split(separator).includes('..')) return null;
  if (normalized === separator || /^[a-zA-Z]:\\$/.test(normalized)) return normalized;
  return normalized.replace(windows ? /\\+$/ : /\/+$/, '');
}

function mappedPath(
  path: string,
  source: string,
  destination: string,
  caseSensitive: boolean,
): string | null {
  const windows = source.includes('\\');
  const separator = windows ? '\\' : '/';
  const fold = (value: string) => caseSensitive ? value : value.toLocaleLowerCase('en-US');
  if (
    fold(path) !== fold(source) &&
    !fold(path).startsWith(`${fold(source)}${separator}`)
  ) return null;
  const suffix = path.slice(source.length).replace(/^[/\\]+/, '');
  return suffix
    ? `${destination.replace(/\/+$/, '')}/${suffix.replaceAll('\\', '/')}`
    : destination;
}

function prefixesOverlap(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase('en-US');
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function publicPlexMapping(row: {
  id: number;
  serverId: number;
  libraryKey: string;
  plexPath: string;
  localPath: string;
  caseSensitive: number;
  revision: number;
  validationPlexPath: string;
  validationLocalPath: string;
  validationSize: number;
  validatedAt: number;
}): PlexPathMapping {
  return { ...row, caseSensitive: row.caseSensitive === 1 };
}

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

// App-managed Plex -> Plex Librarian namespace mappings. They intentionally live
// under settings rather than Arr mappings: a separately-containerized Plex server
// is an independent namespace edge.
router.get('/plex-path-mappings', async (c) => {
  const active = await resolveActiveServer().catch(() => null);
  if (!active) return c.json({ error: 'Plex is not configured' }, 404);
  const rows = withTransaction((client) =>
    client.prepare(
      `SELECT id, server_id, library_key, plex_path, local_path, case_sensitive, revision,
              validation_plex_path, validation_local_path, validation_size, validated_at
       FROM plex_path_mappings WHERE server_id = ? ORDER BY library_key, plex_path`,
    ).all<{
      id: number;
      server_id: number;
      library_key: string;
      plex_path: string;
      local_path: string;
      case_sensitive: number;
      revision: number;
      validation_plex_path: string;
      validation_local_path: string;
      validation_size: number;
      validated_at: number;
    }>(active.serverId)
  );
  return c.json(rows.map((row) =>
    publicPlexMapping({
      id: row.id,
      serverId: row.server_id,
      libraryKey: row.library_key,
      plexPath: row.plex_path,
      localPath: row.local_path,
      caseSensitive: row.case_sensitive,
      revision: row.revision,
      validationPlexPath: row.validation_plex_path,
      validationLocalPath: row.validation_local_path,
      validationSize: row.validation_size,
      validatedAt: row.validated_at,
    })
  ));
});

async function validatePlexMappingRequest(
  body: Partial<SavePlexPathMappingRequest>,
  excludeId?: number,
): Promise<
  | {
    active: Awaited<ReturnType<typeof resolveActiveServer>>;
    request: SavePlexPathMappingRequest;
    plexPath: string;
    localPath: string;
    validationPlexPath: string;
    validationLocalPath: string;
    validationSize: number;
  }
  | { error: string; status: 400 | 404 | 409 }
> {
  if (
    typeof body.libraryKey !== 'string' || typeof body.plexPath !== 'string' ||
    typeof body.localPath !== 'string' || typeof body.caseSensitive !== 'boolean' ||
    typeof body.sampleRatingKey !== 'string' ||
    !Number.isSafeInteger(body.sampleMediaId) || body.sampleMediaId! < 0
  ) return { error: 'invalid Plex path mapping request', status: 400 };
  const plexPath = normalizedPrefix(body.plexPath, false);
  const localPath = normalizedPrefix(body.localPath, true);
  if (!plexPath || !localPath) {
    return { error: 'mapping prefixes must be absolute and traversal-free', status: 400 };
  }
  const active = await resolveActiveServer().catch(() => null);
  if (!active) return { error: 'Plex is not configured', status: 404 };
  const libraryExists = withTransaction((client) =>
    client.prepare('SELECT 1 FROM libraries WHERE server_id = ? AND key = ?').value<[number]>(
      active.serverId,
      body.libraryKey!,
    ) !== undefined
  );
  if (!libraryExists) return { error: 'Plex library was not found', status: 404 };
  const overlapping = withTransaction((client) =>
    client.prepare(
      'SELECT id, plex_path, local_path FROM plex_path_mappings WHERE server_id = ? AND library_key = ?',
    ).all<{ id: number; plex_path: string; local_path: string }>(active.serverId, body.libraryKey!)
      .some((mapping) =>
        mapping.id !== excludeId &&
        (prefixesOverlap(mapping.plex_path, plexPath) ||
          prefixesOverlap(mapping.local_path, localPath))
      )
  );
  if (overlapping) {
    return {
      error: 'Plex path mappings for one library cannot overlap or case-collide',
      status: 409,
    };
  }
  let live: { path: string; size: number };
  try {
    live = await active.client.exactLibraryMediaPath(
      body.libraryKey,
      body.sampleRatingKey,
      body.sampleMediaId!,
    );
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Plex mapping validation failed',
      status: 409,
    };
  }
  const validationLocalPath = mappedPath(
    live.path,
    plexPath,
    localPath,
    body.caseSensitive,
  );
  if (!validationLocalPath) {
    return { error: 'The live Plex sample is not beneath the Plex mapping prefix', status: 409 };
  }
  try {
    const stat = await Deno.stat(validationLocalPath);
    if (!stat.isFile || stat.size !== live.size) {
      return {
        error: 'The mapped local sample is not a file with the exact Plex-reported size',
        status: 409,
      };
    }
  } catch {
    return { error: 'The mapped local sample is not visible to Plex Librarian', status: 409 };
  }
  return {
    active,
    request: body as SavePlexPathMappingRequest,
    plexPath,
    localPath,
    validationPlexPath: live.path,
    validationLocalPath,
    validationSize: live.size,
  };
}

router.post('/plex-path-mappings', async (c) => {
  const validated = await validatePlexMappingRequest(
    await c.req.json().catch(() => ({})) as Partial<SavePlexPathMappingRequest>,
  );
  if ('error' in validated) return c.json({ error: validated.error }, validated.status);
  const now = Math.floor(Date.now() / 1000);
  const id = withTransaction((client) =>
    client.prepare(
      `INSERT INTO plex_path_mappings
       (server_id, library_key, plex_path, local_path, case_sensitive, revision,
        validation_plex_path, validation_local_path, validation_size, validated_at,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).value<[number]>(
      validated.active.serverId,
      validated.request.libraryKey,
      validated.plexPath,
      validated.localPath,
      validated.request.caseSensitive ? 1 : 0,
      validated.validationPlexPath,
      validated.validationLocalPath,
      validated.validationSize,
      now,
      now,
      now,
    )![0]
  );
  return c.json({ id, revision: 1 }, 201);
});

router.put('/plex-path-mappings/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: 'invalid mapping id' }, 400);
  const owner = withTransaction((client) =>
    client.prepare('SELECT server_id FROM plex_path_mappings WHERE id = ?').value<[number]>(id)
  );
  if (!owner) return c.json({ error: 'mapping not found' }, 404);
  const validated = await validatePlexMappingRequest(
    await c.req.json().catch(() => ({})) as Partial<SavePlexPathMappingRequest>,
    id,
  );
  if ('error' in validated) return c.json({ error: validated.error }, validated.status);
  if (owner[0] !== validated.active.serverId) return c.json({ error: 'mapping not found' }, 404);
  const now = Math.floor(Date.now() / 1000);
  const revision = withTransaction((client) =>
    client.prepare(
      `UPDATE plex_path_mappings SET library_key = ?, plex_path = ?, local_path = ?,
       case_sensitive = ?, revision = revision + 1, validation_plex_path = ?,
       validation_local_path = ?, validation_size = ?, validated_at = ?, updated_at = ?
       WHERE id = ? AND server_id = ? RETURNING revision`,
    ).value<[number]>(
      validated.request.libraryKey,
      validated.plexPath,
      validated.localPath,
      validated.request.caseSensitive ? 1 : 0,
      validated.validationPlexPath,
      validated.validationLocalPath,
      validated.validationSize,
      now,
      now,
      id,
      validated.active.serverId,
    )![0]
  );
  return c.json({ id, revision });
});

router.delete('/plex-path-mappings/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: 'invalid mapping id' }, 400);
  const active = await resolveActiveServer().catch(() => null);
  if (!active) return c.json({ error: 'Plex is not configured' }, 404);
  const changes = withTransaction((client) =>
    client.prepare('DELETE FROM plex_path_mappings WHERE id = ? AND server_id = ?').run(
      id,
      active.serverId,
    )
  );
  if (changes !== 1) return c.json({ error: 'mapping not found' }, 404);
  return c.body(null, 204);
});

export default router;
