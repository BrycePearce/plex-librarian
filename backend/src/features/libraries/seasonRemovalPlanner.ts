import type {
  DownloadCleanupJob,
  SeasonRemovalPreviewResponse,
} from '@plex-librarian/shared/types.ts';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { items, seasons } from '../../db/schema.ts';
import type { PlexClient } from '../../integrations/plex/client.ts';
import type { PlexSeasonDeletionEpisode } from '../../integrations/plex/types.ts';
import { getArrDeleteTargets } from '../arr/delete.ts';
import { resolveArrPath } from '../mediaDeletion/arrPaths.ts';
import {
  type PersistedResolvedCleanupItem,
  persistResolvedCleanupIdentity,
} from '../mediaDeletion/cleanup.ts';
import { normalizeRemoteAbsolute } from '../mediaDeletion/hardlinks.ts';
import { resolveSeasonDownloadCleanup } from '../mediaDeletion/seasonDownloadCleanup.ts';
import { inspectSonarrSeason } from '../mediaDeletion/sonarrSeasonInspection.ts';
import { getDownloadClientTargets } from '../mediaDeletion/targets.ts';
import { selectVersionDownloadCleanup } from '../mediaDeletion/versionPlanning.ts';

export interface DurableWholeSeasonRemoval {
  episodeRatingKeys: string[];
  plexEpisodes: PlexSeasonDeletionEpisode[];
  sonarrTargets: Array<{
    instanceId: number;
    instanceName: string;
    instanceUrl: string;
    configurationUpdatedAt: number;
    mappingIdentity: string;
    seriesId: number;
    seriesPath: string;
    version: string;
    episodes: Array<{
      episodeId: number;
      seasonNumber: number;
      episodeNumber: number;
      originalMonitored: boolean;
      episodeFileId: number;
    }>;
    files: Array<{
      id: number;
      path: string;
      size: number;
      episodeIds: number[];
    }>;
  }>;
}

export function normalizeSeasonEpisodeEvidence(
  episodes: readonly PlexSeasonDeletionEpisode[],
): PlexSeasonDeletionEpisode[] {
  return episodes.map((episode) => ({
    ratingKey: episode.ratingKey,
    title: episode.title,
    showRatingKey: episode.showRatingKey,
    seasonRatingKey: episode.seasonRatingKey,
    seasonIndex: episode.seasonIndex,
    episodeIndex: episode.episodeIndex,
    media: episode.media.map((media) => ({
      mediaId: media.mediaId,
      paths: [...media.paths].sort((left, right) =>
        left.path.localeCompare(right.path) || left.byteSize - right.byteSize
      ),
    })).sort((left, right) => left.mediaId - right.mediaId),
  })).sort((left, right) =>
    left.episodeIndex - right.episodeIndex || left.ratingKey.localeCompare(right.ratingKey)
  );
}

export function canonicalSeasonEpisodeEvidence(
  episodes: readonly PlexSeasonDeletionEpisode[],
): string {
  return canonical(
    normalizeSeasonEpisodeEvidence(episodes).map((episode) => ({
      ratingKey: episode.ratingKey,
      showRatingKey: episode.showRatingKey,
      seasonRatingKey: episode.seasonRatingKey,
      seasonIndex: episode.seasonIndex,
      episodeIndex: episode.episodeIndex,
      media: episode.media,
    })),
  );
}

export function canonicalSeasonMembershipEvidence(
  episodes: readonly PlexSeasonDeletionEpisode[],
): string {
  return canonical(
    normalizeSeasonEpisodeEvidence(episodes).map((episode) => ({
      ratingKey: episode.ratingKey,
      showRatingKey: episode.showRatingKey,
      seasonRatingKey: episode.seasonRatingKey,
      seasonIndex: episode.seasonIndex,
      episodeIndex: episode.episodeIndex,
    })),
  );
}

export function seasonEpisodeEvidenceOnlyDisappeared(
  accepted: readonly PlexSeasonDeletionEpisode[],
  current: readonly PlexSeasonDeletionEpisode[],
): boolean {
  if (
    canonicalSeasonMembershipEvidence(accepted) !==
      canonicalSeasonMembershipEvidence(current)
  ) return false;
  const acceptedParts = new Set(
    accepted.flatMap((episode) =>
      episode.media.flatMap((media) =>
        media.paths.map((part) =>
          canonical({
            episodeRatingKey: episode.ratingKey,
            mediaId: media.mediaId,
            path: part.path,
            byteSize: part.byteSize,
          })
        )
      )
    ),
  );
  return current.every((episode) =>
    episode.media.every((media) =>
      media.paths.every((part) =>
        acceptedParts.has(canonical({
          episodeRatingKey: episode.ratingKey,
          mediaId: media.mediaId,
          path: part.path,
          byteSize: part.byteSize,
        }))
      )
    )
  );
}

export function sonarrSeasonCoverageContainsPlex(
  plexEpisodes: readonly PlexSeasonDeletionEpisode[],
  sonarrEpisodes: readonly { episodeNumber: number }[],
): boolean {
  const plexNumbers = plexEpisodes.map((episode) => episode.episodeIndex);
  const sonarrNumbers = sonarrEpisodes.map((episode) => episode.episodeNumber);
  if (
    new Set(plexNumbers).size !== plexNumbers.length ||
    new Set(sonarrNumbers).size !== sonarrNumbers.length
  ) return false;
  const sonarrNumberSet = new Set(sonarrNumbers);
  return plexNumbers.every((number) => sonarrNumberSet.has(number));
}

export function hasSeasonSonarrAction(
  resolved: boolean,
  monitoredEpisodeCount: number,
  managedFileCount: number,
): boolean {
  return resolved && (monitoredEpisodeCount > 0 || managedFileCount > 0);
}

export interface WholeSeasonRemovalPlan {
  preview: SeasonRemovalPreviewResponse;
  snapshot: Record<string, unknown>;
  logicalSize: number | null;
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

async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function publicDownloadJob(job: DownloadCleanupJob): DownloadCleanupJob {
  return {
    provider: job.provider,
    instanceKey: job.instanceKey,
    instanceName: job.instanceName,
    jobId: job.jobId,
    name: job.name,
    state: job.state,
    size: job.size,
    uploaded: job.uploaded,
    ratio: job.ratio,
    seedingTime: job.seedingTime,
    completedAt: job.completedAt,
    contentPath: job.contentPath,
    savePath: job.savePath,
    trackerHost: job.trackerHost,
    fileCount: job.fileCount,
    files: job.files,
    filesTruncated: job.filesTruncated,
    sourcePath: job.sourcePath,
  };
}

export function seasonPlexPathEvidence(
  episodes: readonly PlexSeasonDeletionEpisode[],
): Map<string, { path: string; byteSize: number }> {
  const paths = new Map<string, { path: string; byteSize: number }>();
  for (const episode of episodes) {
    for (const media of episode.media) {
      for (const part of media.paths) {
        const normalized = normalizeRemoteAbsolute(part.path)?.comparison;
        if (!normalized) throw new Error('Plex returned an invalid season media path');
        const existing = paths.get(normalized);
        // Plex legitimately repeats one Part for each logical episode in a multi-episode
        // file. Accept only identical evidence; conflicting spellings or sizes remain a
        // fail-closed identity error.
        if (existing && (existing.path !== part.path || existing.byteSize !== part.byteSize)) {
          throw new Error('Plex returned conflicting evidence for one season media path');
        }
        paths.set(normalized, { path: part.path, byteSize: part.byteSize });
      }
    }
  }
  return paths;
}

export async function buildWholeSeasonRemovalPlan(input: {
  serverId: number;
  machineIdentifier: string;
  plexClient: PlexClient;
  libraryKey: string;
  seasonRatingKey: string;
  coordinated: boolean;
  cleanupDownloads: boolean;
}): Promise<WholeSeasonRemovalPlan> {
  const [row] = await db.select({
    seasonRatingKey: seasons.ratingKey,
    seasonTitle: seasons.title,
    seasonIndex: seasons.seasonIndex,
    showRatingKey: seasons.showRatingKey,
    libraryKey: seasons.libraryKey,
    fileSize: seasons.fileSize,
    duration: seasons.duration,
    leafCount: seasons.leafCount,
    showTitle: items.title,
    tvdbId: items.tvdbId,
    tmdbId: items.tmdbId,
  }).from(seasons).innerJoin(
    items,
    and(eq(items.serverId, seasons.serverId), eq(items.ratingKey, seasons.showRatingKey)),
  ).where(and(
    eq(seasons.serverId, input.serverId),
    eq(seasons.libraryKey, input.libraryKey),
    eq(seasons.ratingKey, input.seasonRatingKey),
    eq(items.type, 'show'),
  )).limit(1);
  if (!row) throw new Error('season not found');

  const [liveSeason, liveShow, episodes, arrTargets, downloadTargets] = await Promise.all([
    input.plexClient.metadataIdentity(row.seasonRatingKey),
    input.plexClient.metadataIdentity(row.showRatingKey),
    input.plexClient.seasonDeletionEpisodes(row.seasonRatingKey),
    getArrDeleteTargets(input.serverId, row.libraryKey),
    getDownloadClientTargets(input.serverId),
  ]);
  if (
    !liveSeason || liveSeason.type !== 'season' || liveSeason.title !== row.seasonTitle ||
    liveSeason.parentRatingKey !== row.showRatingKey || liveSeason.index !== row.seasonIndex ||
    liveSeason.librarySectionId !== null && liveSeason.librarySectionId !== row.libraryKey
  ) throw new Error('Plex season identity no longer matches the synchronized season');
  if (
    !liveShow || liveShow.type !== 'show' || liveShow.title !== row.showTitle ||
    liveShow.tvdbId !== row.tvdbId
  ) throw new Error('Plex show identity no longer matches the synchronized show');
  if (
    episodes.length === 0 ||
    episodes.some((episode) =>
      episode.showRatingKey !== row.showRatingKey ||
      episode.seasonRatingKey !== row.seasonRatingKey || episode.seasonIndex !== row.seasonIndex
    )
  ) throw new Error('Plex season membership is empty or inconsistent');

  const plexPaths = seasonPlexPathEvidence(episodes);
  const inspection = await inspectSonarrSeason({
    targets: arrTargets.filter((target) => target.instanceType === 'sonarr'),
    tvdbId: row.tvdbId,
    inspect: true,
    mutationRequested: input.coordinated,
    fallbackWarning: 'Plex-only season deletion remains available.',
  });
  const blockers: string[] = [];
  const sonarrBlockers: string[] = [];
  if (inspection.targetPlans.length !== 1) {
    sonarrBlockers.push(
      inspection.targetPlans.length === 0
        ? 'No exact Sonarr series was found for this season.'
        : 'More than one Sonarr instance manages this series; season ownership is ambiguous.',
    );
  }

  const sonarrTargets: DurableWholeSeasonRemoval['sonarrTargets'] = [];
  for (const plan of inspection.targetPlans) {
    const selectedEpisodes = plan.snapshot.episodes.filter((episode) =>
      episode.seasonNumber === row.seasonIndex
    );
    if (selectedEpisodes.length === 0) {
      sonarrBlockers.push('Sonarr has no exact episodes for the selected season.');
    }
    if (!sonarrSeasonCoverageContainsPlex(episodes, selectedEpisodes)) {
      sonarrBlockers.push('Sonarr does not contain every episode in the selected Plex season.');
    }
    const selectedIds = new Set(selectedEpisodes.map((episode) => episode.id));
    const files = plan.snapshot.files.filter((file) =>
      file.episodeIds.some((id) => selectedIds.has(id))
    );
    if (
      files.some((file) => file.episodeIds.some((id) => !selectedIds.has(id)))
    ) {
      sonarrBlockers.push(
        'Sonarr reports an EpisodeFile shared with an episode outside this season.',
      );
    }
    for (const file of files) {
      const mapped = resolveArrPath(file.path, 'library', plan.target.pathMappings) ?? file.path;
      const normalized = normalizeRemoteAbsolute(mapped)?.comparison;
      if (!normalized || !plexPaths.has(normalized)) {
        sonarrBlockers.push(`Sonarr EpisodeFile is not an exact Plex season path: ${file.path}`);
      }
    }
    sonarrTargets.push({
      instanceId: plan.target.instanceId,
      instanceName: plan.target.instanceName,
      instanceUrl: plan.target.instanceUrl,
      configurationUpdatedAt: plan.target.configurationUpdatedAt,
      mappingIdentity: plan.target.mappingIdentity,
      seriesId: plan.seriesId,
      seriesPath: plan.seriesPath,
      version: plan.version,
      episodes: selectedEpisodes.map((episode) => ({
        episodeId: episode.id,
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
        originalMonitored: episode.monitored,
        episodeFileId: episode.episodeFileId,
      })),
      files: files.map((file) => ({
        id: file.id,
        path: file.path,
        size: file.size,
        episodeIds: [...file.episodeIds].sort((a, b) => a - b),
      })),
    });
  }

  const managedEpisodeCount = sonarrTargets.reduce(
    (total, target) => total + target.episodes.length,
    0,
  );
  const monitoredEpisodeCount = sonarrTargets.reduce(
    (total, target) =>
      total + target.episodes.filter((episode) => episode.originalMonitored).length,
    0,
  );
  const managedFileCount = sonarrTargets.reduce(
    (total, target) => total + target.files.length,
    0,
  );
  const sonarrResolved = sonarrTargets.length === 1 && sonarrBlockers.length === 0 &&
    inspection.warnings.length === 0;
  const sonarrActionAvailable = hasSeasonSonarrAction(
    sonarrResolved,
    monitoredEpisodeCount,
    managedFileCount,
  );
  if (input.coordinated) blockers.push(...sonarrBlockers);
  const selectedPaths = new Set(plexPaths.keys());
  const rawCleanup = await resolveSeasonDownloadCleanup({
    serverId: input.serverId,
    libraryKey: row.libraryKey,
    showRatingKey: row.showRatingKey,
    show: { title: row.showTitle, type: 'show', tmdbId: row.tmdbId, tvdbId: row.tvdbId },
    arrTargets,
    downloadTargets,
    selected: [...plexPaths.values()].map((part) => ({
      plexPath: part.path,
      size: part.byteSize,
    })),
    retained: [],
    // Discovery is read-only and powers the preview. The accepted durable plan below
    // still includes cleanup evidence only when the user explicitly opts in.
    inspect: true,
  });
  const availableCleanup = selectVersionDownloadCleanup(rawCleanup, selectedPaths, false);
  const cleanup = input.cleanupDownloads ? availableCleanup : null;
  if (input.cleanupDownloads && !cleanup) {
    blockers.push(rawCleanup?.reason ?? 'No exact qBittorrent cleanup owns every selected path.');
  }
  const persistedCleanup: PersistedResolvedCleanupItem | undefined = cleanup
    ? persistResolvedCleanupIdentity(cleanup)
    : undefined;
  const durableSeason: DurableWholeSeasonRemoval = {
    episodeRatingKeys: episodes.map((episode) => episode.ratingKey).sort(),
    plexEpisodes: normalizeSeasonEpisodeEvidence(episodes),
    sonarrTargets: input.coordinated ? sonarrTargets : [],
  };
  const accepted = {
    libraryKey: row.libraryKey,
    seasonRatingKey: row.seasonRatingKey,
    showRatingKey: row.showRatingKey,
    seasonIndex: row.seasonIndex,
    coordinated: input.coordinated,
    cleanupDownloads: input.cleanupDownloads,
    wholeSeasonRemoval: durableSeason,
    seasonDownloadCleanup: persistedCleanup,
  };
  const planFingerprint = await fingerprint(accepted);
  const cleanupStatus = availableCleanup
    ? 'resolved' as const
    : rawCleanup?.status === 'error'
    ? 'error' as const
    : 'unavailable' as const;
  const preview: SeasonRemovalPreviewResponse = {
    fingerprint: planFingerprint,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    libraryKey: row.libraryKey,
    seasonRatingKey: row.seasonRatingKey,
    showRatingKey: row.showRatingKey,
    showTitle: row.showTitle,
    seasonTitle: row.seasonTitle,
    seasonIndex: row.seasonIndex,
    episodeCount: episodes.length,
    fileSize: row.fileSize,
    coordinatedConfigured: arrTargets.some((target) => target.instanceType === 'sonarr'),
    sonarrStatus: sonarrResolved
      ? 'resolved'
      : inspection.warnings.length > 0
      ? 'error'
      : 'unavailable',
    ...(inspection.warnings.length > 0 ? { sonarrReason: inspection.warnings.join(' ') } : {}),
    managedEpisodeCount,
    monitoredEpisodeCount,
    managedFileCount,
    sonarrActionAvailable,
    plexFiles: [...plexPaths.values()].map((file) => ({
      path: file.path,
      size: file.byteSize,
    })).sort((left, right) => left.path.localeCompare(right.path)),
    sonarrFiles: sonarrTargets.flatMap((target) =>
      target.files.map((file) => ({
        instanceName: target.instanceName,
        path: file.path,
        size: file.size,
      }))
    ).sort((left, right) =>
      left.instanceName.localeCompare(right.instanceName) || left.path.localeCompare(right.path)
    ),
    cleanupConfigured: downloadTargets.length > 0,
    cleanupStatus,
    ...(!availableCleanup && rawCleanup?.reason ? { cleanupReason: rawCleanup.reason } : {}),
    downloadJobs: availableCleanup?.downloadJobs.map(publicDownloadJob) ?? [],
    blockers,
  };
  return {
    preview,
    logicalSize: row.fileSize,
    snapshot: {
      machineIdentifier: input.machineIdentifier,
      serverUrl: input.plexClient.serverUrl,
      libraryKey: row.libraryKey,
      ratingKey: row.seasonRatingKey,
      title: row.seasonTitle,
      type: 'season',
      tmdbId: null,
      tvdbId: row.tvdbId,
      mode: input.coordinated ? 'coordinated' : 'plex-only',
      cleanupDownloads: input.cleanupDownloads,
      seasonCleanup: true,
      seasonDownloadCleanup: persistedCleanup,
      showTitle: row.showTitle,
      showRatingKey: row.showRatingKey,
      seasonRatingKey: row.seasonRatingKey,
      seasonIndex: row.seasonIndex,
      fileSize: row.fileSize,
      wholeSeasonDuration: row.duration,
      wholeSeasonRemoval: durableSeason,
      planFingerprint,
    },
  };
}
