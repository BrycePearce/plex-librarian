import { Hono } from 'hono';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm';
import { db } from '../db/index.ts';
import { servers, settings, userPlayObservations, users } from '../db/schema.ts';
import { userByAccountId, usersByServer } from '../db/scope.ts';
import { type ActiveServerVariables, withActiveServerId } from '../middleware/activeServer.ts';
import { getActiveServer } from '../lib/plex.ts';
import { PlexRemoveUserError, removeUserAccess } from '../lib/plexUsers.ts';
import { logEvents } from '../services/events.ts';
import {
  assessUserSharingRisk,
  type SharingObservationStats,
} from '../services/userSharingRisk.ts';
import type { PlexUser, RemoveUserResponse, UsersResponse } from '@plex-librarian/shared/types.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);

const SORT_COLUMNS = {
  lastViewedAt: users.lastViewedAt,
  username: users.username,
} as const;
type SortKey = keyof typeof SORT_COLUMNS;

const DEFAULT_INACTIVE_DAYS = 30;

async function sharingStatsForAccounts(
  serverId: number,
  accountIds: number[],
  riskWindowCutoff: number,
): Promise<Map<number, SharingObservationStats>> {
  // Aggregate only the users on this page. Two grouped scans replace several
  // correlated observation scans per row and keep memory bounded by the page limit.
  const result = new Map<number, SharingObservationStats>();
  if (accountIds.length === 0) return result;

  const observation = userPlayObservations;
  const [aggregates, dailyRemoteNetworks] = await Promise.all([
    db.select({
      accountId: observation.accountId,
      observationCount: sql<number>`count(*)`,
      firstObservedAt: sql<number>`min(${observation.observedAt})`,
      lastObservedAt: sql<number>`max(${observation.observedAt})`,
      activeDays: sql<number>`count(DISTINCT date(${observation.observedAt}, 'unixepoch'))`,
      completeObservationCount: sql<number>`sum(
        CASE WHEN ${observation.ip} IS NOT NULL AND ${observation.playerUuid} IS NOT NULL
          THEN 1 ELSE 0 END
      )`,
      remoteNetworks30d: sql<number>`count(DISTINCT CASE
        WHEN ${observation.observedAt} >= ${riskWindowCutoff} AND ${observation.isLocal} = 0
          THEN coalesce(${observation.networkKey}, ${observation.ip}) END
      )`,
      remotePlayers30d: sql<number>`count(DISTINCT CASE
        WHEN ${observation.observedAt} >= ${riskWindowCutoff} AND ${observation.isLocal} = 0
          THEN ${observation.playerUuid} END
      )`,
    })
      .from(observation)
      .where(and(
        eq(observation.serverId, serverId),
        inArray(observation.accountId, accountIds),
        eq(observation.event, 'media.play'),
      ))
      .groupBy(observation.accountId),
    db.select({
      accountId: observation.accountId,
      networkCount: sql<number>`count(DISTINCT coalesce(
        ${observation.networkKey}, ${observation.ip}
      ))`,
    })
      .from(observation)
      .where(and(
        eq(observation.serverId, serverId),
        inArray(observation.accountId, accountIds),
        eq(observation.event, 'media.play'),
        eq(observation.isLocal, false),
        isNotNull(observation.ip),
        gte(observation.observedAt, riskWindowCutoff),
      ))
      .groupBy(observation.accountId, sql`date(${observation.observedAt}, 'unixepoch')`),
  ]);

  const maxRemoteNetworksByAccount = new Map<number, number>();
  for (const row of dailyRemoteNetworks) {
    maxRemoteNetworksByAccount.set(
      row.accountId,
      Math.max(maxRemoteNetworksByAccount.get(row.accountId) ?? 0, row.networkCount),
    );
  }

  for (const row of aggregates) {
    result.set(row.accountId, {
      observationCount: row.observationCount,
      firstObservedAt: row.firstObservedAt,
      lastObservedAt: row.lastObservedAt,
      activeDays: row.activeDays,
      completeObservationCount: row.completeObservationCount,
      remoteNetworks30d: row.remoteNetworks30d,
      remotePlayers30d: row.remotePlayers30d,
      maxRemoteNetworksPerDay30d: maxRemoteNetworksByAccount.get(row.accountId) ?? 0,
    });
  }

  return result;
}

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
    }).from(users).where(where).orderBy(order(SORT_COLUMNS[sort])).limit(limit).offset(offset),
  ]);

  const sharingStats = await sharingStatsForAccounts(
    serverId,
    rows.map((row) => row.accountId),
    riskWindowCutoff,
  );

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
        sharingRisk: assessUserSharingRisk(sharingStats.get(u.accountId) ?? {
          observationCount: 0,
          firstObservedAt: null,
          lastObservedAt: null,
          activeDays: 0,
          completeObservationCount: 0,
          remoteNetworks30d: 0,
          remotePlayers30d: 0,
          maxRemoteNetworksPerDay30d: 0,
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
