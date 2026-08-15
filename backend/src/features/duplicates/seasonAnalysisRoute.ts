import { Hono } from 'hono';
import { and, eq, inArray, not, sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { episodeMediaVersions, items } from '../../db/schema.ts';
import type { ActiveServerVariables } from '../../middleware/activeServer.ts';
import type {
  DuplicateEpisodeGroup,
  SeasonVersionAnalysisResponse,
} from '@plex-librarian/shared/types.ts';
import { analyzeSeasonVersionProfiles } from '@plex-librarian/shared/seasonVersionProfiles.ts';
import { episodeRootIsWorkflowOwned } from '../deletionOperations/core/ownership.ts';
import { mediaVersionFromRow } from './mediaVersion.ts';
import { enrichSeasonEpisodeEvidence, SMART_CLEANUP_DELETE_IDS_LIMIT } from './smartAnalysis.ts';
import { resolveActiveServer } from '../../integrations/plex/index.ts';
import { buildAuthoritativeSeasonPlan } from './seasonDeletionPlanner.ts';
import { parseSeasonDeletionRequest, SeasonCleanupRequestError } from './seasonCleanupRoute.ts';
import { getArrDeleteTargets } from '../arr/delete.ts';
import { getDownloadClientTargets } from '../mediaDeletion/targets.ts';
import { resolveDownloadCleanup } from '../mediaDeletion/cleanup.ts';
import { resolveArrPath } from '../mediaDeletion/arrPaths.ts';
import { normalizeRemoteAbsolute } from '../mediaDeletion/hardlinks.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
const MAX_EPISODES = 500;
const MAX_VERSIONS_PER_EPISODE = SMART_CLEANUP_DELETE_IDS_LIMIT + 1;

async function enrichDestinationAlignment(
  serverId: number,
  libraryKey: string,
  showRatingKey: string,
  seasonIndex: number,
  show: { title: string; tvdbId: number | null },
  profiles: SeasonVersionAnalysisResponse['profiles'],
  episodeIndexes: ReadonlyMap<string, number>,
): Promise<{
  profiles: SeasonVersionAnalysisResponse['profiles'];
  connections: { sonarr: boolean; qbittorrent: boolean };
}> {
  const [arrTargets, downloadTargets] = await Promise.all([
    getArrDeleteTargets(serverId, libraryKey).then((targets) =>
      targets.filter((target) => target.instanceType === 'sonarr')
    ),
    getDownloadClientTargets(serverId),
  ]);
  const connections = {
    sonarr: arrTargets.length > 0,
    qbittorrent: downloadTargets.length > 0,
  };
  if (profiles.length === 0 || (!connections.sonarr && !connections.qbittorrent)) {
    return {
      profiles: profiles.map((profile) => ({
        ...profile,
        sonarrManagedCount: 0,
        qbittorrentSeededCount: 0,
      })),
      connections,
    };
  }

  const managedMembers = new Set<string>();
  if (connections.sonarr && Number.isSafeInteger(show.tvdbId) && show.tvdbId! > 0) {
    for (const target of arrTargets) {
      try {
        const series = await target.client.lookup(show.tvdbId!);
        if (!series) continue;
        const snapshot = await target.client.sonarrSeriesSnapshot(series.id);
        for (const profile of profiles) {
          for (const member of profile.members) {
            if (!member.filePath) continue;
            const episodeIndex = episodeIndexes.get(member.episodeRatingKey);
            if (episodeIndex === undefined) continue;
            const episode = snapshot.episodes.find((entry) =>
              entry.seasonNumber === seasonIndex && entry.episodeNumber === episodeIndex
            );
            const file = episode?.episodeFileId
              ? snapshot.files.find((entry) => entry.id === episode.episodeFileId)
              : null;
            const arrPath = resolveArrPath(member.filePath, 'library', target.pathMappings);
            if (
              arrPath && file &&
              normalizeRemoteAbsolute(arrPath)?.comparison ===
                normalizeRemoteAbsolute(file.path)?.comparison
            ) {
              managedMembers.add(`${member.episodeRatingKey}:${member.mediaId}`);
            }
          }
        }
      } catch {
        // Destination hints are informational. Destructive preview revalidates them.
      }
    }
  }

  const cleanup = connections.sonarr && connections.qbittorrent
    ? await resolveDownloadCleanup(
      showRatingKey,
      { ...show, type: 'show', tmdbId: null },
      arrTargets,
      downloadTargets,
    ).catch(() => null)
    : null;
  const enriched = profiles.map((profile) => {
    const selectedJobIds = new Set(cleanup?.downloadJobs.map((job) => job.jobId) ?? []);
    const seededPaths = new Set(
      (cleanup?.sources ?? []).flatMap((source) => {
        if (!selectedJobIds.has(source.downloadId) || !source.importedPath) return [];
        const path = normalizeRemoteAbsolute(source.importedPath)?.comparison;
        return path ? [path] : [];
      }),
    );
    return {
      ...profile,
      sonarrManagedCount: profile.members.filter((member) =>
        managedMembers.has(`${member.episodeRatingKey}:${member.mediaId}`)
      ).length,
      qbittorrentSeededCount: profile.members.filter((member) => {
        const path = member.filePath ? normalizeRemoteAbsolute(member.filePath)?.comparison : null;
        return typeof path === 'string' && seededPaths.has(path);
      }).length,
    };
  });
  return { profiles: enriched, connections };
}

router.post('/seasons/:seasonRatingKey/analysis', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'season not found' }, 404);
  const seasonRatingKey = c.req.param('seasonRatingKey');
  // Membership and completeness are derived from the active server projection. The
  // old client-provided keys/count remain accepted as non-authoritative display context.
  const [first] = await db.select().from(episodeMediaVersions).where(and(
    eq(episodeMediaVersions.serverId, serverId),
    eq(episodeMediaVersions.seasonRatingKey, seasonRatingKey),
  )).limit(1);
  if (!first) return c.json({ error: 'season not found' }, 404);

  // Establish the bound before loading version rows or asking Plex for technical
  // metadata. This endpoint must remain safe for unusually large anime seasons.
  const eligibleEpisodes = await db.select({
    episodeRatingKey: episodeMediaVersions.episodeRatingKey,
  }).from(episodeMediaVersions).where(and(
    eq(episodeMediaVersions.serverId, serverId),
    eq(episodeMediaVersions.seasonRatingKey, seasonRatingKey),
    not(episodeRootIsWorkflowOwned(
      serverId,
      sql`${episodeMediaVersions.libraryKey}`,
      sql`${episodeMediaVersions.episodeRatingKey}`,
      sql`${episodeMediaVersions.showRatingKey}`,
    )),
  )).groupBy(episodeMediaVersions.episodeRatingKey).having(sql`count(*) >= 2`).limit(
    MAX_EPISODES + 1,
  );
  if (eligibleEpisodes.length > MAX_EPISODES) {
    return c.json({
      error:
        `this season exceeds the supported safety limit of ${MAX_EPISODES} eligible duplicate episodes and cannot be processed as one cleanup`,
    }, 409);
  }
  const episodeRatingKeys = eligibleEpisodes.map((row) => row.episodeRatingKey).sort();
  if (episodeRatingKeys.length === 0) {
    return c.json({ error: 'no eligible duplicate episodes remain in this season' }, 409);
  }

  const eligibleRows = await db.select().from(episodeMediaVersions).where(and(
    eq(episodeMediaVersions.serverId, serverId),
    eq(episodeMediaVersions.seasonRatingKey, seasonRatingKey),
    inArray(episodeMediaVersions.episodeRatingKey, episodeRatingKeys),
  )).limit(MAX_EPISODES * MAX_VERSIONS_PER_EPISODE + 1);
  if (eligibleRows.length > MAX_EPISODES * MAX_VERSIONS_PER_EPISODE) {
    return c.json({ error: 'the season exceeds the supported per-episode version limit' }, 409);
  }
  if (
    eligibleRows.some((row) =>
      row.libraryKey !== first.libraryKey || row.showRatingKey !== first.showRatingKey ||
      row.seasonRatingKey !== seasonRatingKey
    )
  ) {
    return c.json({ error: 'requested episodes must belong to one season' }, 409);
  }
  const rowsByEpisode = new Map<string, typeof eligibleRows>();
  for (const row of eligibleRows) {
    const rows = rowsByEpisode.get(row.episodeRatingKey) ?? [];
    rows.push(row);
    rowsByEpisode.set(row.episodeRatingKey, rows);
  }
  for (const [key, rows] of rowsByEpisode) {
    if (rows.length < 2) rowsByEpisode.delete(key);
    else if (rows.length > MAX_VERSIONS_PER_EPISODE) {
      return c.json({ error: 'an episode exceeds the supported media-version limit' }, 409);
    }
  }
  if (rowsByEpisode.size === 0) {
    return c.json({ error: 'no eligible duplicate episodes remain in this season' }, 409);
  }

  const liveEvidence = await enrichSeasonEpisodeEvidence(serverId, rowsByEpisode).catch(() =>
    new Map()
  );
  const [show] = await db.select({
    title: items.title,
    thumb: items.thumb,
    tvdbId: items.tvdbId,
  }).from(items).where(and(
    eq(items.serverId, serverId),
    eq(items.ratingKey, first.showRatingKey),
  ));
  const showTitle = show?.title ?? 'Unknown show';
  const episodes = episodeRatingKeys.flatMap((ratingKey): DuplicateEpisodeGroup[] => {
    const rows = rowsByEpisode.get(ratingKey) ?? [];
    if (rows.length < 2) return [];
    const row = rows[0]!;
    const sizes = rows.map((version) => version.fileSize);
    return [{
      mediaType: 'episode',
      libraryKey: row.libraryKey,
      episodeRatingKey: ratingKey,
      showRatingKey: row.showRatingKey,
      seasonRatingKey: row.seasonRatingKey,
      showTitle,
      showThumb: show?.thumb ?? null,
      seasonIndex: row.seasonIndex,
      episodeIndex: row.episodeIndex,
      episodeTitle: row.episodeTitle,
      combinedFileSize: sizes.every((size) => size !== null)
        ? sizes.reduce((total, size) => total + (size ?? 0), 0)
        : null,
      versions: rows.map(mediaVersionFromRow),
    }];
  });
  const pathHints = new Map(
    episodes.flatMap((episode) =>
      episode.versions.map((version) =>
        [
          `${episode.episodeRatingKey}:${version.mediaId}`,
          liveEvidence.get(episode.episodeRatingKey)?.get(version.mediaId)?.filePath ?? null,
        ] as const
      )
    ),
  );
  const analysis = analyzeSeasonVersionProfiles(episodes, pathHints);
  const destinationAlignment = await enrichDestinationAlignment(
    serverId,
    first.libraryKey,
    first.showRatingKey,
    first.seasonIndex,
    { title: showTitle, tvdbId: show?.tvdbId ?? null },
    analysis.profiles.map((profile) => ({
      ...profile,
      sonarrManagedCount: 0,
      qbittorrentSeededCount: 0,
    })),
    new Map(episodes.map((episode) => [episode.episodeRatingKey, episode.episodeIndex])),
  ).catch(() => ({
    profiles: analysis.profiles.map((profile) => ({
      ...profile,
      sonarrManagedCount: 0,
      qbittorrentSeededCount: 0,
    })),
    connections: { sonarr: false, qbittorrent: false },
  }));
  return c.json(
    {
      season: {
        libraryKey: first.libraryKey,
        showRatingKey: first.showRatingKey,
        seasonRatingKey,
        showTitle,
        seasonIndex: first.seasonIndex,
      },
      analyzedEpisodeCount: episodes.length,
      recommendedProfileId: analysis.recommendedProfileId,
      profiles: destinationAlignment.profiles,
      connections: destinationAlignment.connections,
      episodes,
      uncertainEpisodeRatingKeys: analysis.uncertainEpisodeRatingKeys,
    } satisfies SeasonVersionAnalysisResponse,
  );
});

router.post('/seasons/:seasonRatingKey/deletion-preview', async (c) => {
  try {
    const intent = parseSeasonDeletionRequest(
      c.req.param('seasonRatingKey'),
      await c.req.json().catch(() => null),
      false,
    );
    const active = await resolveActiveServer();
    const plan = await buildAuthoritativeSeasonPlan({
      serverId: active.serverId,
      machineIdentifier: await active.client.identity(),
      plexClient: active.client,
      seasonRatingKey: intent.seasonRatingKey,
      selections: intent.selections,
      inspectSonarr: true,
      coordinateSonarr: intent.coordinateSonarr,
      inspectDownloadCleanup: true,
      cleanupDownloads: intent.cleanupDownloads,
    });
    return c.json(plan.preview);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'could not build season deletion preview',
    }, error instanceof SeasonCleanupRequestError ? 400 : 409);
  }
});

export default router;
