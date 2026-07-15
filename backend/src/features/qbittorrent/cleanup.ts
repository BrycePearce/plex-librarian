import type {
  TorrentCleanupPreviewItem,
  TorrentCleanupTorrent,
} from '@plex-librarian/shared/types.ts';
import type { ArrDeleteTarget, CoordinatedDeleteItem } from '../arr/delete.ts';
import type { QbittorrentTarget } from './connections.ts';

export interface ResolvedCleanupTorrent extends TorrentCleanupTorrent {
  target: QbittorrentTarget;
}

export interface ResolvedCleanupItem extends TorrentCleanupPreviewItem {
  torrents: ResolvedCleanupTorrent[];
}

export function selectVerifiedTorrentCleanups(
  cleanups: Iterable<ResolvedCleanupItem>,
): Map<string, ResolvedCleanupItem> {
  const verified = new Map<string, ResolvedCleanupItem>();
  for (const cleanup of cleanups) {
    // Error results may contain torrents observed before another configured client
    // failed. They are deliberately excluded: only a completely resolved item is
    // safe to include in an optional partial-batch mutation.
    if (cleanup.status === 'resolved') verified.set(cleanup.ratingKey, cleanup);
  }
  return verified;
}

function externalId(item: CoordinatedDeleteItem): number | null {
  return item.type === 'movie' ? item.tmdbId : item.type === 'show' ? item.tvdbId : null;
}

export async function resolveTorrentCleanup(
  ratingKey: string,
  item: CoordinatedDeleteItem,
  arrTargets: ArrDeleteTarget[],
  qbitTargets: QbittorrentTarget[],
  attemptedTorrentKeys: ReadonlySet<string> = new Set(),
): Promise<ResolvedCleanupItem> {
  const id = externalId(item);
  if (id === null || arrTargets.length === 0) {
    return {
      ratingKey,
      status: 'unavailable',
      torrents: [],
      reason: id === null
        ? 'No TMDB/TVDB ID is available for Arr history lookup'
        : 'This library is not mapped to Sonarr or Radarr',
      arrStatus: 'unavailable',
      arrReason: id === null
        ? 'No TMDB/TVDB ID is available for managed deletion'
        : 'This library is not mapped to Sonarr or Radarr',
      arrTargets: [],
      sources: [],
    };
  }

  const associations = new Map<string, string | null>();
  const sources = new Map<string, ResolvedCleanupItem['sources'][number]>();
  const resolvedArrTargets: ResolvedCleanupItem['arrTargets'] = [];
  const arrErrors: string[] = [];
  const historyErrors: string[] = [];
  for (const arr of arrTargets) {
    let record;
    try {
      record = await arr.client.lookup(id);
    } catch (error) {
      arrErrors.push(
        `${arr.instanceName}: ${error instanceof Error ? error.message : 'lookup failed'}`,
      );
      continue;
    }
    if (!record) continue;
    const [mediaFiles, extraFiles] = await Promise.all([
      arr.client.mediaFiles(record.id).catch(() => null),
      arr.client.extraFiles(record.id).catch(() => null),
    ]);
    resolvedArrTargets.push({
      instanceName: arr.instanceName,
      type: arr.client.type,
      title: record.title,
      path: record.path,
      mediaFiles,
      extraFiles,
    });
    try {
      const torrentAssociations = await arr.client.torrentAssociations(record.id);
      for (const association of torrentAssociations) {
        associations.set(association.hash, association.sourcePath);
        if (association.sourcePath) {
          sources.set(`${arr.instanceId}:${association.hash}:${association.sourcePath}`, {
            instanceName: arr.instanceName,
            hash: association.hash,
            path: association.sourcePath,
          });
        }
      }
    } catch (error) {
      historyErrors.push(
        `${arr.instanceName}: ${error instanceof Error ? error.message : 'history lookup failed'}`,
      );
    }
  }

  const publicSources = [...sources.values()];
  if (arrErrors.length > 0) {
    const reason = [...new Set(arrErrors)].join('; ');
    return {
      ratingKey,
      status: 'error',
      torrents: [],
      reason,
      arrStatus: 'error',
      arrReason: reason,
      arrTargets: resolvedArrTargets,
      sources: publicSources,
    };
  }
  if (resolvedArrTargets.length === 0) {
    return {
      ratingKey,
      status: 'unavailable',
      torrents: [],
      reason: 'The item was not found in any mapped Sonarr or Radarr instance',
      arrStatus: 'unavailable',
      arrReason: 'The item was not found in any mapped Sonarr or Radarr instance',
      arrTargets: [],
      sources: [],
    };
  }
  if (qbitTargets.length === 0) {
    return {
      ratingKey,
      status: 'unavailable',
      torrents: [],
      reason: 'No qBittorrent connection is configured',
      arrStatus: 'resolved',
      arrTargets: resolvedArrTargets,
      sources: publicSources,
    };
  }
  if (historyErrors.length > 0) {
    return {
      ratingKey,
      status: 'error',
      torrents: [],
      reason: [...new Set(historyErrors)].join('; '),
      arrStatus: 'resolved',
      arrTargets: resolvedArrTargets,
      sources: publicSources,
    };
  }

  const torrents: ResolvedCleanupTorrent[] = [];
  let completedAttemptCount = 0;
  const qbitErrors: string[] = [];
  for (const target of qbitTargets) {
    const instancePrefix = `${target.instanceKey}:`;
    const candidateHashes = new Set(associations.keys());
    for (const attemptedKey of attemptedTorrentKeys) {
      if (attemptedKey.startsWith(instancePrefix)) {
        candidateHashes.add(attemptedKey.slice(instancePrefix.length));
      }
    }
    for (const hash of candidateHashes) {
      const sourcePath = associations.get(hash) ?? null;
      try {
        const torrent = await target.client.torrent(hash);
        if (!torrent) {
          if (attemptedTorrentKeys.has(`${target.instanceKey}:${hash}`)) {
            completedAttemptCount++;
          }
          continue;
        }
        torrents.push({
          ...torrent,
          instanceKey: target.instanceKey,
          instanceName: target.instanceName,
          sourcePath,
          target,
        });
      } catch (error) {
        qbitErrors.push(
          `${target.instanceName}: ${error instanceof Error ? error.message : 'lookup failed'}`,
        );
      }
    }
  }

  if (qbitErrors.length > 0) {
    return {
      ratingKey,
      status: 'error',
      torrents,
      reason: [...new Set(qbitErrors)].join('; '),
      arrStatus: 'resolved',
      arrTargets: resolvedArrTargets,
      sources: publicSources,
    };
  }
  if (torrents.length > 0 || completedAttemptCount > 0) {
    return {
      ratingKey,
      status: 'resolved',
      torrents,
      ...(torrents.length === 0
        ? { reason: 'Torrent deletion was previously started and the torrent is now absent' }
        : {}),
      arrStatus: 'resolved',
      arrTargets: resolvedArrTargets,
      sources: publicSources,
    };
  }
  return {
    ratingKey,
    status: 'unavailable',
    torrents: [],
    reason: associations.size === 0
      ? 'Arr has no retained torrent import history for this item'
      : 'The imported torrent is no longer present in configured qBittorrent instances',
    arrStatus: 'resolved',
    arrTargets: resolvedArrTargets,
    sources: publicSources,
  };
}

export function publicCleanupItem(item: ResolvedCleanupItem): TorrentCleanupPreviewItem {
  return {
    ratingKey: item.ratingKey,
    status: item.status,
    reason: item.reason,
    torrents: item.torrents.map(({ target: _target, ...torrent }) => torrent),
    arrStatus: item.arrStatus,
    arrReason: item.arrReason,
    arrTargets: item.arrTargets,
    sources: item.sources,
  };
}
