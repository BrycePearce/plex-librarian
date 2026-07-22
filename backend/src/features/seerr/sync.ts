import { and, eq, inArray, or } from 'drizzle-orm';
import { db, withTransaction } from '../../db/index.ts';
import {
  items,
  seerrInstances,
  seerrRequests,
  seerrRequestSeasons,
  users,
} from '../../db/schema.ts';
import {
  SEERR_MEDIA_STATUS_AVAILABLE,
  SEERR_REQUEST_STATUS_COMPLETED,
  SeerrClient,
  type SeerrRequestRecord,
} from '../../integrations/seerr/client.ts';
import {
  requestAvailability,
  requestEvidenceChanged,
  requestSeasonNumbers,
  resolveAvailabilityObservation,
} from './availability.ts';
import { currentUniqueMatch, typedExternalIdKey } from './matching.ts';
import { RequestPageCoverage, validateRequestPageRecords } from './requestPage.ts';
import { publishStagedRequestGeneration } from './publication.ts';

const PAGE_SIZE = 100;

function epoch(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function normalized(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toLocaleLowerCase() : null;
}

function uniqueIdentityMap(rows: Array<{ accountId: number; values: Array<string | null> }>) {
  const result = new Map<string, number | null>();
  for (const row of rows) {
    for (const value of row.values) {
      if (!value) continue;
      const existing = result.get(value);
      result.set(
        value,
        existing === undefined || existing === row.accountId ? row.accountId : null,
      );
    }
  }
  return result;
}

function uniqueItemMap(
  rows: Array<{ ratingKey: string; type: string; tmdbId: number | null; tvdbId: number | null }>,
) {
  const result = new Map<string, string | null>();
  for (const row of rows) {
    const mediaType = row.type === 'movie' ? 'movie' : row.type === 'show' ? 'tv' : null;
    const keys = [
      row.tmdbId === null ? null : typedExternalIdKey('tmdb', row.tmdbId, mediaType),
      row.tvdbId === null ? null : typedExternalIdKey('tvdb', row.tvdbId, mediaType),
    ];
    for (const key of keys) {
      if (!key) continue;
      const existing = result.get(key);
      result.set(key, existing === undefined || existing === row.ratingKey ? row.ratingKey : null);
    }
  }
  return result;
}

function mediaType(record: SeerrRequestRecord): 'movie' | 'tv' | null {
  const value = record.media?.mediaType;
  return value === 'movie' || value === 'tv' ? value : null;
}

async function syncInstance(
  instance: typeof seerrInstances.$inferSelect,
  serverId: number,
  syncedAt: number,
  identityMap: Map<string, number | null>,
) {
  const client = new SeerrClient(instance.url, instance.apiKey);
  // A private negative marker distinguishes this attempt from both previous rows and
  // another successful sync in the same second. It lets the database verify distinct
  // request coverage without accumulating every request ID in memory.
  const markerEntropy = crypto.getRandomValues(new Uint32Array(1))[0] % 1000;
  const syncMarker = -(Date.now() * 1000 + markerEntropy + 1);
  // Staging is durable so an interrupted process never needs to mutate or reconstruct
  // the last published generation. Any abandoned attempt is safe to discard here.
  withTransaction((client) => {
    client.prepare('DELETE FROM seerr_request_sync_stage WHERE seerr_instance_id = ?')
      .run(instance.id);
  });
  let skip = 0;
  const coverage = new RequestPageCoverage();
  while (true) {
    const page = await client.requestsPage(PAGE_SIZE, skip);
    const valid = validateRequestPageRecords(page.results, skip);
    const complete = coverage.accept(valid, page.pageInfo.results, skip);
    const tmdbIds = [
      ...new Set(
        valid.map((r) => positiveInteger(r.media?.tmdbId)).filter(
          (id): id is number => id !== null,
        ),
      ),
    ];
    const tvdbIds = [
      ...new Set(
        valid.map((r) => positiveInteger(r.media?.tvdbId)).filter(
          (id): id is number => id !== null,
        ),
      ),
    ];
    const externalIdFilters = [
      tmdbIds.length ? inArray(items.tmdbId, tmdbIds) : undefined,
      tvdbIds.length ? inArray(items.tvdbId, tvdbIds) : undefined,
    ].filter((condition): condition is NonNullable<typeof condition> => condition !== undefined);
    const candidates = externalIdFilters.length
      ? await db.select({
        ratingKey: items.ratingKey,
        type: items.type,
        tmdbId: items.tmdbId,
        tvdbId: items.tvdbId,
      }).from(items).where(and(eq(items.serverId, serverId), or(...externalIdFilters)))
      : [];
    const itemMap = uniqueItemMap(candidates);
    const requestIds = valid.map((r) => positiveInteger(r.id)!);
    const existing = requestIds.length
      ? await db.select({
        requestId: seerrRequests.requestId,
        availableAt: seerrRequests.availableAt,
        availabilityObservedAt: seerrRequests.availabilityObservedAt,
        availabilityObservedSyncAt: seerrRequests.availabilityObservedSyncAt,
        availabilityEstimated: seerrRequests.availabilityEstimated,
        mediaType: seerrRequests.mediaType,
      }).from(seerrRequests).where(and(
        eq(seerrRequests.seerrInstanceId, instance.id),
        inArray(seerrRequests.requestId, requestIds),
      ))
      : [];
    const existingRequests = new Map(existing.map((row) => [row.requestId, row]));
    const existingSeasonRows = requestIds.length
      ? await db.select({
        requestId: seerrRequestSeasons.requestId,
        seasonNumber: seerrRequestSeasons.seasonNumber,
      }).from(seerrRequestSeasons).where(and(
        eq(seerrRequestSeasons.seerrInstanceId, instance.id),
        inArray(seerrRequestSeasons.requestId, requestIds),
      ))
      : [];
    const existingSeasons = new Map<number, number[]>();
    for (const row of existingSeasonRows) {
      const seasonNumbers = existingSeasons.get(row.requestId) ?? [];
      seasonNumbers.push(row.seasonNumber);
      existingSeasons.set(row.requestId, seasonNumbers);
    }
    for (const seasonNumbers of existingSeasons.values()) seasonNumbers.sort((a, b) => a - b);

    const rows = valid.map((record) => {
      const requestId = positiveInteger(record.id)!;
      const requestedAt = epoch(record.createdAt)!;
      const status = positiveInteger(record.status)!;
      const availability = requestAvailability(record);
      const mediaStatus = availability.available
        ? SEERR_MEDIA_STATUS_AVAILABLE
        : positiveInteger(record.is4k === true ? record.media?.status4k : record.media?.status) ??
          1;
      const username = normalized(record.requestedBy?.plexUsername) ??
        normalized(record.requestedBy?.username);
      const email = normalized(record.requestedBy?.email);
      const prior = existingRequests.get(requestId);
      const accountId = currentUniqueMatch(
        username ? identityMap.get(`username:${username}`) : undefined,
        email ? identityMap.get(`email:${email}`) : undefined,
      );
      const tmdbId = positiveInteger(record.media?.tmdbId);
      const tvdbId = positiveInteger(record.media?.tvdbId);
      const type = mediaType(record);
      const tvdbKey = tvdbId === null ? null : typedExternalIdKey('tvdb', tvdbId, type);
      const tmdbKey = tmdbId === null ? null : typedExternalIdKey('tmdb', tmdbId, type);
      const ratingKey = currentUniqueMatch(
        tvdbKey ? itemMap.get(tvdbKey) : undefined,
        tmdbKey ? itemMap.get(tmdbKey) : undefined,
      );
      const seasonNumbers = requestSeasonNumbers(record);
      const evidenceChanged = requestEvidenceChanged(
        prior
          ? {
            mediaType: prior.mediaType,
            seasonNumbers: existingSeasons.get(requestId) ?? [],
          }
          : null,
        { mediaType: type, seasonNumbers },
      );
      const availabilityState = resolveAvailabilityObservation(
        {
          availableAt: prior?.availableAt ?? null,
          observedAt: prior?.availabilityObservedAt ?? null,
          observedSyncAt: prior?.availabilityObservedSyncAt ?? null,
          observationFromSuccessfulSync: prior?.availabilityObservedSyncAt != null &&
            prior.availabilityObservedSyncAt === instance.requestsSyncedAt,
          estimated: prior?.availabilityEstimated ?? false,
        },
        availability,
        requestedAt,
        syncedAt,
        status === SEERR_REQUEST_STATUS_COMPLETED,
        evidenceChanged,
      );
      return {
        serverId,
        seerrInstanceId: instance.id,
        requestId,
        accountId,
        requesterUsername: username,
        requesterEmail: email,
        ratingKey,
        mediaType: type,
        requestStatus: status,
        mediaStatus,
        requestedAt,
        availableAt: availabilityState.availableAt,
        availabilityObservedAt: availabilityState.observedAt,
        availabilityObservedSyncAt: availabilityState.observedSyncAt,
        availabilityEstimated: availabilityState.estimated,
      };
    });

    if (rows.length) {
      // Pages write only to this attempt's durable staging generation. Live request and
      // scope evidence is untouched until complete coverage is verified below.
      withTransaction((client) => {
        const requestStmt = client.prepare(
          `INSERT INTO seerr_request_sync_stage
             (seerr_instance_id, sync_marker, request_id, server_id, account_id,
              requester_username, requester_email, rating_key, media_type,
              request_status, media_status, requested_at, available_at,
              availability_observed_at, availability_observed_sync_at,
              availability_estimated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const row of rows) {
          requestStmt.run(
            row.seerrInstanceId,
            syncMarker,
            row.requestId,
            row.serverId,
            row.accountId,
            row.requesterUsername,
            row.requesterEmail,
            row.ratingKey,
            row.mediaType,
            row.requestStatus,
            row.mediaStatus,
            row.requestedAt,
            row.availableAt,
            row.availabilityObservedAt,
            row.availabilityObservedSyncAt,
            row.availabilityEstimated ? 1 : 0,
          );
        }
        requestStmt.finalize();

        const seasonStmt = client.prepare(
          `INSERT INTO seerr_request_season_sync_stage
             (seerr_instance_id, sync_marker, request_id, season_number)
           VALUES (?, ?, ?, ?)`,
        );
        for (const record of valid) {
          if (mediaType(record) !== 'tv') continue;
          const requestId = positiveInteger(record.id)!;
          for (const seasonNumber of requestSeasonNumbers(record)) {
            seasonStmt.run(instance.id, syncMarker, requestId, seasonNumber);
          }
        }
        seasonStmt.finalize();
      });
    }
    skip += page.results.length;
    if (complete) break;
  }

  const distinctRequestCount = withTransaction((client) => {
    const stmt = client.prepare(
      `SELECT count(*) FROM seerr_request_sync_stage
       WHERE seerr_instance_id = ? AND sync_marker = ?`,
    );
    const count = Number(stmt.values(instance.id, syncMarker)[0]?.[0] ?? 0);
    stmt.finalize();
    return count;
  });
  if (distinctRequestCount !== coverage.expected) {
    throw new Error(
      `Seerr request sync was incomplete: received ${distinctRequestCount} distinct requests of ${coverage.expected}`,
    );
  }

  // Offset pagination can otherwise miss a request when one row is deleted and a new
  // request is inserted during the walk while the reported total stays unchanged.
  // Seerr orders `sort=added` by descending request id, so a membership change that
  // preserves the count necessarily changes this leading boundary.
  const verificationPage = await client.requestsPage(1, 0);
  const verificationRecords = validateRequestPageRecords(verificationPage.results, 0);
  coverage.verifyStableBoundary(verificationRecords, verificationPage.pageInfo.results);

  // Coverage publication, current-scope replacement, pending-row pruning, promotion,
  // and the instance health marker commit together. Confirmed rows absent from Seerr's
  // current response remain as historical evidence for the rolling assessment window.
  withTransaction((client) => {
    publishStagedRequestGeneration(
      client,
      instance.id,
      syncMarker,
      syncedAt,
      instance.requestsSyncedAt,
    );
  });
}

// Seerr is optional enrichment. A request-manager outage must never fail Plex's core
// library sync, so each connection records its own health and the assessment explains it.
export async function syncSeerrRequests(serverId: number, syncedAt: number): Promise<void> {
  const [instances, roster] = await Promise.all([
    db.select().from(seerrInstances).where(eq(seerrInstances.serverId, serverId)),
    db.select({ accountId: users.accountId, username: users.username, email: users.email })
      .from(users).where(eq(users.serverId, serverId)),
  ]);
  const identityMap = uniqueIdentityMap(roster.map((user) => ({
    accountId: user.accountId,
    values: [
      normalized(user.username) ? `username:${normalized(user.username)}` : null,
      normalized(user.email) ? `email:${normalized(user.email)}` : null,
    ],
  })));

  // Invalidate every connection before any page mutation. Doing this as one server-wide
  // step also prevents a multi-instance refresh from briefly presenting a mixture of a
  // newly synced first instance and an old-but-still-healthy later instance.
  if (instances.length > 0) {
    await db.update(seerrInstances).set({ requestsSyncedAt: null })
      .where(eq(seerrInstances.serverId, serverId));
  }

  for (const instance of instances) {
    try {
      // The previous successful timestamp remains in this local snapshot so a prior
      // observation can still be promoted. Only the public database marker stays null
      // until syncInstance atomically commits promotion and success.
      await syncInstance(instance, serverId, syncedAt, identityMap);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request sync failed';
      withTransaction((client) => {
        client.prepare('DELETE FROM seerr_request_sync_stage WHERE seerr_instance_id = ?')
          .run(instance.id);
      });
      await db.update(seerrInstances).set({ requestsSyncError: message.slice(0, 500) })
        .where(eq(seerrInstances.id, instance.id));
    }
  }
}
