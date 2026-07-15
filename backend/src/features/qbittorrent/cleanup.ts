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
  if (id === null || arrTargets.length === 0 || qbitTargets.length === 0) {
    return {
      ratingKey,
      status: 'unavailable',
      torrents: [],
      reason: id === null
        ? 'No TMDB/TVDB ID is available for Arr history lookup'
        : arrTargets.length === 0
        ? 'This library is not mapped to Sonarr or Radarr'
        : 'No qBittorrent connection is configured',
    };
  }

  const associations = new Map<string, string | null>();
  const errors: string[] = [];
  for (const arr of arrTargets) {
    try {
      const record = await arr.client.lookup(id);
      if (!record) continue;
      for (const association of await arr.client.torrentAssociations(record.id)) {
        associations.set(association.hash, association.sourcePath);
      }
    } catch (error) {
      errors.push(
        `${arr.instanceName}: ${error instanceof Error ? error.message : 'lookup failed'}`,
      );
    }
  }

  const torrents: ResolvedCleanupTorrent[] = [];
  let completedAttemptCount = 0;
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
        errors.push(
          `${target.instanceName}: ${error instanceof Error ? error.message : 'lookup failed'}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    return {
      ratingKey,
      status: 'error',
      torrents,
      reason: [...new Set(errors)].join('; '),
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
    };
  }
  return {
    ratingKey,
    status: 'unavailable',
    torrents: [],
    reason: associations.size === 0
      ? 'Arr has no retained torrent import history for this item'
      : 'The imported torrent is no longer present in configured qBittorrent instances',
  };
}

export function publicCleanupItem(item: ResolvedCleanupItem): TorrentCleanupPreviewItem {
  return {
    ratingKey: item.ratingKey,
    status: item.status,
    reason: item.reason,
    torrents: item.torrents.map(({ target: _target, ...torrent }) => torrent),
  };
}
