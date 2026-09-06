import type { ArrDeleteTarget } from '../../arr/delete.ts';
import { resolveDirectQbittorrentCleanup } from '../../qbittorrent/directDiscovery.ts';
import { type ResolvedCleanupItem, resolveDownloadCleanup } from '../cleanup.ts';
import type { DownloadClientTarget } from '../downloadClient.ts';
import { normalizeRemoteAbsolute } from '../hardlinks.ts';

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

export interface SeasonDownloadAssignmentSource {
  instanceKey: string;
  jobId: string;
  importedPath: string;
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
  selectedArrPaths?: readonly string[];
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
  const selectedPaths = new Set([
    ...input.selected.map((selection) => selection.plexPath),
    ...(input.selectedArrPaths ?? []),
  ].flatMap((selectedPath) => {
    const path = normalizeRemoteAbsolute(selectedPath)?.comparison;
    return path ? [path] : [];
  }));
  const associatedJobIds = new Set(seriesCleanup.sources.flatMap((source) => {
    const path = source.importedPath
      ? normalizeRemoteAbsolute(source.importedPath)?.comparison
      : undefined;
    return path && selectedPaths.has(path) ? [source.downloadId] : [];
  }));
  // A series can have jobs for other seasons. Only expose a current job associated
  // with this exact selection as its read-only access sample.
  const accessJob = seriesCleanup.qbittorrentPathAccessJob;
  const qbittorrentPathAccessJob = accessJob && associatedJobIds.has(accessJob.jobId)
    ? accessJob
    : undefined;
  seriesCleanup = { ...seriesCleanup, qbittorrentPathAccessJob };
  try {
    const direct = await resolveDirectQbittorrentCleanup(
      input.serverId,
      input.libraryKey,
      input.showRatingKey,
      input.selected,
      input.retained,
      input.downloadTargets,
      associatedJobIds,
    );
    if (direct.status !== 'resolved') {
      return { ...direct, qbittorrentPathAccessJob };
    }
    if (seriesCleanup?.status === 'resolved') {
      // Whole-series history is a discovery hint, not the selected job set or
      // current manifest authority. Direct discovery has already required full
      // current proof for every live associated job in this selection.
      return {
        ...direct,
        arrStatus: seriesCleanup.arrStatus,
        arrReason: seriesCleanup.arrReason,
        arrTargets: seriesCleanup.arrTargets,
      };
    }
    return direct;
  } catch (error) {
    // A resolved historical association must never override a failed current
    // file check, especially an alias of a retained Plex version.
    seriesCleanup = {
      qbittorrentPathAccessJob,
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
  sources: readonly SeasonDownloadAssignmentSource[],
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
    const path = normalizeRemoteAbsolute(source.importedPath)?.comparison ?? null;
    if (!path) continue;
    const targetsForPath = targetKeysByPath.get(path);
    if (!targetsForPath) continue;
    const jobKey = `${source.instanceKey}:${source.jobId}`;
    const keys = jobTargetKeys.get(jobKey) ?? new Set<string>();
    for (const targetKey of targetsForPath) keys.add(targetKey);
    jobTargetKeys.set(jobKey, keys);
  }
  const owners = new Map<string, string>();
  const coveredTargetKeys = new Set<string>();
  for (const [jobKey, targetKeys] of jobTargetKeys) {
    if (targetKeys.size !== 1 && !allowCrossTarget) continue;
    const ordered = [...targetKeys].sort((left, right) => {
      const a = targetOrder.get(left)!;
      const b = targetOrder.get(right)!;
      return a[0] - b[0] || a[1].localeCompare(b[1]) || a[2] - b[2] || a[3] - b[3];
    });
    if (ordered.length === 0) continue;
    owners.set(jobKey, ordered[0]!);
    for (const key of ordered) coveredTargetKeys.add(key);
  }
  return { owners, coveredTargetKeys };
}
