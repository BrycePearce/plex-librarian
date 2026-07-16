import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import {
  arrDeleteAttempts,
  downloadFileDeleteAttempts,
  torrentDeleteAttempts,
} from '../../db/schema.ts';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import { type AttemptedOrphanFile, DEFAULT_PAYLOAD_SCAN_LIMITS } from './hardlinks.ts';
import { type ResolvedCleanupItem, resolveDownloadCleanup } from './cleanup.ts';
import type { DownloadClientTarget } from './downloadClient.ts';

export interface DownloadResolvableItem {
  ratingKey: string;
  title: string;
  type: string;
  tmdbId: number | null;
  tvdbId: number | null;
}

export async function resolveDownloadCleanupBatch(
  selectedItems: DownloadResolvableItem[],
  arrTargets: ArrDeleteTarget[],
  downloadTargets: DownloadClientTarget[],
  attemptedJobKeysByItem: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  attemptedOrphanFilesByItem: ReadonlyMap<string, readonly AttemptedOrphanFile[]> = new Map(),
  attemptedArrInstancesByItem: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
): Promise<ResolvedCleanupItem[]> {
  const results = new Array<ResolvedCleanupItem>(selectedItems.length);
  const payloadScanBudget = { remainingEntries: DEFAULT_PAYLOAD_SCAN_LIMITS.maxEntries };
  let nextIndex = 0;
  // A bounded pool keeps bulk previews responsive without bursting against external services.
  const workers = Array.from(
    { length: Math.min(3, selectedItems.length) },
    async () => {
      while (nextIndex < selectedItems.length) {
        const index = nextIndex++;
        const item = selectedItems[index];
        results[index] = await resolveDownloadCleanup(
          item.ratingKey,
          item,
          arrTargets,
          downloadTargets,
          attemptedJobKeysByItem.get(item.ratingKey),
          attemptedOrphanFilesByItem.get(item.ratingKey),
          attemptedArrInstancesByItem.get(item.ratingKey),
          payloadScanBudget,
        );
      }
    },
  );
  await Promise.all(workers);
  return results;
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
