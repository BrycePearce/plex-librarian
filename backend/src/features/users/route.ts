import { Hono } from 'hono';
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { libraries, servers, settings, userPlayObservations, users } from '../../db/schema.ts';
import { userByAccountId, usersByServer } from '../../db/scope.ts';
import { parseSearchQuery } from '../../http/searchQuery.ts';
import { type ActiveServerVariables, withActiveServerId } from '../../middleware/activeServer.ts';
import { getActiveServer } from '../../integrations/plex/index.ts';
import {
  cancelPendingServerInvitation,
  fetchPendingServerInvitations,
  PlexPendingInvitationError,
  PlexRemoveUserError,
  removeUserAccess,
} from '../../integrations/plex/accounts.ts';
import { logEvents } from '../events/service.ts';
import { assessUserSharingRisk, type SharingObservationStats } from './sharingRisk.ts';
import { sharingPlaybackPatterns } from './playbackPatterns.ts';
import { getSessionMonitorHealth } from './sessionMonitor.ts';
import type {
  CancelPendingInvitationResponse,
  PendingInvitationsResponse,
  PlexUser,
  RemoveUserResponse,
  UsersActivityFilter,
  UsersResponse,
  UsersRiskFilter,
  UsersSortKey,
} from '@plex-librarian/shared/types.ts';
import { MAX_INACTIVITY_DAYS } from '../../configLimits.ts';
import {
  userActivityStatus,
  userHistoryCanBeAttributed,
  userHistoryIsComplete,
} from './activityStatus.ts';
import { assessRequestFollowThrough, requestFollowThroughWindow } from './requestFollowThrough.ts';
import { queryRequestFollowThrough } from './requestFollowThroughQuery.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
router.use('*', withActiveServerId);

const DEFAULT_INACTIVE_DAYS = 90;
const DEFAULT_REQUEST_GRACE_DAYS = 30;
const DEFAULT_REQUEST_MINIMUM = 5;
const PENDING_INVITATION_CACHE_MS = 60_000;
const pendingInvitationCache = new Map<
  number,
  {
    expiresAt: number;
    value: Promise<Awaited<ReturnType<typeof fetchPendingServerInvitations>>>;
  }
>();

function cachedPendingInvitations(
  active: NonNullable<Awaited<ReturnType<typeof getActiveServer>>>,
) {
  const cached = pendingInvitationCache.get(active.serverId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = fetchPendingServerInvitations(
    active.clientId,
    active.accessToken,
    active.machineIdentifier,
  ).catch((err) => {
    pendingInvitationCache.delete(active.serverId);
    throw err;
  });
  pendingInvitationCache.set(active.serverId, {
    expiresAt: Date.now() + PENDING_INVITATION_CACHE_MS,
    value,
  });
  return value;
}

async function sharingStatsForAccounts(
  serverId: number,
  accountIds: number[],
  riskWindowCutoff: number,
): Promise<Map<number, SharingObservationStats>> {
  // Aggregate only the requested users. One grouped scan plus one bounded 30-day
  // lifecycle scan replaces several correlated observation scans per row.
  const result = new Map<number, SharingObservationStats>();
  if (accountIds.length === 0) return result;

  const observation = userPlayObservations;
  const [aggregates, recentPlayback] = await Promise.all([
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
        gte(observation.observedAt, riskWindowCutoff),
      ))
      .groupBy(observation.accountId),
    db.select({
      accountId: observation.accountId,
      observedAt: observation.observedAt,
      event: observation.event,
      ip: observation.ip,
      networkKey: observation.networkKey,
      playerUuid: observation.playerUuid,
      isLocal: observation.isLocal,
    })
      .from(observation)
      .where(and(
        eq(observation.serverId, serverId),
        inArray(observation.accountId, accountIds),
        gte(observation.observedAt, riskWindowCutoff),
      ))
      .orderBy(asc(observation.accountId), asc(observation.observedAt), asc(observation.id)),
  ]);

  const playbackPatterns = sharingPlaybackPatterns(recentPlayback);

  for (const row of aggregates) {
    result.set(row.accountId, {
      observationCount: row.observationCount,
      firstObservedAt: row.firstObservedAt,
      lastObservedAt: row.lastObservedAt,
      activeDays: row.activeDays,
      completeObservationCount: row.completeObservationCount,
      remoteNetworks30d: row.remoteNetworks30d,
      remotePlayers30d: row.remotePlayers30d,
      maxRemoteNetworksPerHour30d: playbackPatterns.get(row.accountId)?.maxRemoteNetworksPerHour ??
        0,
      concurrentRemotePlaybackDays30d:
        playbackPatterns.get(row.accountId)?.concurrentRemotePlaybackDays ?? 0,
    });
  }

  return result;
}

// Small dataset by nature (server users, not media), so fetching the matching roster
// before derived-risk filtering and pagination stays bounded in normal operation.
router.get('/', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) {
    // settings is a singleton independent of server-connection state, so an admin who's
    // changed the threshold before finishing setup still sees their saved value here,
    // not the hardcoded default — matching the normal (serverId !== null) path below.
    const [settingsRow] = await db.select({
      inactiveUserDays: settings.inactiveUserDays,
      requestFollowThroughGraceDays: settings.requestFollowThroughGraceDays,
      requestFollowThroughMinRequests: settings.requestFollowThroughMinRequests,
    })
      .from(settings).where(eq(settings.id, 1)).limit(1);
    return c.json(
      {
        usersSyncedAt: null,
        historyComplete: false,
        requestFollowThroughAvailable: false,
        inactiveDays: settingsRow?.inactiveUserDays ?? DEFAULT_INACTIVE_DAYS,
        defaultInactiveDays: settingsRow?.inactiveUserDays ?? DEFAULT_INACTIVE_DAYS,
        search: '',
        risk: 'all',
        sort: 'username',
        order: 'asc',
        limit: 100,
        offset: 0,
        total: 0,
        monitor: getSessionMonitorHealth(),
        users: [],
      } satisfies UsersResponse,
    );
  }

  const [[serverRow], [settingsRow], libraryHistoryRows] = await Promise.all([
    db.select({ usersSyncedAt: servers.usersSyncedAt }).from(servers).where(
      eq(servers.id, serverId),
    )
      .limit(1),
    db.select({
      inactiveUserDays: settings.inactiveUserDays,
      requestFollowThroughGraceDays: settings.requestFollowThroughGraceDays,
      requestFollowThroughMinRequests: settings.requestFollowThroughMinRequests,
    }).from(settings).where(
      eq(settings.id, 1),
    )
      .limit(1),
    db.select({ type: libraries.type, historySyncedAt: libraries.historySyncedAt })
      .from(libraries)
      .where(eq(libraries.serverId, serverId)),
  ]);
  const usersSyncedAt = serverRow?.usersSyncedAt ?? null;
  const videoLibraryHistory = libraryHistoryRows.filter((library) => library.type !== 'artist');
  const historyComplete = userHistoryIsComplete(usersSyncedAt, videoLibraryHistory);

  const rawInactiveDays = c.req.query('inactiveDays');
  const parsedInactiveDays = rawInactiveDays !== undefined ? Number(rawInactiveDays) : null;
  if (
    rawInactiveDays !== undefined &&
    (!/^\d+$/.test(rawInactiveDays) || !Number.isInteger(parsedInactiveDays) ||
      parsedInactiveDays! > MAX_INACTIVITY_DAYS)
  ) {
    return c.json({
      error: `inactiveDays must be an integer between 0 and ${MAX_INACTIVITY_DAYS}`,
    }, 400);
  }
  const inactiveDays = parsedInactiveDays ??
    settingsRow?.inactiveUserDays ?? DEFAULT_INACTIVE_DAYS;

  const rawFilter = c.req.query('filter');
  const filter: UsersActivityFilter =
    rawFilter === 'inactive' || rawFilter === 'never' || rawFilter === 'unknown'
      ? rawFilter
      : 'all';

  const rawRisk = c.req.query('risk') ?? 'all';
  const risk: UsersRiskFilter = [
      'all',
      'attention',
      'review',
      'watch',
      'low',
      'insufficient_data',
    ].includes(rawRisk)
    ? rawRisk as UsersRiskFilter
    : 'all';

  const rawSort = c.req.query('sort') ?? 'username';
  const sort: UsersSortKey = ['username', 'lastViewedAt', 'sharingRisk'].includes(rawSort)
    ? rawSort as UsersSortKey
    : 'username';
  // Owner-first alphabetical is the stable directory default. Other sorts use the
  // requested direction and username as a deterministic tie-breaker.
  const orderStr = c.req.query('order') === 'desc' ? 'desc' : 'asc';

  const rawLimit = parseInt(c.req.query('limit') ?? '100', 10);
  const limit = Number.isNaN(rawLimit) || rawLimit <= 0 ? 100 : Math.min(rawLimit, 500);
  const rawOffset = parseInt(c.req.query('offset') ?? '0', 10);
  const offset = Number.isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;
  const parsedSearch = parseSearchQuery(c.req.query('search'));
  if ('error' in parsedSearch) return c.json({ error: parsedSearch.error }, 400);
  const { search } = parsedSearch;
  const normalizedSearch = search.toLocaleLowerCase();

  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - inactiveDays * 86400;
  const riskWindowCutoff = now - 30 * 86400;
  const requestGraceDays = settingsRow?.requestFollowThroughGraceDays ??
    DEFAULT_REQUEST_GRACE_DAYS;
  const requestMinimum = settingsRow?.requestFollowThroughMinRequests ?? DEFAULT_REQUEST_MINIMUM;
  const requestWindow = requestFollowThroughWindow(now, requestGraceDays);
  const requestCutoff = requestWindow.cutoff;
  // The rolling window is anchored to grace completion, not raw availability. This
  // remains a valid interval even when an admin chooses a grace longer than one year.
  const requestWindowStart = requestWindow.start;
  // Sharing risk is derived from observation aggregates rather than stored on users.
  // Server rosters are naturally small, so assess the activity-filtered roster first,
  // then risk-filter, sort, and page it in memory to keep totals and pages correct.
  const rows = await db.select({
    accountId: users.accountId,
    username: users.username,
    email: users.email,
    thumb: users.thumb,
    isOwner: users.isOwner,
    lastViewedAt: users.lastViewedAt,
    localAccountId: users.localAccountId,
  }).from(users).where(usersByServer(serverId));

  const activityFiltered = rows.filter((user) =>
    !normalizedSearch ||
    user.username.toLocaleLowerCase().includes(normalizedSearch) ||
    user.email?.toLocaleLowerCase().includes(normalizedSearch)
  ).map((row) => ({
    ...row,
    activityStatus: userActivityStatus(row.lastViewedAt, row.localAccountId, historyComplete),
  })).filter((user) =>
    filter === 'all' ||
    (filter === 'inactive'
      ? user.lastViewedAt !== null && user.lastViewedAt < cutoff
      : filter === 'unknown'
      ? user.activityStatus === 'history_pending' || user.activityStatus === 'identity_unresolved'
      : user.activityStatus === filter)
  );

  const sharingStats = await sharingStatsForAccounts(
    serverId,
    activityFiltered.map((row) => row.accountId),
    riskWindowCutoff,
  );

  const accountIds = activityFiltered.map((row) => row.accountId);
  const { statsByAccount: requestStats, health: requestHealth } = await queryRequestFollowThrough({
    serverId,
    accountIds,
    windowStart: requestWindowStart,
    graceCutoff: requestCutoff,
  }, db);

  const assessedUsers: PlexUser[] = activityFiltered.map(({ localAccountId, ...u }) => ({
    ...u,
    sharingRisk: assessUserSharingRisk(
      sharingStats.get(u.accountId) ?? {
        observationCount: 0,
        firstObservedAt: null,
        lastObservedAt: null,
        activeDays: 0,
        completeObservationCount: 0,
        remoteNetworks30d: 0,
        remotePlayers30d: 0,
        maxRemoteNetworksPerHour30d: 0,
        concurrentRemotePlaybackDays30d: 0,
      },
    ),
    requestFollowThrough: assessRequestFollowThrough(
      requestStats.get(u.accountId) ?? {
        eligibleRequestCount: 0,
        watchedRequestCount: 0,
        recentRequestCount: 0,
        estimatedAvailabilityCount: 0,
        uncertainAvailabilityOutcomeCount: 0,
        unmatchedMediaRequestCount: 0,
        unknownRequestScopeCount: 0,
      },
      requestHealth,
      userHistoryCanBeAttributed(historyComplete, localAccountId),
      requestGraceDays,
      requestMinimum,
    ),
  }));

  const riskFiltered = assessedUsers.filter((user) =>
    risk === 'all' ||
    (risk === 'attention'
      ? user.sharingRisk.riskLevel === 'watch' || user.sharingRisk.riskLevel === 'review'
      : user.sharingRisk.riskLevel === risk)
  );
  const direction = orderStr === 'asc' ? 1 : -1;
  const riskRank = { insufficient_data: 0, low: 1, watch: 2, review: 3 } as const;
  riskFiltered.sort((a, b) => {
    if (sort === 'username') {
      if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
      return direction * a.username.localeCompare(b.username, undefined, { sensitivity: 'base' });
    }
    if (sort === 'sharingRisk') {
      const rankDifference = riskRank[a.sharingRisk.riskLevel] -
        riskRank[b.sharingRisk.riskLevel];
      return direction * rankDifference ||
        direction * (a.sharingRisk.riskScore - b.sharingRisk.riskScore) ||
        a.username.localeCompare(b.username, undefined, { sensitivity: 'base' });
    }
    // Users without a trustworthy timestamp (never or unknown) lead oldest-first and
    // trail most-recent-first; username keeps the two null-timestamp groups stable.
    if (a.lastViewedAt === null || b.lastViewedAt === null) {
      if (a.lastViewedAt === b.lastViewedAt) return a.username.localeCompare(b.username);
      return a.lastViewedAt === null ? -direction : direction;
    }
    return direction * (a.lastViewedAt - b.lastViewedAt || a.username.localeCompare(b.username));
  });

  const total = riskFiltered.length;
  const page = riskFiltered.slice(offset, offset + limit);

  return c.json(
    {
      usersSyncedAt,
      historyComplete,
      requestFollowThroughAvailable: requestHealth.connectionCount > 0,
      inactiveDays,
      defaultInactiveDays: settingsRow?.inactiveUserDays ?? DEFAULT_INACTIVE_DAYS,
      search,
      risk,
      sort,
      order: orderStr,
      limit,
      offset,
      total,
      monitor: getSessionMonitorHealth(),
      users: page,
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
// Pending invitations are live Plex data rather than roster rows: they have not become
// users yet, and accepting one should appear without waiting for a library sync. Plex
// identifies the target server by name only, so the integration verifies uniqueness
// among owned servers before attributing invitations to the active server.
router.get('/invitations', async (c) => {
  const rawFilter = c.req.query('filter') ?? 'all';
  const filter = ['all', 'attention', 'current', 'stale', 'critical'].includes(rawFilter)
    ? rawFilter as PendingInvitationsResponse['filter']
    : 'all';
  const search = (c.req.query('search') ?? '').trim().slice(0, 200);
  const rawSort = c.req.query('sort') ?? 'createdAt';
  const sort = ['createdAt', 'username', 'libraryCount'].includes(rawSort)
    ? rawSort as PendingInvitationsResponse['sort']
    : 'createdAt';
  const order = c.req.query('order') === 'desc' ? 'desc' : 'asc';
  const parsedLimit = Number(c.req.query('limit') ?? 25);
  const limit = Number.isSafeInteger(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, 100)
    : 25;
  const parsedOffset = Number(c.req.query('offset') ?? 0);
  const offset = Number.isSafeInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;

  const active = await getActiveServer();
  if (!active) {
    return c.json(
      {
        staleAfterDays: 30,
        criticalAfterDays: 90,
        serverMatch: 'unavailable',
        overallTotal: 0,
        total: 0,
        staleCount: 0,
        criticalCount: 0,
        filter,
        search,
        sort,
        order,
        limit,
        offset,
        invitations: [],
      } satisfies PendingInvitationsResponse,
    );
  }

  const [settingsRow] = await db.select({
    pendingInviteStaleDays: settings.pendingInviteStaleDays,
    pendingInviteCriticalDays: settings.pendingInviteCriticalDays,
  }).from(settings).where(eq(settings.id, 1)).limit(1);
  const staleAfterDays = settingsRow?.pendingInviteStaleDays ?? 30;
  const criticalAfterDays = settingsRow?.pendingInviteCriticalDays ?? 90;

  try {
    const result = await cachedPendingInvitations(active);
    const now = Math.floor(Date.now() / 1000);
    const staleCutoff = now - staleAfterDays * 86_400;
    const criticalCutoff = now - criticalAfterDays * 86_400;
    const classified = result.invitations.map((invitation) => ({
      invitation,
      ageStatus: invitation.createdAt <= criticalCutoff
        ? 'critical' as const
        : invitation.createdAt <= staleCutoff
        ? 'stale' as const
        : 'current' as const,
    }));
    const criticalCount = classified.filter((entry) => entry.ageStatus === 'critical').length;
    const staleCount = classified.filter((entry) => entry.ageStatus === 'stale').length;
    const normalizedSearch = search.toLocaleLowerCase();
    const filtered = classified.filter((entry) => {
      const matchesStatus = filter === 'all' ||
        (filter === 'attention'
          ? entry.ageStatus === 'stale' || entry.ageStatus === 'critical'
          : entry.ageStatus === filter);
      const matchesSearch = !normalizedSearch ||
        entry.invitation.username?.toLocaleLowerCase().includes(normalizedSearch) ||
        entry.invitation.email?.toLocaleLowerCase().includes(normalizedSearch);
      return matchesStatus && matchesSearch;
    });
    const direction = order === 'asc' ? 1 : -1;
    filtered.sort((a, b) => {
      if (sort === 'username') {
        const aName = a.invitation.username || a.invitation.email || '';
        const bName = b.invitation.username || b.invitation.email || '';
        return direction * aName.localeCompare(bName, undefined, { sensitivity: 'base' }) ||
          a.invitation.inviteId - b.invitation.inviteId;
      }
      if (sort === 'libraryCount') {
        return direction *
            ((a.invitation.libraryCount ?? -1) - (b.invitation.libraryCount ?? -1)) ||
          a.invitation.createdAt - b.invitation.createdAt;
      }
      return direction * (a.invitation.createdAt - b.invitation.createdAt) ||
        a.invitation.inviteId - b.invitation.inviteId;
    });
    const total = filtered.length;
    return c.json(
      {
        staleAfterDays,
        criticalAfterDays,
        serverMatch: result.serverMatch,
        overallTotal: classified.length,
        total,
        staleCount,
        criticalCount,
        filter,
        search,
        sort,
        order,
        limit,
        offset,
        invitations: filtered.slice(offset, offset + limit).map(({ invitation, ageStatus }) => ({
          inviteId: invitation.inviteId,
          username: invitation.username,
          email: invitation.email,
          thumb: invitation.thumb,
          createdAt: invitation.createdAt,
          libraryCount: invitation.libraryCount,
          ageStatus,
        })),
      } satisfies PendingInvitationsResponse,
    );
  } catch (err) {
    console.error(`Failed to fetch pending invitations for server ${active.serverId}:`, err);
    return c.json({ error: 'Unable to fetch pending invitations from Plex' }, 502);
  }
});

router.delete('/invitations/:inviteId', async (c) => {
  const inviteId = Number(c.req.param('inviteId'));
  if (!Number.isSafeInteger(inviteId) || inviteId <= 0) {
    return c.json({ error: 'inviteId must be a positive integer' }, 400);
  }
  const active = await getActiveServer();
  if (!active) return c.json({ error: 'Plex is not configured' }, 409);

  try {
    await cancelPendingServerInvitation(
      active.clientId,
      active.accessToken,
      active.machineIdentifier,
      inviteId,
    );
    pendingInvitationCache.delete(active.serverId);
    return c.json({ inviteId } satisfies CancelPendingInvitationResponse);
  } catch (err) {
    if (err instanceof PlexPendingInvitationError && err.status === 404) {
      return c.json({ error: 'Pending invitation no longer exists' }, 404);
    }
    console.error(`Failed to cancel pending invitation ${inviteId}:`, err);
    return c.json({ error: 'Unable to cancel pending invitation in Plex' }, 502);
  }
});

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
