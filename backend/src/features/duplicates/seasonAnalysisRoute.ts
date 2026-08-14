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
import {
  seasonDeletionFingerprint,
  seasonDeletionPreviewExpiry,
} from './seasonDeletionFingerprint.ts';
import { createPlexClient } from '../../integrations/plex/index.ts';
import { buildAuthoritativeSeasonPlan } from './seasonDeletionPlanner.ts';

const router = new Hono<{ Variables: ActiveServerVariables }>();
const MAX_EPISODES = 500;
const MAX_VERSIONS_PER_EPISODE = SMART_CLEANUP_DELETE_IDS_LIMIT + 1;

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
  const [show] = await db.select({ title: items.title, thumb: items.thumb }).from(items).where(and(
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
  const analysisFingerprint = await seasonDeletionFingerprint(serverId, eligibleRows);
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
      omittedEpisodeCount: 0,
      recommendedProfileId: analysis.recommendedProfileId,
      profiles: analysis.profiles,
      episodes,
      uncertainEpisodeRatingKeys: analysis.uncertainEpisodeRatingKeys,
      analysisFingerprint,
      expiresAt: seasonDeletionPreviewExpiry(),
    } satisfies SeasonVersionAnalysisResponse,
  );
});

router.post('/seasons/:seasonRatingKey/deletion-preview', async (c) => {
  const serverId = c.get('activeServerId');
  if (serverId === null) return c.json({ error: 'season not found' }, 404);
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const selections = Array.isArray(body?.selections)
    ? body.selections.flatMap((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const value = raw as Record<string, unknown>;
      if (
        typeof value.episodeRatingKey !== 'string' || !Array.isArray(value.mediaIds) ||
        !value.mediaIds.every((id) => Number.isSafeInteger(id) && Number(id) >= 0)
      ) return [];
      return [{ episodeRatingKey: value.episodeRatingKey, mediaIds: value.mediaIds as number[] }];
    })
    : [];
  if (selections.length !== (Array.isArray(body?.selections) ? body.selections.length : -1)) {
    return c.json({ error: 'exact episode/media selections are required' }, 400);
  }
  try {
    const client = await createPlexClient();
    const machineIdentifier = await client.identity();
    const plan = await buildAuthoritativeSeasonPlan({
      serverId,
      machineIdentifier,
      plexClient: client,
      seasonRatingKey: c.req.param('seasonRatingKey'),
      selections,
    });
    return c.json(plan.preview);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'could not build season deletion preview',
    }, 409);
  }
});

export default router;
