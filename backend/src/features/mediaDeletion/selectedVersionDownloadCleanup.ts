import type { PlexMediaVersionPathPreview } from '../../integrations/plex/types.ts';
import { resolveDirectQbittorrentCleanup } from '../qbittorrent/directDiscovery.ts';
import type { ResolvedCleanupItem } from './cleanup.ts';
import type { DownloadClientTarget } from './downloadClient.ts';
import { normalizeRemoteAbsolute } from './hardlinks.ts';

/** Historical associations discover jobs; only their current complete payload may be selected. */
export async function resolveSelectedVersionDownloadCleanup(input: {
  serverId: number;
  libraryKey: string;
  rawCleanup: ResolvedCleanupItem;
  liveVersions: readonly PlexMediaVersionPathPreview[];
  selectedMediaIds: ReadonlySet<number>;
  selectedArrPaths?: readonly string[];
  downloadTargets: readonly DownloadClientTarget[];
}): Promise<ResolvedCleanupItem> {
  const { rawCleanup, liveVersions, selectedMediaIds } = input;
  const selected = liveVersions.filter((version) => selectedMediaIds.has(version.mediaId));
  const paths = new Set(
    selected.flatMap((version) => version.paths).flatMap((path) => {
      const normalized = normalizeRemoteAbsolute(path)?.comparison;
      return normalized ? [normalized] : [];
    }),
  );
  if (input.downloadTargets.length === 0 || selectedMediaIds.size === 0) return rawCleanup;
  // Import history can identify the right job, but cannot establish that its
  // current payload is independent of every retained Plex directory entry.
  // A failed service lookup is not evidence that direct discovery may replace it.
  if (rawCleanup.status === 'error') return rawCleanup;
  const associatedPaths = new Set([
    ...paths,
    ...(input.selectedArrPaths ?? []).flatMap((path) => {
      const normalized = normalizeRemoteAbsolute(path)?.comparison;
      return normalized ? [normalized] : [];
    }),
  ]);
  const associatedJobIds = new Set(rawCleanup.sources.flatMap((source) => {
    const imported = source.importedPath
      ? normalizeRemoteAbsolute(source.importedPath)?.comparison
      : undefined;
    return imported && associatedPaths.has(imported) ? [source.downloadId] : [];
  }));
  try {
    if (
      selected.length !== selectedMediaIds.size || liveVersions.length <= selected.length ||
      !liveVersions.every((version) =>
        version.allMediaEntriesRepresented === true && !version.truncated &&
        version.paths.length === 1 && Number.isSafeInteger(version.fileSize) &&
        version.fileSize! > 0
      )
    ) {
      throw new Error('Complete current selected and retained Plex file identities are required');
    }
    const selections = (versions: readonly PlexMediaVersionPathPreview[]) =>
      versions.map((version) => ({ plexPath: version.paths[0]!, size: version.fileSize! }));
    const direct = await resolveDirectQbittorrentCleanup(
      input.serverId,
      input.libraryKey,
      rawCleanup.ratingKey,
      selections(selected),
      selections(liveVersions.filter((version) => !selectedMediaIds.has(version.mediaId))),
      [...input.downloadTargets],
      associatedJobIds,
    );
    return {
      ...direct,
      arrStatus: rawCleanup.arrStatus,
      arrReason: rawCleanup.arrReason,
      arrTargets: rawCleanup.arrTargets,
      sources: direct.status === 'resolved' ? direct.sources : rawCleanup.sources,
      qbittorrentPathAccessJob: rawCleanup.qbittorrentPathAccessJob,
    };
  } catch (error) {
    return {
      ...rawCleanup,
      status: 'unavailable',
      downloadJobs: [],
      orphanFiles: [],
      reason: error instanceof Error ? error.message : 'Current qBittorrent payload proof failed',
    };
  }
}
