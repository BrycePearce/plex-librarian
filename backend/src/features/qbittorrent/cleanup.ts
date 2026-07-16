import type {
  TorrentCleanupPreviewItem,
  TorrentCleanupTorrent,
} from '@plex-librarian/shared/types.ts';
import type { ArrDeleteTarget, CoordinatedDeleteItem } from '../arr/delete.ts';
import type { QbittorrentTarget } from './connections.ts';
import {
  type AttemptedOrphanFile,
  completedOrphanFileAttempt,
  deleteVerifiedOrphanFile,
  findRetainedSiblingPaths,
  normalizeRemoteAbsolute,
  type PayloadScanBudget,
  type VerifiedOrphanFile,
  verifyOrphanHardlink,
  verifyTrackedHardlinks,
} from '../arr/orphanFiles.ts';

export interface ResolvedCleanupTorrent extends TorrentCleanupTorrent {
  target: QbittorrentTarget;
  manifestFiles: Array<{ path: string; size: number | null }>;
  authorizedSourcePaths: string[];
}

export interface ResolvedCleanupItem extends TorrentCleanupPreviewItem {
  torrents: ResolvedCleanupTorrent[];
  orphanFiles: VerifiedOrphanFile[];
  /** Every live torrent whose manifest owned one of this title's historical paths. */
  observedTorrentKeys?: Set<string>;
}

export function reconcileSharedTorrentCleanups(
  cleanups: readonly ResolvedCleanupItem[],
): ResolvedCleanupItem[] {
  const observations = new Map<string, { eligible: Set<string>; observed: Set<string> }>();
  for (const cleanup of cleanups) {
    for (const key of cleanup.observedTorrentKeys ?? []) {
      const state = observations.get(key) ?? {
        eligible: new Set<string>(),
        observed: new Set<string>(),
      };
      state.observed.add(cleanup.ratingKey);
      observations.set(key, state);
    }
    for (const torrent of cleanup.torrents) {
      const key = `${torrent.instanceKey}:${torrent.hash}`;
      const state = observations.get(key) ?? {
        eligible: new Set<string>(),
        observed: new Set<string>(),
      };
      if (cleanup.status === 'resolved') state.eligible.add(cleanup.ratingKey);
      observations.set(key, state);
    }
  }
  const conflicted = new Set(
    [...observations].filter(([, state]) =>
      [...state.observed].some((ratingKey) => !state.eligible.has(ratingKey))
    ).map(([key]) => key),
  );
  if (conflicted.size === 0) return [...cleanups];

  return cleanups.map((cleanup): ResolvedCleanupItem => {
    const removed = cleanup.torrents.filter((torrent) =>
      conflicted.has(`${torrent.instanceKey}:${torrent.hash}`)
    );
    if (removed.length === 0) return cleanup;
    const torrents = cleanup.torrents.filter((torrent) =>
      !conflicted.has(`${torrent.instanceKey}:${torrent.hash}`)
    );
    const retainedPaths = [...new Map([
      ...cleanup.retainedPaths,
      ...removed.map((torrent) => ({
        path: torrent.contentPath || torrent.savePath,
        reason:
          'This torrent is also associated with a selected title that did not independently authorize its complete payload; the shared job and files are retained',
      })),
    ].map((entry) => [entry.path, entry])).values()];
    if (torrents.length > 0 || cleanup.orphanFiles.length > 0) {
      return { ...cleanup, torrents, retainedPaths };
    }
    if (cleanup.status !== 'resolved') return { ...cleanup, torrents, retainedPaths };
    return {
      ...cleanup,
      status: 'unavailable',
      torrents,
      reason: 'A matching torrent is shared with another selected title and is retained',
      retainedPaths,
    };
  });
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

export async function executeDownloadedFileCleanup(
  cleanup: ResolvedCleanupItem,
  deletedTorrentKeys: Set<string>,
  deletedOrphanPaths: Set<string>,
  beforeTorrentDelete: (torrent: ResolvedCleanupTorrent, torrentKey: string) => Promise<void> =
    () => Promise.resolve(),
  deleteOrphanFile: (file: VerifiedOrphanFile) => Promise<void> = deleteVerifiedOrphanFile,
  beforeOrphanDelete: (file: VerifiedOrphanFile) => Promise<void> = () => Promise.resolve(),
): Promise<void> {
  for (const torrent of cleanup.torrents) {
    const torrentKey = `${torrent.instanceKey}:${torrent.hash}`;
    if (deletedTorrentKeys.has(torrentKey)) continue;
    const current = await torrent.target.client.torrent(torrent.hash);
    const authorizedPaths = new Set(torrent.authorizedSourcePaths);
    if (
      !current || current.hash !== torrent.hash ||
      !authorizedPaths.size ||
      ![...authorizedPaths].some((path) => torrentOwnsPath(current, path)) ||
      !torrentPayloadIsExclusivelyOwned(current, authorizedPaths)
    ) {
      throw new Error(
        'qBittorrent torrent identity or manifest changed since verification; nothing was removed',
      );
    }
    await beforeTorrentDelete(torrent, torrentKey);
    await torrent.target.client.deleteTorrent(torrent.hash);
    deletedTorrentKeys.add(torrentKey);
  }
  for (const orphanFile of cleanup.orphanFiles) {
    if (deletedOrphanPaths.has(orphanFile.path)) continue;
    await beforeOrphanDelete(orphanFile);
    await deleteOrphanFile(orphanFile);
    deletedOrphanPaths.add(orphanFile.path);
  }
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
  attemptedOrphanFiles: readonly AttemptedOrphanFile[] = [],
  attemptedArrInstanceIds: ReadonlySet<number> = new Set(),
  payloadScanBudget?: PayloadScanBudget,
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
      orphanFiles: [],
      retainedPaths: [],
    };
  }

  const associationPaths = new Map<string, Set<string>>();
  const associationHashes = new Set<string>();
  const arrMediaIds = new Map<number, number | null>();
  const sharedAssociationHashes = new Set<string>();
  const sources = new Map<string, ResolvedCleanupItem['sources'][number]>();
  const orphanFiles: VerifiedOrphanFile[] = [];
  const inspectionWarnings = new Map<string, ResolvedCleanupItem['retainedPaths'][number]>();
  const resolvedArrTargets: ResolvedCleanupItem['arrTargets'] = [];
  const arrErrors: string[] = [];
  const historyErrors: string[] = [];
  const orphanAttemptErrors: string[] = [];
  let completedOrphanAttemptCount = 0;
  let completedArrAttemptCount = 0;
  const configuredDownloadRoots = new Set(
    arrTargets.flatMap((target) =>
      target.pathMappings.filter((mapping) => mapping.kind === 'download').map((mapping) =>
        mapping.localPath
      )
    ),
  );
  for (const attempt of attemptedOrphanFiles) {
    try {
      if (await completedOrphanFileAttempt(attempt, configuredDownloadRoots)) {
        completedOrphanAttemptCount++;
      }
    } catch (error) {
      orphanAttemptErrors.push(
        `Orphan cleanup retry: ${error instanceof Error ? error.message : 'path check failed'}`,
      );
    }
  }
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
    if (!record) {
      arrMediaIds.set(arr.instanceId, null);
      if (attemptedArrInstanceIds.has(arr.instanceId)) completedArrAttemptCount++;
      continue;
    }
    arrMediaIds.set(arr.instanceId, record.id);
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
        associationHashes.add(association.hash);
        const hashPaths = associationPaths.get(association.hash) ?? new Set<string>();
        if (association.sourcePath) hashPaths.add(association.sourcePath);
        associationPaths.set(association.hash, hashPaths);
        if (association.sourcePath) {
          const trackedPaths = [
            ...(mediaFiles ?? []).map((file) => file.relativePath),
            ...(extraFiles ?? []).map((file) => file.relativePath),
          ];
          const currentManagedPaths = trackedPaths.flatMap((relativePath) => {
            const path = record.path ? appendRemote(record.path, relativePath) : null;
            return path ? [path] : [];
          });
          const verification = await verifyOrphanHardlink(
            arr.instanceName,
            association,
            arr.pathMappings,
            currentManagedPaths,
          );
          if (verification) {
            sources.set(
              `${arr.instanceId}:${association.hash}:${association.sourcePath}:${association.importedPath}`,
              verification.source,
            );
            if (verification.file) orphanFiles.push(verification.file);
          }
          orphanFiles.push(
            ...await verifyTrackedHardlinks(
              record.path,
              trackedPaths,
              association,
              arr.pathMappings,
            ),
          );
        }
      }
    } catch (error) {
      historyErrors.push(
        `${arr.instanceName}: ${error instanceof Error ? error.message : 'history lookup failed'}`,
      );
    }
  }

  if (qbitTargets.length > 0 && arrErrors.length === 0 && associationHashes.size > 0) {
    for (const arr of arrTargets) {
      for (const hash of associationHashes) {
        try {
          if (
            !await arr.client.downloadIdIsExclusiveTo(arrMediaIds.get(arr.instanceId) ?? null, hash)
          ) {
            sharedAssociationHashes.add(hash);
          }
        } catch (error) {
          historyErrors.push(
            `${arr.instanceName}: ${
              error instanceof Error ? error.message : 'download history lookup failed'
            }`,
          );
        }
      }
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
      orphanFiles,
      retainedPaths: [...inspectionWarnings.values()],
    };
  }
  if (resolvedArrTargets.length === 0 && completedArrAttemptCount === 0) {
    return {
      ratingKey,
      status: 'unavailable',
      torrents: [],
      reason: 'The item was not found in any mapped Sonarr or Radarr instance',
      arrStatus: 'unavailable',
      arrReason: 'The item was not found in any mapped Sonarr or Radarr instance',
      arrTargets: [],
      sources: [],
      orphanFiles: [],
      retainedPaths: [...inspectionWarnings.values()],
    };
  }
  if (orphanAttemptErrors.length > 0) {
    return {
      ratingKey,
      status: 'error',
      torrents: [],
      reason: [...new Set(orphanAttemptErrors)].join('; '),
      arrStatus: 'resolved',
      arrTargets: resolvedArrTargets,
      sources: publicSources,
      orphanFiles: [],
      retainedPaths: [...inspectionWarnings.values()],
    };
  }
  if (
    qbitTargets.length === 0 && orphanFiles.length === 0 &&
    completedOrphanAttemptCount === 0
  ) {
    return {
      ratingKey,
      status: 'unavailable',
      torrents: [],
      reason: 'No qBittorrent connection is configured',
      arrStatus: 'resolved',
      arrTargets: resolvedArrTargets,
      sources: publicSources,
      orphanFiles: [],
      retainedPaths: [...inspectionWarnings.values()],
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
      orphanFiles,
      retainedPaths: [...inspectionWarnings.values()],
    };
  }

  const torrents: ResolvedCleanupTorrent[] = [];
  const ownedLiveTorrents: ResolvedCleanupTorrent[] = [];
  const observedTorrentKeys = new Set<string>();
  let completedAttemptCount = 0;
  let unownedLiveTorrentCount = 0;
  let nonExclusiveLiveTorrentCount = 0;
  const qbitErrors: string[] = [];
  for (const target of qbitTargets) {
    const instancePrefix = `${target.instanceKey}:`;
    const candidateHashes = new Set(associationHashes);
    for (const attemptedKey of attemptedTorrentKeys) {
      if (attemptedKey.startsWith(instancePrefix)) {
        candidateHashes.add(attemptedKey.slice(instancePrefix.length));
      }
    }
    for (const hash of candidateHashes) {
      const sourcePaths = associationPaths.get(hash) ?? new Set<string>();
      const sourcePath = sourcePaths.values().next().value ?? null;
      try {
        const torrent = await target.client.torrent(hash);
        if (!torrent) {
          if (attemptedTorrentKeys.has(`${target.instanceKey}:${hash}`)) {
            completedAttemptCount++;
          }
          continue;
        }
        if (![...sourcePaths].some((path) => torrentOwnsPath(torrent, path))) {
          // A hash can be re-added at a different save path, or appear in another
          // qBittorrent instance. It is not the historical payload unless its full
          // manifest owns at least one exact Arr source path.
          unownedLiveTorrentCount++;
          continue;
        }
        const resolvedTorrent = {
          ...torrent,
          instanceKey: target.instanceKey,
          instanceName: target.instanceName,
          sourcePath,
          authorizedSourcePaths: [...sourcePaths],
          target,
        };
        ownedLiveTorrents.push(resolvedTorrent);
        observedTorrentKeys.add(`${target.instanceKey}:${hash}`);
        if (sharedAssociationHashes.has(hash)) {
          nonExclusiveLiveTorrentCount++;
          inspectionWarnings.set(torrent.contentPath || torrent.savePath, {
            path: torrent.contentPath || torrent.savePath,
            reason:
              'Arr history associates this torrent with another title; the shared job and payload are retained',
          });
          continue;
        }
        if (!torrentPayloadIsExclusivelyOwned(torrent, sourcePaths)) {
          nonExclusiveLiveTorrentCount++;
          inspectionWarnings.set(torrent.contentPath || torrent.savePath, {
            path: torrent.contentPath || torrent.savePath,
            reason:
              'Live torrent contains files that are not individually attributed to this selected Arr title; the job and payload are retained',
          });
          continue;
        }
        torrents.push(resolvedTorrent);
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
      orphanFiles,
      retainedPaths: [...inspectionWarnings.values()],
      observedTorrentKeys,
    };
  }
  // Never unlink a file underneath a live job that was retained because its complete
  // payload could not be attributed. qBittorrent could otherwise restore the file, and
  // the user would still have an active job with a partially removed payload.
  const directOrphanFiles = selectDirectOrphanFiles(orphanFiles, ownedLiveTorrents);
  const retainedPaths = [...new Map([
    ...inspectionWarnings.values(),
    ...await findRetainedSiblingPaths(
      directOrphanFiles,
      undefined,
      payloadScanBudget,
    ),
  ].map((entry) => [entry.path, entry])).values()];
  if (
    torrents.length > 0 || completedAttemptCount > 0 || directOrphanFiles.length > 0 ||
    completedOrphanAttemptCount > 0
  ) {
    return {
      ratingKey,
      status: 'resolved',
      torrents,
      ...(torrents.length === 0 && directOrphanFiles.length === 0
        ? {
          reason: completedOrphanAttemptCount > 0
            ? 'Downloaded-file cleanup was previously started and the verified path is now absent'
            : 'Torrent deletion was previously started and the torrent is now absent',
        }
        : {}),
      arrStatus: 'resolved',
      arrTargets: resolvedArrTargets,
      sources: publicSources,
      orphanFiles: directOrphanFiles,
      retainedPaths,
      observedTorrentKeys,
    };
  }
  return {
    ratingKey,
    status: 'unavailable',
    torrents: [],
    reason: associationHashes.size === 0
      ? 'Arr has no retained torrent import history for this item'
      : nonExclusiveLiveTorrentCount > 0
      ? 'A matching live torrent contains files that are not all attributable to this Arr title'
      : unownedLiveTorrentCount > 0
      ? 'A matching torrent hash exists, but its manifest does not own the historical source path'
      : 'The imported torrent is no longer present in configured qBittorrent instances',
    arrStatus: 'resolved',
    arrTargets: resolvedArrTargets,
    sources: publicSources,
    orphanFiles: [],
    retainedPaths,
    observedTorrentKeys,
  };
}

export function selectDirectOrphanFiles(
  files: readonly VerifiedOrphanFile[],
  torrents: readonly ResolvedCleanupTorrent[],
): VerifiedOrphanFile[] {
  return [
    ...new Map(
      files.filter((file) =>
        !torrents.some((torrent) =>
          torrent.hash === file.hash && torrentOwnsPath(torrent, file.remotePath)
        )
      ).map((file) => [file.path, file]),
    ).values(),
  ];
}

export function publicCleanupItem(item: ResolvedCleanupItem): TorrentCleanupPreviewItem {
  return {
    ratingKey: item.ratingKey,
    status: item.status,
    reason: item.reason,
    torrents: item.torrents.map(({
      target: _target,
      manifestFiles: _manifestFiles,
      authorizedSourcePaths: _authorizedSourcePaths,
      ...torrent
    }) => torrent),
    arrStatus: item.arrStatus,
    arrReason: item.arrReason,
    arrTargets: item.arrTargets,
    sources: item.sources,
    orphanFiles: item.orphanFiles.map((
      {
        hash: _hash,
        importedPath: _importedPath,
        importedRoot: _importedRoot,
        root: _root,
        boundary: _boundary,
        remotePath: _remotePath,
        dev: _dev,
        ino: _ino,
        ...file
      },
    ) => file),
    retainedPaths: item.retainedPaths,
  };
}

function appendRemote(root: string, relative: string): string | null {
  const normalizedRoot = normalizeRemoteAbsolute(root);
  if (!normalizedRoot) return null;
  const absoluteRelative = normalizeRemoteAbsolute(relative);
  if (absoluteRelative) return null;
  const parts = relative.split(/[\\/]+/).filter((part) => part && part !== '.');
  if (parts.length === 0 || parts.includes('..')) return null;
  return `${normalizedRoot.path}${normalizedRoot.separator}${parts.join(normalizedRoot.separator)}`;
}

export function torrentOwnsPath(
  torrent: Pick<ResolvedCleanupTorrent, 'contentPath' | 'savePath' | 'manifestFiles'>,
  sourcePath: string,
): boolean {
  const source = normalizeRemoteAbsolute(sourcePath);
  if (!source) return false;
  const candidates = new Set<string>();
  const content = normalizeRemoteAbsolute(torrent.contentPath);
  if (content) candidates.add(content.comparison);
  for (const file of torrent.manifestFiles) {
    for (const root of [torrent.savePath, torrent.contentPath]) {
      const candidate = appendRemote(root, file.path);
      const normalized = candidate ? normalizeRemoteAbsolute(candidate) : null;
      if (normalized) candidates.add(normalized.comparison);
    }
  }
  return candidates.has(source.comparison);
}

export function torrentPayloadIsExclusivelyOwned(
  torrent: Pick<ResolvedCleanupTorrent, 'contentPath' | 'savePath' | 'manifestFiles'>,
  sourcePaths: ReadonlySet<string>,
): boolean {
  if (torrent.manifestFiles.length === 0 || sourcePaths.size === 0) return false;
  const owned = new Set(
    [...sourcePaths].flatMap((path) => {
      const normalized = normalizeRemoteAbsolute(path);
      return normalized ? [normalized.comparison] : [];
    }),
  );
  return torrent.manifestFiles.every((file) => {
    for (const root of [torrent.savePath, torrent.contentPath]) {
      const candidate = appendRemote(root, file.path);
      const normalized = candidate ? normalizeRemoteAbsolute(candidate) : null;
      if (normalized && owned.has(normalized.comparison)) return true;
    }
    return false;
  });
}
