import { Hono } from 'hono';
import { and, asc, count, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { servers, settings, users } from '../db/schema.ts';
import { userByAccountId, usersByServer } from '../db/scope.ts';
import { type ActiveServerVariables, withActiveServerId } from '../middleware/activeServer.ts';
import { getActiveServer } from '../lib/plex.ts';
import { PlexRemoveUserError, removeUserAccess } from '../lib/plexUsers.ts';
import { logEvents } from '../services/events.ts';
import { assessUserSharingRisk } from '../services/userSharingRisk.ts';
import type { PlexUser, RemoveUserResponse, UsersResponse } from '@plex-librarian/shared/types.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);

const SORT_COLUMNS = {
  lastViewedAt: users.lastViewedAt,
  username: users.username,
} as const;
type SortKey = keyof typeof SORT_COLUMNS;

const DEFAULT_INACTIVE_DAYS = 30;

// Small dataset by nature (server users, not media), so a single count()+select() pair
// is plenty; no GROUP_FETCH_CAP-style two-pass fetch needed like duplicates.ts (that
// one caps an aggregate query, this isn't one).
router.get('/', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) {
    // settings is a singleton independent of server-connection state, so an admin who's
    // changed the threshold before finishing setup still sees their saved value here,
    // not the hardcoded default — matching the normal (serverId !== null) path below.
    const [settingsRow] = await db.select({ inactiveUserDays: settings.inactiveUserDays })
      .from(settings).where(eq(settings.id, 1)).limit(1);
    return c.json(
      {
        usersSyncedAt: null,
        inactiveDays: settingsRow?.inactiveUserDays ?? DEFAULT_INACTIVE_DAYS,
        limit: 100,
        offset: 0,
        total: 0,
        users: [],
      } satisfies UsersResponse,
    );
  }

  const [[serverRow], [settingsRow]] = await Promise.all([
    db.select({ usersSyncedAt: servers.usersSyncedAt }).from(servers).where(
      eq(servers.id, serverId),
    )
      .limit(1),
    db.select({ inactiveUserDays: settings.inactiveUserDays }).from(settings).where(
      eq(settings.id, 1),
    )
      .limit(1),
  ]);
  const usersSyncedAt = serverRow?.usersSyncedAt ?? null;

  const rawInactiveDays = c.req.query('inactiveDays');
  const parsedInactiveDays = rawInactiveDays !== undefined ? parseInt(rawInactiveDays, 10) : NaN;
  const inactiveDays = !Number.isNaN(parsedInactiveDays) && parsedInactiveDays >= 0
    ? parsedInactiveDays
    : settingsRow?.inactiveUserDays ?? DEFAULT_INACTIVE_DAYS;

  // filter=all (default): every user with access
  // filter=inactive: never watched, or last watched before the inactiveDays cutoff
  const filter = c.req.query('filter') === 'inactive' ? 'inactive' : 'all';

  const rawSort = c.req.query('sort') ?? 'lastViewedAt';
  const sort: SortKey = rawSort in SORT_COLUMNS ? rawSort as SortKey : 'lastViewedAt';
  // Default asc, not desc: SQLite sorts NULL first in ASC, so the default view leads
  // with never-watched users (lastViewedAt IS NULL) and the longest-idle accounts —
  // the cases an "inactive users" feature exists to surface — rather than burying them
  // after everyone who's ever watched anything, which a desc default would do.
  const orderStr = c.req.query('order') === 'desc' ? 'desc' : 'asc';
  const order = orderStr === 'asc' ? asc : desc;

  const rawLimit = parseInt(c.req.query('limit') ?? '100', 10);
  const limit = Number.isNaN(rawLimit) || rawLimit <= 0 ? 100 : Math.min(rawLimit, 500);
  const rawOffset = parseInt(c.req.query('offset') ?? '0', 10);
  const offset = Number.isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - inactiveDays * 86400;
  const riskWindowCutoff = now - 30 * 86400;
  const inactiveCond = or(isNull(users.lastViewedAt), lt(users.lastViewedAt, cutoff));

  const where = filter === 'inactive'
    ? and(usersByServer(serverId), inactiveCond)
    : usersByServer(serverId);

  const [[{ total }], rows] = await Promise.all([
    db.select({ total: count() }).from(users).where(where),
    db.select({
      accountId: users.accountId,
      username: users.username,
      email: users.email,
      thumb: users.thumb,
      isOwner: users.isOwner,
      lastViewedAt: users.lastViewedAt,
      observationCount: sql<number>`(
        SELECT count(*) FROM user_play_observations o
        WHERE o.server_id = ${serverId} AND o.account_id = ${users.accountId}
          AND o.event = 'media.play'
      )`,
      firstObservedAt: sql<number | null>`(
        SELECT min(o.observed_at) FROM user_play_observations o
        WHERE o.server_id = ${serverId} AND o.account_id = ${users.accountId}
          AND o.event = 'media.play'
      )`,
      lastObservedAt: sql<number | null>`(
        SELECT max(o.observed_at) FROM user_play_observations o
        WHERE o.server_id = ${serverId} AND o.account_id = ${users.accountId}
          AND o.event = 'media.play'
      )`,
      activeDays: sql<number>`(
        SELECT count(DISTINCT date(o.observed_at, 'unixepoch'))
        FROM user_play_observations o
        WHERE o.server_id = ${serverId} AND o.account_id = ${users.accountId}
          AND o.event = 'media.play'
      )`,
      completeObservationCount: sql<number>`(
        SELECT count(*) FROM user_play_observations o
        WHERE o.server_id = ${serverId} AND o.account_id = ${users.accountId}
          AND o.event = 'media.play' AND o.ip IS NOT NULL AND o.player_uuid IS NOT NULL
      )`,
      remoteNetworks30d: sql<number>`(
        SELECT count(DISTINCT coalesce(o.network_key, o.ip)) FROM user_play_observations o
        WHERE o.server_id = ${serverId} AND o.account_id = ${users.accountId}
          AND o.event = 'media.play' AND o.observed_at >= ${riskWindowCutoff}
          AND o.is_local = 0 AND o.ip IS NOT NULL
      )`,
      remotePlayers30d: sql<number>`(
        SELECT count(DISTINCT o.player_uuid) FROM user_play_observations o
        WHERE o.server_id = ${serverId} AND o.account_id = ${users.accountId}
          AND o.event = 'media.play' AND o.observed_at >= ${riskWindowCutoff}
          AND o.is_local = 0 AND o.player_uuid IS NOT NULL
      )`,
      maxRemoteNetworksPerDay30d: sql<number>`coalesce((
        SELECT max(network_count) FROM (
          SELECT count(DISTINCT coalesce(o.network_key, o.ip)) AS network_count
          FROM user_play_observations o
          WHERE o.server_id = ${serverId} AND o.account_id = ${users.accountId}
            AND o.event = 'media.play' AND o.observed_at >= ${riskWindowCutoff}
            AND o.is_local = 0 AND o.ip IS NOT NULL
          GROUP BY date(o.observed_at, 'unixepoch')
        )
      ), 0)`,
    }).from(users).where(where).orderBy(order(SORT_COLUMNS[sort])).limit(limit).offset(offset),
  ]);

  return c.json(
    {
      usersSyncedAt,
      inactiveDays,
      limit,
      offset,
      total,
      users: rows.map((u): PlexUser => ({
        accountId: u.accountId,
        username: u.username,
        email: u.email,
        thumb: u.thumb,
        isOwner: u.isOwner,
        lastViewedAt: u.lastViewedAt,
        sharingRisk: assessUserSharingRisk({
          observationCount: u.observationCount,
          firstObservedAt: u.firstObservedAt,
          lastObservedAt: u.lastObservedAt,
          activeDays: u.activeDays,
          completeObservationCount: u.completeObservationCount,
          remoteNetworks30d: u.remoteNetworks30d,
          remotePlayers30d: u.remotePlayers30d,
          maxRemoteNetworksPerDay30d: u.maxRemoteNetworksPerDay30d,
        }),
      })),
    } satisfies UsersResponse,
  );
});

// Revokes a user's access to THIS server (not "unfriend everywhere" — see
// removeUserAccess's comment in plexUsers.ts for why that distinction matters).
// Genuinely destructive and effectively irreversible from within this app — the only
// way back is re-inviting the person through Plex directly.
//
// Unlike the media-version delete routes in duplicates.ts, there's no local
// "reservation" step before calling Plex: a user row isn't a shared/contended counter
// the way item_media_versions rows are (no analogous last-version race), so the
// simpler and safer order is Plex-call-first — the local row is only removed once Plex
// confirms the access is actually gone (or already gone; a 404 is tolerated as success,
// same precedent as duplicates.ts's deletePlexMediaTolerating404). A failed Plex call
// this way leaves local state matching reality instead of needing a compensating
// rollback.
router.delete('/:accountId', async (c) => {
  const accountId = parseInt(c.req.param('accountId'), 10);
  if (Number.isNaN(accountId)) return c.json({ error: 'accountId must be an integer' }, 400);

  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'user not found' }, 404);

  const [target] = await db.select({
    username: users.username,
    isOwner: users.isOwner,
    sharedServerId: users.sharedServerId,
  })
    .from(users)
    .where(userByAccountId(serverId, accountId))
    .limit(1);
  if (!target) return c.json({ error: 'user not found' }, 404);
  if (target.isOwner) return c.json({ error: 'cannot remove the server owner' }, 400);
  if (target.sharedServerId === null) {
    return c.json({
      error: 'no shared-server record for this user yet — try syncing first',
    }, 400);
  }

  const active = await getActiveServer();
  if (!active || active.serverId !== serverId) {
    return c.json({ error: 'Plex is not configured' }, 502);
  }

  try {
    await removeUserAccess(
      active.clientId,
      active.accessToken,
      active.machineIdentifier,
      target.sharedServerId,
    );
  } catch (err) {
    if (!(err instanceof PlexRemoveUserError && err.status === 404)) {
      return c.json({ error: err instanceof Error ? err.message : 'remove failed' }, 502);
    }
  }

  // Plex access is already revoked at this point — that's the source of truth, and the
  // next roster sync prunes this row regardless. Don't let a local DB hiccup here turn
  // into a 500 that makes the caller think the removal itself failed and worth retrying
  // (retrying would just hit removeUserAccess's already-handled 404-as-success path).
  try {
    await db.delete(users).where(userByAccountId(serverId, accountId));
  } catch (err) {
    console.error(
      `Failed to delete local users row for accountId ${accountId} after Plex removal succeeded:`,
      err,
    );
  }

  await logEvents([{
    serverId,
    type: 'user.removed',
    payload: { accountId, username: target.username },
  }]);

  return c.json({ accountId, username: target.username } satisfies RemoveUserResponse);
});

export default router;
