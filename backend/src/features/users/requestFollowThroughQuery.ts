import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import type {
  RequestFollowThroughDetailItem,
  RequestFollowThroughDetailsResponse,
} from '@plex-librarian/shared/types.ts';
import * as schema from '../../db/schema.ts';
import { items, seerrInstances, seerrRequests, userItemActivity } from '../../db/schema.ts';
import {
  SEERR_REQUEST_STATUS_APPROVED,
  SEERR_REQUEST_STATUS_COMPLETED,
} from '../../integrations/seerr/client.ts';
import type {
  RequestFollowThroughHealth,
  RequestFollowThroughStats,
} from './requestFollowThrough.ts';

export interface RequestFollowThroughQueryResult {
  statsByAccount: Map<number, RequestFollowThroughStats>;
  health: RequestFollowThroughHealth;
}

interface RequestFollowThroughQueryOptions {
  serverId: number;
  accountIds: number[];
  windowStart: number;
  graceCutoff: number;
}

const acceptedRequestStatuses = [
  SEERR_REQUEST_STATUS_APPROVED,
  SEERR_REQUEST_STATUS_COMPLETED,
];

function hasKnownScope() {
  return sql`coalesce((
    ${seerrRequests.mediaType} = 'movie'
    OR (${seerrRequests.mediaType} = 'tv' AND EXISTS (
      SELECT 1 FROM seerr_request_seasons request_scope
      WHERE request_scope.seerr_instance_id = seerr_requests.seerr_instance_id
        AND request_scope.request_id = seerr_requests.request_id
    ))
  ), 0)`;
}

function watchAtOrAfterAvailability() {
  return sql<number | null>`CASE
    WHEN ${seerrRequests.mediaType} = 'movie'
      AND ${userItemActivity.lastViewedAt} >= ${seerrRequests.availableAt}
      THEN ${userItemActivity.lastViewedAt}
    WHEN ${seerrRequests.mediaType} = 'tv' THEN (
      SELECT max(season_activity.last_viewed_at)
      FROM seerr_request_seasons request_scope
      INNER JOIN user_season_activity season_activity
        ON season_activity.server_id = seerr_requests.server_id
        AND season_activity.account_id = seerr_requests.account_id
        AND season_activity.show_rating_key = seerr_requests.rating_key
        AND season_activity.season_number = request_scope.season_number
        AND season_activity.last_viewed_at >= seerr_requests.available_at
      WHERE request_scope.seerr_instance_id = seerr_requests.seerr_instance_id
        AND request_scope.request_id = seerr_requests.request_id
    )
    ELSE NULL
  END`;
}

function hasWatchAtOrAfterAvailability() {
  return sql`coalesce((${watchAtOrAfterAvailability()} IS NOT NULL), 0)`;
}

/**
 * Loads the complete request-follow-through evidence needed by the classifier.
 * Keeping this query here makes the route independent of storage details and gives
 * the repeated eligibility/watch predicates one authoritative implementation.
 */
export async function queryRequestFollowThrough(
  options: RequestFollowThroughQueryOptions,
  database: SqliteRemoteDatabase<typeof schema>,
): Promise<RequestFollowThroughQueryResult> {
  const { serverId, accountIds, windowStart, graceCutoff } = options;
  const knownScope = hasKnownScope();
  const watched = hasWatchAtOrAfterAvailability();

  const [aggregates, connections] = await Promise.all([
    accountIds.length
      ? database.select({
        accountId: seerrRequests.accountId,
        eligibleRequestCount: sql<number>`sum(CASE WHEN ${seerrRequests.ratingKey} IS NOT NULL
          AND ${seerrRequests.availableAt} BETWEEN ${windowStart} AND ${graceCutoff}
          AND ${knownScope} THEN 1 ELSE 0 END)`,
        watchedRequestCount: sql<number>`sum(CASE WHEN ${seerrRequests.ratingKey} IS NOT NULL
          AND ${seerrRequests.availableAt} BETWEEN ${windowStart} AND ${graceCutoff}
          AND ${watched} THEN 1 ELSE 0 END)`,
        recentRequestCount: sql<number>`sum(CASE WHEN ${seerrRequests.ratingKey} IS NOT NULL
          AND ${seerrRequests.availableAt} > ${graceCutoff}
          AND ${knownScope} THEN 1 ELSE 0 END)`,
        estimatedAvailabilityCount: sql<number>`sum(CASE
          WHEN ${seerrRequests.ratingKey} IS NOT NULL
          AND ${seerrRequests.availableAt} BETWEEN ${windowStart} AND ${graceCutoff}
          AND ${seerrRequests.availabilityEstimated} = 1
          AND ${knownScope} THEN 1 ELSE 0 END)`,
        uncertainAvailabilityOutcomeCount: sql<number>`sum(CASE
          WHEN ${seerrRequests.ratingKey} IS NOT NULL
          AND ${seerrRequests.availableAt} BETWEEN ${windowStart} AND ${graceCutoff}
          AND ${seerrRequests.availabilityEstimated} = 1
          AND ${knownScope}
          AND NOT ${watched} THEN 1 ELSE 0 END)`,
        unmatchedMediaRequestCount: sql<number>`sum(CASE
          WHEN ${seerrRequests.ratingKey} IS NULL
          AND ${seerrRequests.availableAt} BETWEEN ${windowStart} AND ${graceCutoff}
          THEN 1 ELSE 0 END)`,
        unknownRequestScopeCount: sql<number>`sum(CASE
          WHEN ${seerrRequests.ratingKey} IS NOT NULL
          AND ${seerrRequests.availableAt} BETWEEN ${windowStart} AND ${graceCutoff}
          AND NOT ${knownScope} THEN 1 ELSE 0 END)`,
      }).from(seerrRequests).leftJoin(
        userItemActivity,
        and(
          eq(userItemActivity.serverId, seerrRequests.serverId),
          eq(userItemActivity.accountId, seerrRequests.accountId),
          eq(userItemActivity.ratingKey, seerrRequests.ratingKey),
        ),
      ).where(and(
        eq(seerrRequests.serverId, serverId),
        inArray(seerrRequests.accountId, accountIds),
        inArray(seerrRequests.requestStatus, acceptedRequestStatuses),
        sql`${seerrRequests.availableAt} IS NOT NULL`,
      )).groupBy(seerrRequests.accountId)
      : Promise.resolve([]),
    database.select({
      requestsSyncedAt: seerrInstances.requestsSyncedAt,
      requestsSyncError: seerrInstances.requestsSyncError,
    }).from(seerrInstances).where(eq(seerrInstances.serverId, serverId)),
  ]);

  return {
    statsByAccount: new Map(aggregates.map((row) => [
      row.accountId as number,
      {
        eligibleRequestCount: Number(row.eligibleRequestCount ?? 0),
        watchedRequestCount: Number(row.watchedRequestCount ?? 0),
        recentRequestCount: Number(row.recentRequestCount ?? 0),
        estimatedAvailabilityCount: Number(row.estimatedAvailabilityCount ?? 0),
        uncertainAvailabilityOutcomeCount: Number(
          row.uncertainAvailabilityOutcomeCount ?? 0,
        ),
        unmatchedMediaRequestCount: Number(row.unmatchedMediaRequestCount ?? 0),
        unknownRequestScopeCount: Number(row.unknownRequestScopeCount ?? 0),
      },
    ])),
    health: {
      connectionCount: connections.length,
      successfulSyncCount: connections.filter((row) => row.requestsSyncedAt !== null).length,
      failedSyncCount: connections.filter((row) => row.requestsSyncError !== null).length,
    },
  };
}

export async function queryRequestFollowThroughDetails(
  options: {
    serverId: number;
    accountId: number;
    windowStart: number;
    graceCutoff: number;
    limit: number;
  },
  database: SqliteRemoteDatabase<typeof schema>,
): Promise<RequestFollowThroughDetailsResponse> {
  const { serverId, accountId, windowStart, graceCutoff, limit } = options;
  const knownScope = hasKnownScope();
  const watchedAt = watchAtOrAfterAvailability();
  const eligible = and(
    eq(seerrRequests.serverId, serverId),
    eq(seerrRequests.accountId, accountId),
    inArray(seerrRequests.requestStatus, acceptedRequestStatuses),
    sql`${seerrRequests.ratingKey} IS NOT NULL`,
    sql`${seerrRequests.availableAt} BETWEEN ${windowStart} AND ${graceCutoff}`,
    knownScope,
  );
  const itemJoin = and(
    eq(items.serverId, seerrRequests.serverId),
    eq(items.ratingKey, seerrRequests.ratingKey),
  );

  const [rows, [count]] = await Promise.all([
    database.select({
      seerrInstanceId: seerrRequests.seerrInstanceId,
      requestId: seerrRequests.requestId,
      title: items.title,
      year: items.year,
      thumb: items.thumb,
      mediaType: seerrRequests.mediaType,
      requestedAt: seerrRequests.requestedAt,
      availableAt: seerrRequests.availableAt,
      watchedAt,
      requestedSeasons: sql<string | null>`(
        SELECT group_concat(ordered_scope.season_number, ',')
        FROM (
          SELECT request_scope.season_number
          FROM seerr_request_seasons request_scope
          WHERE request_scope.seerr_instance_id = seerr_requests.seerr_instance_id
            AND request_scope.request_id = seerr_requests.request_id
          ORDER BY request_scope.season_number
        ) ordered_scope
      )`,
    }).from(seerrRequests).leftJoin(items, itemJoin).leftJoin(
      userItemActivity,
      and(
        eq(userItemActivity.serverId, seerrRequests.serverId),
        eq(userItemActivity.accountId, seerrRequests.accountId),
        eq(userItemActivity.ratingKey, seerrRequests.ratingKey),
      ),
    ).where(eligible).orderBy(
      desc(seerrRequests.availableAt),
      desc(seerrRequests.requestedAt),
      desc(seerrRequests.requestId),
    ).limit(limit),
    database.select({ total: sql<number>`count(*)` }).from(seerrRequests).where(eligible),
  ]);

  return {
    total: Number(count?.total ?? 0),
    limit,
    items: rows.map((row): RequestFollowThroughDetailItem => ({
      key: `${row.seerrInstanceId}:${row.requestId}`,
      title: row.title ?? 'Title unavailable',
      year: row.year,
      thumb: row.thumb,
      mediaType: row.mediaType as 'movie' | 'tv',
      requestedAt: row.requestedAt,
      availableAt: row.availableAt as number,
      watchedAt: row.watchedAt === null ? null : Number(row.watchedAt),
      requestedSeasons: row.requestedSeasons ? row.requestedSeasons.split(',').map(Number) : [],
    })),
  };
}
