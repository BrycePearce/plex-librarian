import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { items, seerrInstances, seerrRequests, users } from '../../db/schema.ts';
import {
  SEERR_MEDIA_STATUS_AVAILABLE,
  SeerrClient,
  type SeerrRequestRecord,
} from '../../integrations/seerr/client.ts';

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
      row.tmdbId === null ? null : `tmdb:${row.tmdbId}:${mediaType ?? ''}`,
      row.tmdbId === null ? null : `tmdb:${row.tmdbId}:`,
      row.tvdbId === null ? null : `tvdb:${row.tvdbId}`,
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
  let skip = 0;
  while (true) {
    const page = await client.requestsPage(PAGE_SIZE, skip);
    const valid = page.results.filter((record) =>
      positiveInteger(record.id) !== null && positiveInteger(record.status) !== null &&
      epoch(record.createdAt) !== null && record.media
    );
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
      }).from(seerrRequests).where(and(
        eq(seerrRequests.seerrInstanceId, instance.id),
        inArray(seerrRequests.requestId, requestIds),
      ))
      : [];
    const existingAvailability = new Map(existing.map((row) => [row.requestId, row.availableAt]));

    const rows = valid.map((record) => {
      const requestId = positiveInteger(record.id)!;
      const requestedAt = epoch(record.createdAt)!;
      const status = positiveInteger(record.status)!;
      const availability = positiveInteger(record.media?.status) ?? 1;
      const username = normalized(record.requestedBy?.plexUsername) ??
        normalized(record.requestedBy?.username);
      const email = normalized(record.requestedBy?.email);
      const accountId = (username ? identityMap.get(`username:${username}`) : undefined) ??
        (email ? identityMap.get(`email:${email}`) : undefined) ?? null;
      const tmdbId = positiveInteger(record.media?.tmdbId);
      const tvdbId = positiveInteger(record.media?.tvdbId);
      const type = mediaType(record);
      const ratingKey = (tvdbId ? itemMap.get(`tvdb:${tvdbId}`) : undefined) ??
        (tmdbId ? itemMap.get(`tmdb:${tmdbId}:${type ?? ''}`) : undefined) ?? null;
      const priorAvailableAt = existingAvailability.get(requestId) ?? null;
      const availableAt = availability === SEERR_MEDIA_STATUS_AVAILABLE
        ? priorAvailableAt ?? Math.max(requestedAt, epoch(record.media?.updatedAt) ?? syncedAt)
        : null;
      return {
        serverId,
        seerrInstanceId: instance.id,
        requestId,
        accountId,
        requesterUsername: username,
        requesterEmail: email,
        ratingKey,
        requestStatus: status,
        mediaStatus: availability,
        requestedAt,
        availableAt,
        availabilityEstimated: availableAt !== null,
        syncedAt,
      };
    });

    if (rows.length) {
      await db.insert(seerrRequests).values(rows).onConflictDoUpdate({
        target: [seerrRequests.seerrInstanceId, seerrRequests.requestId],
        set: {
          accountId: sql`excluded.account_id`,
          requesterUsername: sql`excluded.requester_username`,
          requesterEmail: sql`excluded.requester_email`,
          ratingKey: sql`excluded.rating_key`,
          requestStatus: sql`excluded.request_status`,
          mediaStatus: sql`excluded.media_status`,
          requestedAt: sql`excluded.requested_at`,
          availableAt: sql`excluded.available_at`,
          availabilityEstimated: sql`excluded.availability_estimated`,
          syncedAt: sql`excluded.synced_at`,
        },
      });
    }
    skip += page.results.length;
    const pages = positiveInteger(page.pageInfo.pages);
    if (page.results.length < PAGE_SIZE || (pages !== null && skip >= pages * PAGE_SIZE)) break;
  }

  await db.delete(seerrRequests).where(and(
    eq(seerrRequests.seerrInstanceId, instance.id),
    lt(seerrRequests.syncedAt, syncedAt),
  ));
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

  for (const instance of instances) {
    try {
      await syncInstance(instance, serverId, syncedAt, identityMap);
      await db.update(seerrInstances).set({ requestsSyncedAt: syncedAt, requestsSyncError: null })
        .where(eq(seerrInstances.id, instance.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request sync failed';
      await db.update(seerrInstances).set({ requestsSyncError: message.slice(0, 500) })
        .where(eq(seerrInstances.id, instance.id));
    }
  }
}
