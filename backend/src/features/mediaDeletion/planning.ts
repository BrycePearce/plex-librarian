import { and, eq, inArray } from 'drizzle-orm';
import { db, withTransaction } from '../../db/index.ts';
import {
  arrDeleteAttempts,
  downloadFileDeleteAttempts,
  torrentDeleteAttempts,
} from '../../db/schema.ts';
import { type ArrDeleteTarget, findAmbiguousExternalIds } from '../arr/delete.ts';
import { type AttemptedOrphanFile, DEFAULT_PAYLOAD_SCAN_LIMITS } from './hardlinks.ts';
import { type ResolvedCleanupItem, resolveDownloadCleanup } from './cleanup.ts';
import type { DownloadClientTarget } from './downloadClient.ts';
import type { PlexClient } from '../../integrations/plex/client.ts';
import { resolveDirectQbittorrentCleanup } from '../qbittorrent/directDiscovery.ts';

export interface DownloadResolvableItem {
  ratingKey: string;
  title: string;
  type: string;
  tmdbId: number | null;
  tvdbId: number | null;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await mapper(values[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function resolveDownloadCleanupBatch(
  selectedItems: DownloadResolvableItem[],
  arrTargets: ArrDeleteTarget[],
  downloadTargets: DownloadClientTarget[],
  attemptedJobKeysByItem: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  attemptedOrphanFilesByItem: ReadonlyMap<string, readonly AttemptedOrphanFile[]> = new Map(),
  attemptedArrInstancesByItem: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
  wholeShowHashRatingKeys: ReadonlySet<string> = new Set(),
): Promise<ResolvedCleanupItem[]> {
  const payloadScanBudget = { remainingEntries: DEFAULT_PAYLOAD_SCAN_LIMITS.maxEntries };
  // A bounded pool keeps bulk previews responsive without bursting against external services.
  return await mapWithConcurrency(
    selectedItems,
    3,
    (item) =>
      resolveDownloadCleanup(
        item.ratingKey,
        item,
        arrTargets,
        downloadTargets,
        attemptedJobKeysByItem.get(item.ratingKey),
        attemptedOrphanFilesByItem.get(item.ratingKey),
        attemptedArrInstancesByItem.get(item.ratingKey),
        payloadScanBudget,
        { allowWholeShowHash: wholeShowHashRatingKeys.has(item.ratingKey) },
      ),
  );
}

/** The narrow whole-show lane: centralizes only the positive/unambiguous TVDB gate. */
export async function resolveWholeShowDownloadCleanupBatch(
  serverId: number,
  selectedItems: DownloadResolvableItem[],
  arrTargets: ArrDeleteTarget[],
  downloadTargets: DownloadClientTarget[],
  attemptedJobKeysByItem: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  attemptedOrphanFilesByItem: ReadonlyMap<string, readonly AttemptedOrphanFile[]> = new Map(),
  attemptedArrInstancesByItem: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
): Promise<ResolvedCleanupItem[]> {
  const showIds = selectedItems.flatMap((item) =>
    item.type === 'show' && Number.isSafeInteger(item.tvdbId) && item.tvdbId! > 0
      ? [item.tvdbId!]
      : []
  );
  const ambiguous = withTransaction((client) =>
    findAmbiguousExternalIds(client, serverId, 'show', showIds)
  );
  const eligible = new Set(
    selectedItems.flatMap((item) =>
      item.type === 'show' && Number.isSafeInteger(item.tvdbId) && item.tvdbId! > 0 &&
        !ambiguous.has(item.tvdbId!)
        ? [item.ratingKey]
        : []
    ),
  );
  const resolved = await resolveDownloadCleanupBatch(
    selectedItems,
    arrTargets,
    downloadTargets,
    attemptedJobKeysByItem,
    attemptedOrphanFilesByItem,
    attemptedArrInstancesByItem,
    eligible,
  );
  return resolved.map((cleanup, index) => {
    const item = selectedItems[index]!;
    if (item.type !== 'show' || item.tvdbId === null || !ambiguous.has(item.tvdbId)) return cleanup;
    const reason = `${item.title} shares its TVDB ID with another Plex item`;
    return {
      ...cleanup,
      status: 'error' as const,
      reason,
      arrStatus: 'error' as const,
      arrReason: `${reason}; use Plex-only deletion or resolve the duplicate first`,
      downloadJobs: [],
      orphanFiles: [],
      retainedPaths: [],
    };
  });
}

/** Resolve whole-item cleanup from Arr history, then use the existing strict direct
 * manifest proof only for complete movie Media evidence. */
export async function resolveWholeItemDownloadCleanupBatch(
  serverId: number,
  libraryKey: string,
  selectedItems: DownloadResolvableItem[],
  arrTargets: ArrDeleteTarget[],
  downloadTargets: DownloadClientTarget[],
  plexClient: Pick<PlexClient, 'mediaVersionPathPreviews'>,
  attemptedJobKeysByItem: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  attemptedOrphanFilesByItem: ReadonlyMap<string, readonly AttemptedOrphanFile[]> = new Map(),
  attemptedArrInstancesByItem: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
): Promise<ResolvedCleanupItem[]> {
  const resolved = await resolveWholeShowDownloadCleanupBatch(
    serverId,
    selectedItems,
    arrTargets,
    downloadTargets,
    attemptedJobKeysByItem,
    attemptedOrphanFilesByItem,
    attemptedArrInstancesByItem,
  );
  if (downloadTargets.length === 0) return resolved;
  return await mapWithConcurrency(resolved, 3, async (arrCleanup, index) => {
    const item = selectedItems[index]!;
    if (item.type !== 'movie' || arrCleanup.downloadJobs.length > 0) return arrCleanup;
    try {
      const versions = await plexClient.mediaVersionPathPreviews(item.ratingKey);
      if (
        versions.length === 0 ||
        !versions.every((version) =>
          version.allMediaEntriesRepresented === true && !version.truncated &&
          version.paths.length === 1 && Number.isSafeInteger(version.fileSize) &&
          version.fileSize! > 0
        )
      ) {
        throw new Error(
          'Every Plex Media entry must have an ID, one exact path, and a positive byte size',
        );
      }
      const direct = await resolveDirectQbittorrentCleanup(
        serverId,
        libraryKey,
        item.ratingKey,
        versions.map((version) => ({ plexPath: version.paths[0]!, size: version.fileSize! })),
        [],
        downloadTargets,
      );
      return {
        ...direct,
        arrStatus: arrCleanup.arrStatus,
        arrReason: arrCleanup.arrReason,
        arrTargets: arrCleanup.arrTargets,
      };
    } catch (error) {
      return {
        ...arrCleanup,
        status: 'unavailable' as const,
        downloadJobs: [],
        reason: error instanceof Error ? error.message : 'Direct qBittorrent proof failed',
        orphanFiles: [],
      };
    }
  });
}

export function assertDownloadJobSelectionConsistent(
  cleanups: readonly ResolvedCleanupItem[],
  cleanupSelectedRatingKeys: ReadonlySet<string>,
): void {
  const selectedJobs = new Set(
    cleanups.filter((cleanup) => cleanupSelectedRatingKeys.has(cleanup.ratingKey)).flatMap(
      (cleanup) => cleanup.downloadJobs.map((job) => `${job.instanceKey}:${job.jobId}`),
    ),
  );
  for (const cleanup of cleanups) {
    if (cleanupSelectedRatingKeys.has(cleanup.ratingKey)) continue;
    const associated = new Set([
      ...(cleanup.observedDownloadJobKeys ?? []),
      ...cleanup.downloadJobs.map((job) => `${job.instanceKey}:${job.jobId}`),
    ]);
    if ([...selectedJobs].some((job) => associated.has(job))) {
      throw new Error(
        'A verified qBittorrent job is shared by cleanup-selected and cleanup-unselected items',
      );
    }
  }
}

export async function loadAttemptedArrInstancesByItem(
  serverId: number,
  selectedItems: readonly DownloadResolvableItem[],
  instanceIds: readonly number[],
): Promise<Map<string, Set<number>>> {
  const result = new Map<string, Set<number>>();
  if (selectedItems.length === 0 || instanceIds.length === 0) return result;
  const itemByKey = new Map(selectedItems.map((item) => [item.ratingKey, item]));
  const attempts = await db.select({
    ratingKey: arrDeleteAttempts.ratingKey,
    instanceId: arrDeleteAttempts.arrInstanceId,
    externalId: arrDeleteAttempts.externalId,
  }).from(arrDeleteAttempts).where(and(
    eq(arrDeleteAttempts.serverId, serverId),
    inArray(arrDeleteAttempts.ratingKey, selectedItems.map((item) => item.ratingKey)),
    inArray(arrDeleteAttempts.arrInstanceId, [...instanceIds]),
  ));
  for (const attempt of attempts) {
    const item = itemByKey.get(attempt.ratingKey);
    const currentExternalId = item?.type === 'movie' ? item.tmdbId : item?.tvdbId;
    if (currentExternalId !== attempt.externalId) continue;
    const attemptedInstances = result.get(attempt.ratingKey) ?? new Set<number>();
    attemptedInstances.add(attempt.instanceId);
    result.set(attempt.ratingKey, attemptedInstances);
  }
  return result;
}

export async function loadAttemptedOrphanFilesByItem(
  serverId: number,
  ratingKeys: string[],
): Promise<Map<string, AttemptedOrphanFile[]>> {
  const result = new Map<string, AttemptedOrphanFile[]>();
  if (ratingKeys.length === 0) return result;
  const attempts = await db.select({
    ratingKey: downloadFileDeleteAttempts.ratingKey,
    path: downloadFileDeleteAttempts.localPath,
    root: downloadFileDeleteAttempts.rootPath,
    rootDevice: downloadFileDeleteAttempts.rootDevice,
    rootInode: downloadFileDeleteAttempts.rootInode,
  }).from(downloadFileDeleteAttempts).where(and(
    eq(downloadFileDeleteAttempts.serverId, serverId),
    inArray(downloadFileDeleteAttempts.ratingKey, ratingKeys),
  ));
  for (const attempt of attempts) {
    const files = result.get(attempt.ratingKey) ?? [];
    files.push(attempt);
    result.set(attempt.ratingKey, files);
  }
  return result;
}

export async function loadAttemptedDownloadJobKeysByItem(
  serverId: number,
  ratingKeys: string[],
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (ratingKeys.length === 0) return result;
  const attempts = await db.select({
    ratingKey: torrentDeleteAttempts.ratingKey,
    instanceKey: torrentDeleteAttempts.instanceKey,
    downloadId: torrentDeleteAttempts.torrentHash,
  }).from(torrentDeleteAttempts).where(and(
    eq(torrentDeleteAttempts.serverId, serverId),
    inArray(torrentDeleteAttempts.ratingKey, ratingKeys),
  ));
  for (const attempt of attempts) {
    const keys = result.get(attempt.ratingKey) ?? new Set<string>();
    keys.add(`${attempt.instanceKey}:${attempt.downloadId}`);
    result.set(attempt.ratingKey, keys);
  }
  return result;
}
