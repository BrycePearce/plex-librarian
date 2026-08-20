import type { ArrDeleteTarget } from '../arr/delete.ts';
import { resolveDirectQbittorrentCleanup } from '../qbittorrent/directDiscovery.ts';
import { type ResolvedCleanupItem, resolveDownloadCleanup } from './cleanup.ts';
import type { DownloadClientTarget } from './downloadClient.ts';
import { normalizeRemoteAbsolute } from './hardlinks.ts';

export interface SeasonDownloadSelection {
  plexPath: string;
  size: number;
}

export interface SeasonDownloadAssignmentEntry {
  targetKey: string;
  episodeNumber: number;
  episodeRatingKey: string;
  mediaId: number;
  path: string;
  automaticAdoption?: boolean;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return '{' + Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',') +
      '}';
  }
  return JSON.stringify(value);
}

function cleanupJobAuthorization(cleanup: ResolvedCleanupItem): string[] {
  return cleanup.downloadJobs.map((job) =>
    canonical({
      instanceKey: job.instanceKey,
      jobId: job.jobId,
      authorizedSourcePaths: [...job.authorizedSourcePaths].sort(),
    })
  ).sort();
}

export function downloadCleanupEvidenceAgrees(
  arrHistory: ResolvedCleanupItem,
  direct: ResolvedCleanupItem,
): boolean {
  return canonical(cleanupJobAuthorization(arrHistory)) ===
    canonical(cleanupJobAuthorization(direct));
}

/** Resolve season-scoped download ownership without assuming what remains afterward. */
export async function resolveSeasonDownloadCleanup(input: {
  serverId: number;
  libraryKey: string;
  showRatingKey: string;
  show: { title: string; type: string; tmdbId: number | null; tvdbId: number | null };
  arrTargets: readonly ArrDeleteTarget[];
  downloadTargets: readonly DownloadClientTarget[];
  selected: readonly SeasonDownloadSelection[];
  retained: readonly SeasonDownloadSelection[];
  inspect: boolean;
}): Promise<ResolvedCleanupItem | null> {
  if (!input.inspect) return null;
  let seriesCleanup = await resolveDownloadCleanup(
    input.showRatingKey,
    input.show,
    [...input.arrTargets],
    [...input.downloadTargets],
  );
  if (input.downloadTargets.length === 0) return seriesCleanup;

  try {
    const direct = await resolveDirectQbittorrentCleanup(
      input.serverId,
      input.libraryKey,
      input.showRatingKey,
      input.selected,
      input.retained,
      input.downloadTargets,
    );
    if (direct.status !== 'resolved') return seriesCleanup;
    if (seriesCleanup?.status === 'resolved') {
      if (!downloadCleanupEvidenceAgrees(seriesCleanup, direct)) {
        return {
          ...seriesCleanup,
          status: 'error',
          downloadJobs: [],
          reason: 'Arr history and direct qBittorrent ownership evidence disagree',
        };
      }
      return {
        ...direct,
        arrStatus: seriesCleanup.arrStatus,
        arrReason: seriesCleanup.arrReason,
        arrTargets: seriesCleanup.arrTargets,
      };
    }
    return direct;
  } catch (error) {
    if (seriesCleanup?.status === 'resolved') return seriesCleanup;
    seriesCleanup = {
      ratingKey: input.showRatingKey,
      status: 'unavailable',
      downloadJobs: [],
      reason: error instanceof Error ? error.message : 'Direct qBittorrent discovery failed',
      arrStatus: seriesCleanup?.arrStatus ?? 'unavailable',
      arrReason: seriesCleanup?.arrReason,
      arrTargets: seriesCleanup?.arrTargets ?? [],
      sources: [],
      orphanFiles: [],
      retainedPaths: [],
    };
    return seriesCleanup;
  }
}

export function seasonDownloadJobAssignments(
  selectedEntries: readonly SeasonDownloadAssignmentEntry[],
  sources: readonly { downloadId: string; importedPath: string | null }[],
  allowCrossTarget: boolean,
): { owners: Map<string, string>; coveredTargetKeys: Set<string> } {
  const targetKeysByPath = new Map<string, Set<string>>();
  const targetOrder = new Map<string, readonly [number, string, number, number]>();
  for (const entry of selectedEntries) {
    const keys = targetKeysByPath.get(entry.path) ?? new Set<string>();
    keys.add(entry.targetKey);
    targetKeysByPath.set(entry.path, keys);
    targetOrder.set(entry.targetKey, [
      entry.episodeNumber,
      entry.episodeRatingKey,
      Number(entry.automaticAdoption === true),
      entry.mediaId,
    ]);
  }
  const jobTargetKeys = new Map<string, Set<string>>();
  for (const source of sources) {
    const path = source.importedPath === null
      ? null
      : normalizeRemoteAbsolute(source.importedPath)?.comparison ?? null;
    if (!path) continue;
    const targetsForPath = targetKeysByPath.get(path);
    if (!targetsForPath) continue;
    const keys = jobTargetKeys.get(source.downloadId) ?? new Set<string>();
    for (const targetKey of targetsForPath) keys.add(targetKey);
    jobTargetKeys.set(source.downloadId, keys);
  }
  const owners = new Map<string, string>();
  const coveredTargetKeys = new Set<string>();
  for (const [jobId, targetKeys] of jobTargetKeys) {
    if (targetKeys.size !== 1 && !allowCrossTarget) continue;
    const ordered = [...targetKeys].sort((left, right) => {
      const a = targetOrder.get(left)!;
      const b = targetOrder.get(right)!;
      return a[0] - b[0] || a[1].localeCompare(b[1]) || a[2] - b[2] || a[3] - b[3];
    });
    if (ordered.length === 0) continue;
    owners.set(jobId, ordered[0]!);
    for (const key of ordered) coveredTargetKeys.add(key);
  }
  return { owners, coveredTargetKeys };
}
