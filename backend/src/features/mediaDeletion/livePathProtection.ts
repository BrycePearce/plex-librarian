import type { ArrPathMapping } from '@plex-librarian/shared/types.ts';
import type { DownloadClientTarget } from './downloadClient.ts';
import {
  discoverMappedDownloadJobs,
  localDownloadJobOwnedPaths,
} from './mappedDownloadDiscovery.ts';
import { createLocalPathIdentityResolver } from './localPathIdentity.ts';

import { mapArrPath } from './hardlinks.ts';
import { getDownloadClientTargets } from './targets.ts';
import { withTransaction } from '../../db/index.ts';
import { loadPlexNamespaceMappings, resolvePlexToLocal } from './pathNamespace.ts';
import type { PlexClient } from '../../integrations/plex/client.ts';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import type { ResolvedCleanupItem } from './cleanup.ts';

export interface ProtectedDeletionPath {
  path: string;
  directory?: boolean;
  /** Only for reconciliation after an accepted deletion; the root must still exist. */
  verifiedRoot?: string;
}

/** A veto only: discovering a path here never authorizes deletion of a torrent. */
export async function assertLocalDeletionPathsUnowned(
  paths: readonly ProtectedDeletionPath[],
  targets: readonly DownloadClientTarget[],
  selectedJobKeys: ReadonlySet<string> = new Set(),
): Promise<void> {
  if (targets.length === 0 || paths.length === 0) return;
  const resolver = await createLocalPathIdentityResolver();
  for (const target of targets) {
    if (paths.length === 0) continue;
    const discovery = await discoverMappedDownloadJobs(target, paths, resolver, true);
    for (const job of discovery.jobs) {
      if (job.filesTruncated || job.fileCount !== job.manifestFiles.length || job.fileCount < 1) {
        throw new Error(`${target.instanceName}: Could not verify an incomplete torrent manifest`);
      }
      let owned = false;
      for (const entry of paths) {
        if ((await localDownloadJobOwnedPaths(job, entry, target, resolver)).length > 0) {
          owned = true;
          break;
        }
      }
      if (owned && !selectedJobKeys.has(`${target.instanceKey}:${job.id}`)) {
        throw new Error(
          `Retained because ${target.instanceName} owns a path selected for deletion. Its torrent must be explicitly selected for verified cleanup before this path can be removed`,
        );
      }
    }
  }
}

export async function assertArrDeletionPathsUnowned(input: {
  serverId: number;
  paths: readonly ProtectedDeletionPath[];
  mappings: readonly ArrPathMapping[];
  targets?: readonly DownloadClientTarget[];
  selectedJobKeys?: ReadonlySet<string>;
}): Promise<void> {
  const targets = input.targets ?? await getDownloadClientTargets(input.serverId);
  if (targets.length === 0) return;
  const paths = input.paths.map((entry) => {
    const mapped = mapArrPath(entry.path, 'library', input.mappings);
    if (!mapped) {
      throw new Error(
        `Could not verify ownership of ${entry.path}. Verify the Sonarr library path mapping`,
      );
    }
    return { ...entry, path: mapped.path };
  });
  await assertLocalDeletionPathsUnowned(paths, targets, input.selectedJobKeys);
}

export async function assertPlexDeletionPathsUnowned(input: {
  serverId: number;
  libraryKey: string;
  paths: readonly string[];
  truncated?: boolean;
  targets?: readonly DownloadClientTarget[];
  selectedJobKeys?: ReadonlySet<string>;
  allowMissingPaths?: boolean;
}): Promise<void> {
  const targets = input.targets ?? await getDownloadClientTargets(input.serverId);
  if (targets.length === 0) return;
  if (input.truncated || input.paths.length === 0) {
    throw new Error('Could not verify all Plex deletion paths against qBittorrent');
  }
  const mappings = withTransaction((db) =>
    loadPlexNamespaceMappings(db, input.serverId, input.libraryKey)
  );
  const paths = input.paths.map((path) => {
    const mapped = resolvePlexToLocal(path, mappings);
    if (!mapped) {
      throw new Error(
        `Could not verify ownership of ${path}. Verify the Plex library path mapping in Settings → Media connections`,
      );
    }
    return {
      path: mapped.path,
      ...(input.allowMissingPaths ? { verifiedRoot: mapped.mapping.localPath } : {}),
    };
  });
  await assertLocalDeletionPathsUnowned(paths, targets, input.selectedJobKeys);
}

export async function assertPlexTargetUnowned(input: {
  serverId: number;
  libraryKey: string;
  ratingKey: string;
  type: string;
  mediaId?: number;
  client: PlexClient;
  allowMissingPaths?: boolean;
  /** Whole-movie Plex-only intent retains QB ownership without altering Radarr coordination. */
  protectPlexOnlyMovie?: boolean;
}): Promise<void> {
  if (
    !['show', 'season', 'episode'].includes(input.type) &&
    !(input.type === 'movie' && input.protectPlexOnlyMovie)
  ) return;
  const targets = await getDownloadClientTargets(input.serverId);
  if (targets.length === 0) return;
  let paths: string[];
  let truncated = false;
  if (input.mediaId !== undefined) {
    const versions = await input.client.mediaVersionPathPreviews(input.ratingKey);
    const selected = versions.find((version) => version.mediaId === input.mediaId);
    if (!selected) return; // Nothing remains for this exact version to delete.
    paths = selected.paths;
    truncated = selected.truncated;
  } else if (input.type === 'season') {
    const episodes = await input.client.seasonDeletionEpisodes(input.ratingKey);
    paths = episodes.flatMap((episode) =>
      episode.media.flatMap((media) => media.paths.map((part) => part.path))
    );
  } else {
    const preview = await input.client.mediaPathPreview(input.ratingKey, input.type);
    paths = preview.paths;
    truncated = preview.truncated;
  }
  await assertPlexDeletionPathsUnowned({ ...input, paths, truncated, targets });
}

export async function protectWholeSonarrCleanup(input: {
  serverId: number;
  libraryKey: string;
  cleanup: ResolvedCleanupItem;
  arrTargets: readonly ArrDeleteTarget[];
  downloadTargets: readonly DownloadClientTarget[];
  client: PlexClient;
  sonarrSelected?: boolean;
  itemType?: string;
}): Promise<ResolvedCleanupItem> {
  if (input.downloadTargets.length === 0 || input.cleanup.status === 'error') return input.cleanup;
  try {
    const selectedJobKeys = new Set(
      input.cleanup.downloadJobs.map((job) => `${job.instanceKey}:${job.jobId}`),
    );
    for (
      const record of input.cleanup.arrTargets.filter((entry) =>
        input.sonarrSelected !== false && entry.type === 'sonarr'
      )
    ) {
      const matches = input.arrTargets.filter((entry) =>
        entry.instanceName === record.instanceName && entry.instanceType === 'sonarr'
      );
      const target = matches.length === 1 ? matches[0] : undefined;
      if (!target || !record.path) {
        throw new Error('Could not unambiguously verify the Sonarr series path');
      }
      await assertArrDeletionPathsUnowned({
        serverId: input.serverId,
        paths: [{ path: record.path, directory: true }],
        mappings: target.pathMappings,
        targets: input.downloadTargets,
        selectedJobKeys,
      });
    }
    const plex = await input.client.mediaPathPreview(
      input.cleanup.ratingKey,
      input.itemType ?? 'show',
    );
    await assertPlexDeletionPathsUnowned({
      ...input,
      ...plex,
      targets: input.downloadTargets,
      selectedJobKeys,
    });
    return input.cleanup;
  } catch (error) {
    return {
      ...input.cleanup,
      status: 'error',
      reason: error instanceof Error ? error.message : 'Could not verify live path ownership',
    };
  }
}
