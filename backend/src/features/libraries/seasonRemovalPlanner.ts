import {
  retainedPlexScopeErrors,
  type RetainedPlexScopeInput,
} from '../mediaDeletion/ordinaryScope.ts';
import {
  buildOrdinaryDeletionPlan,
  type OrdinaryDeletionPlan,
} from '../mediaDeletion/ordinaryPlanning.ts';
import { loadServiceRoots, serviceEndpoints } from '../mediaDeletion/serviceStorage.ts';
import { CURRENT_LOCATION_POLICY_VERSION } from '@plex-librarian/shared/deletionPolicy.ts';
import type { SeasonRemovalPreviewResponse } from '@plex-librarian/shared/types.ts';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { items, seasons } from '../../db/schema.ts';
import type { PlexClient } from '../../integrations/plex/client.ts';
import type { PlexSeasonDeletionEpisode } from '../../integrations/plex/types.ts';
import { getArrDeleteTargets } from '../arr/delete.ts';

import { normalizeRemoteAbsolute } from '../mediaDeletion/hardlinks.ts';

import { getDownloadClientTargets } from '../mediaDeletion/targets.ts';

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
  const [roots, connections] = await Promise.all([
    loadServiceRoots(input.serverId),
    serviceEndpoints(input.serverId),
  ]);
  const selection = {
    ratingKey: row.seasonRatingKey,
    title: row.seasonTitle,
    type: 'season' as const,
    tmdbId: null,
    tvdbId: row.tvdbId,
    showRatingKey: row.showRatingKey,
    seasonIndex: row.seasonIndex,
  };
  const base = {
    serverId: input.serverId,
    libraryKey: row.libraryKey,
    selection,
    plex: input.plexClient,
    arrTargets,
    downloadTargets,
    roots,
    connections,
    seasonEpisodes: episodes,
  };
  const retainedChecks: Array<{ plan: OrdinaryDeletionPlan; check: RetainedPlexScopeInput }> = [];
  async function prepare(options: Parameters<typeof buildOrdinaryDeletionPlan>[0]) {
    let check: RetainedPlexScopeInput | undefined;
    const plan = await buildOrdinaryDeletionPlan({
      ...options,
      retainedPlexCheck: (value) => {
        check = value;
        return Promise.resolve();
      },
    });
    if (!check) throw new Error('Retained Plex scope was not prepared');
    retainedChecks.push({ plan, check });
    return plan;
  }
  let ordinaryPlan: OrdinaryDeletionPlan | undefined;
  const blockers: string[] = [];
  try {
    ordinaryPlan = await prepare({
      ...base,
      arrSelected: input.coordinated,
      qbSelected: input.cleanupDownloads,
    });
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : 'Current service scope is unavailable');
  }
  let sonarrPlan = ordinaryPlan?.arrSelected ? ordinaryPlan : undefined;
  let downloadPlan = ordinaryPlan?.qbSelected ? ordinaryPlan : undefined;
  let sonarrReason: string | undefined, cleanupReason: string | undefined;
  if (!sonarrPlan) {
    try {
      sonarrPlan = await prepare({
        ...base,
        arrSelected: true,
        qbSelected: input.cleanupDownloads,
      });
    } catch (error) {
      sonarrReason = error instanceof Error ? error.message : 'Sonarr is unavailable';
    }
  }
  if (!downloadPlan) {
    try {
      downloadPlan = await prepare({
        ...base,
        arrSelected: input.coordinated,
        qbSelected: true,
      });
    } catch (error) {
      cleanupReason = error instanceof Error ? error.message : 'qBittorrent is unavailable';
    }
  }
  const retainedErrors = await retainedPlexScopeErrors(retainedChecks.map((entry) => entry.check));
  for (const [index, error] of retainedErrors.entries()) {
    if (error) {
      const rejected = retainedChecks[index].plan;
      if (ordinaryPlan === rejected) {
        ordinaryPlan = undefined;
        blockers.push(error);
      }
      if (sonarrPlan === rejected) {
        sonarrPlan = undefined;
        sonarrReason = error;
      }
      if (downloadPlan === rejected) {
        downloadPlan = undefined;
        cleanupReason = error;
      }
    }
  }
  const sonarrTargets: DurableWholeSeasonRemoval['sonarrTargets'] = (sonarrPlan?.arr ?? []).map(
    (scope) => ({
      instanceId: scope.instanceId,
      instanceName: scope.instanceName,
      instanceUrl: arrTargets.find((target) => target.instanceId === scope.instanceId)!.instanceUrl,
      configurationUpdatedAt: scope.configurationUpdatedAt,
      mappingIdentity: scope.mappingIdentity,
      seriesId: scope.recordId,
      seriesPath: scope.path,
      version: scope.version!,
      episodes: scope.episodes.map((episode) => ({
        episodeId: episode.id,
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
        originalMonitored: episode.monitored,
        episodeFileId: episode.episodeFileId,
      })),
      files: scope.files,
    }),
  );
  const durableSeason: DurableWholeSeasonRemoval = {
    episodeRatingKeys: episodes.map((episode) => episode.ratingKey).sort(),
    plexEpisodes: normalizeSeasonEpisodeEvidence(episodes),
    sonarrTargets: input.coordinated ? sonarrTargets : [],
  };
  const planFingerprint = ordinaryPlan?.fingerprint ?? await fingerprint({ selection, blockers });
  const monitoredEpisodeCount = sonarrTargets.reduce(
    (sum, target) => sum + target.episodes.filter((episode) => episode.originalMonitored).length,
    0,
  );
  const managedFileCount = sonarrTargets.reduce((sum, target) => sum + target.files.length, 0);
  return {
    logicalSize: row.fileSize,
    preview: {
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
      sonarrStatus: sonarrPlan ? 'resolved' : 'unavailable',
      sonarrReason,
      managedEpisodeCount: sonarrTargets.reduce((sum, target) => sum + target.episodes.length, 0),
      monitoredEpisodeCount,
      managedFileCount,
      sonarrActionAvailable: hasSeasonSonarrAction(
        !!sonarrPlan,
        monitoredEpisodeCount,
        managedFileCount,
      ),
      plexFiles: [...plexPaths.values()].map((file) => ({ path: file.path, size: file.byteSize })),
      sonarrFiles: sonarrTargets.flatMap((target) =>
        target.files.map((file) => ({
          instanceName: target.instanceName,
          path: file.path,
          size: file.size,
        }))
      ),
      cleanupConfigured: downloadTargets.length > 0,
      cleanupStatus: downloadPlan ? 'resolved' : 'unavailable',
      cleanupReason: cleanupReason ?? downloadPlan?.noJobReason,
      downloadJobs: downloadPlan?.jobs.map(({ job, instanceKey }) => ({
        ...job,
        provider: 'qbittorrent',
        instanceKey,
        instanceName: downloadTargets.find((target) =>
          target.instanceKey === instanceKey
        )!.instanceName,
        jobId: job.id,
        sourcePath: null,
      })) ?? [],
      sonarrHistoricalPaths: [],
      blockers,
    },
    snapshot: {
      currentLocationPolicyVersion: CURRENT_LOCATION_POLICY_VERSION,
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
      showTitle: row.showTitle,
      showRatingKey: row.showRatingKey,
      seasonRatingKey: row.seasonRatingKey,
      seasonIndex: row.seasonIndex,
      fileSize: row.fileSize,
      wholeSeasonDuration: row.duration,
      wholeSeasonRemoval: durableSeason,
      ordinaryPlan,
      planFingerprint,
    },
  };
}
