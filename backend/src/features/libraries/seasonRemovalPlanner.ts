import type { PlexSeasonDeletionEpisode } from '../../integrations/plex/types.ts';

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
