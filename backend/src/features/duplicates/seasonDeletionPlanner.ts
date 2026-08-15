import { and, eq, inArray, not, sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { episodeMediaVersions, items, servers } from '../../db/schema.ts';
import type { PlexClient } from '../../integrations/plex/client.ts';
import type {
  PlexMediaTechnicalDetails,
  PlexMediaVersionPathPreview,
  PlexMetadataIdentity,
} from '../../integrations/plex/types.ts';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import { getArrDeleteTargets } from '../arr/delete.ts';
import { arrPathIsWithin, resolveArrPath } from '../mediaDeletion/arrPaths.ts';
import { normalizeRemoteAbsolute } from '../mediaDeletion/hardlinks.ts';
import { activeWholeItemRatingKeys } from '../mediaDeletion/activePlayback.ts';
import { episodeRootIsWorkflowOwned } from '../deletionOperations/core/ownership.ts';
import type {
  MediaVersion,
  SeasonDeletionMemberPreview,
  SeasonDeletionOutcome,
  SeasonDeletionPreviewResponse,
  SeasonDeletionSelection,
} from '@plex-librarian/shared/types.ts';
import { seasonDeletionPreviewExpiry } from './seasonDeletionFingerprint.ts';
import { SMART_CLEANUP_DELETE_IDS_LIMIT } from './smartAnalysis.ts';
import {
  type PersistedResolvedCleanupItem,
  persistResolvedCleanupIdentity,
  resolveDownloadCleanup,
} from '../mediaDeletion/cleanup.ts';
import { getDownloadClientTargets } from '../mediaDeletion/targets.ts';
import {
  type PersistedArrMappingIdentity,
  type PersistedArrOwnership,
  selectVersionDownloadCleanup,
} from '../mediaDeletion/versionPlanning.ts';
import type { NewDeletionTarget } from '../deletionOperations/service.ts';
import { mediaVersionFromRow } from './mediaVersion.ts';

const MAX_EPISODES = 500;
const PLEX_VALIDATION_CONCURRENCY = 4;
const MAX_VERSIONS_PER_EPISODE = SMART_CLEANUP_DELETE_IDS_LIMIT + 1;

export interface PlannedMediaEvidence {
  mediaId: number;
  path: string;
  arrPath: string;
  byteSize: number;
  logicalSize: number | null;
  version: MediaVersion;
}

export interface PlannedSeasonChild {
  schemaVersion: 1;
  episodeRatingKey: string;
  episodeTitle: string;
  selectedMedia: PlannedMediaEvidence[];
  retainedMedia: PlannedMediaEvidence[];
  sonarrEpisodeId: number;
  seasonNumber: number;
  episodeNumber: number;
  originalMonitored: boolean;
  intendedMonitored: boolean;
  episodeFileId: number | null;
  episodeFilePath: string | null;
  episodeFileSize: number | null;
  episodeFileOwners: number[];
  outcome: SeasonDeletionOutcome;
}

export interface PlannedManagedSeasonGroup {
  arrInstanceId: number;
  seriesId: number;
  seriesPath: string;
  configurationUpdatedAt: number;
  mappingIdentity: string;
  sonarrVersion: string;
  children: PlannedSeasonChild[];
}

export interface AuthoritativeSeasonPlan {
  serverId: number;
  machineIdentifier: string;
  serverUrl: string;
  libraryKey: string;
  showRatingKey: string;
  seasonRatingKey: string;
  showTitle: string;
  showTvdbId: number | null;
  coordinateSonarr: boolean;
  cleanupDownloads: boolean;
  selections: SeasonDeletionSelection[];
  plexOnlyChildren: Array<{
    episodeRatingKey: string;
    episodeTitle: string;
    selectedMedia: PlannedMediaEvidence[];
    retainedMedia: PlannedMediaEvidence[];
    seasonNumber: number;
    episodeNumber: number;
  }>;
  managedGroups: PlannedManagedSeasonGroup[];
  cleanupEligibleMedia: Array<{ episodeRatingKey: string; mediaId: number }>;
  targetEvidence: Array<{
    episodeRatingKey: string;
    mediaId: number;
    outcome: SeasonDeletionOutcome;
    arrMappingIdentities: PersistedArrMappingIdentity[];
    arrOwnerships: PersistedArrOwnership[];
  }>;
  cleanupPlans: Array<{
    episodeRatingKey: string;
    mediaId: number;
    cleanup: PersistedResolvedCleanupItem;
  }>;
  preview: SeasonDeletionPreviewResponse;
}

type PreparedTargetPlan = {
  target: ArrDeleteTarget;
  seriesId: number;
  seriesPath: string;
  version: string;
  snapshot: Awaited<ReturnType<ArrDeleteTarget['client']['sonarrSeriesSnapshot']>>;
};

type PreparedSeasonSelection =
  | {
    kind: 'plex_only';
    child: AuthoritativeSeasonPlan['plexOnlyChildren'][number];
    members: SeasonDeletionMemberPreview[];
    arrOwnerships: PersistedArrOwnership[];
  }
  | {
    kind: 'managed';
    selection: SeasonDeletionSelection;
    plan: PreparedTargetPlan;
    episode: PreparedTargetPlan['snapshot']['episodes'][number];
    file: PreparedTargetPlan['snapshot']['files'][number];
    selectedMedia: PlannedMediaEvidence[];
    retainedMedia: PlannedMediaEvidence[];
    retainedCandidate: PlannedMediaEvidence;
    seasonNumber: number;
    episodeNumber: number;
    arrOwnerships: PersistedArrOwnership[];
  };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map((
        [key, child],
      ) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')
    }}`;
  }
  return JSON.stringify(value);
}

async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function exactPath(version: PlexMediaVersionPathPreview, label: string): string {
  if (
    version.truncated || version.paths.length !== 1 || !normalizeRemoteAbsolute(version.paths[0]!)
  ) {
    throw new Error(`${label} Plex version is multipart, truncated, or has no exact absolute path`);
  }
  return version.paths[0]!;
}

function mediaEvidence(
  version: PlexMediaVersionPathPreview,
  row: typeof episodeMediaVersions.$inferSelect,
  liveIdentity: PlexMetadataIdentity['media'][number],
  liveTechnical: PlexMediaTechnicalDetails | undefined,
  target: ArrDeleteTarget | null,
  label: string,
): PlannedMediaEvidence {
  const path = exactPath(version, label);
  const byteSize = Number(version.fileSize);
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) {
    throw new Error(`${label} Plex version has no exact positive byte size`);
  }
  const arrPath = target ? resolveArrPath(path, 'library', target.pathMappings) : path;
  if (!arrPath) throw new Error(`${label} Plex path is not covered by one exact Sonarr mapping`);
  const synced = mediaVersionFromRow(row);
  const authoritativeVersion: MediaVersion = {
    ...synced,
    videoResolution: liveIdentity.videoResolution,
    width: liveTechnical?.width ?? null,
    height: liveIdentity.height,
    duration: liveTechnical?.duration ?? null,
    bitrate: liveIdentity.bitrate,
    videoCodec: liveIdentity.videoCodec,
    videoProfile: liveTechnical?.videoProfile ?? null,
    videoBitDepth: liveTechnical?.videoBitDepth ?? null,
    videoDynamicRange: liveTechnical?.videoDynamicRange ?? null,
    videoFrameRate: liveTechnical?.videoFrameRate ?? null,
    videoScanType: liveTechnical?.videoScanType ?? null,
    container: liveIdentity.container,
    audioCodec: liveTechnical?.audioCodec ?? null,
    audioChannels: liveTechnical?.audioChannels ?? null,
    audioProfile: liveTechnical?.audioProfile ?? null,
    audioStreams: liveTechnical?.audioStreams ?? [],
    subtitleStreams: liveTechnical?.subtitleStreams ?? [],
    streamDetailsAvailable: liveTechnical?.streamDetailsAvailable === true,
    fileSize: liveIdentity.fileSize,
  };
  return {
    mediaId: version.mediaId,
    path,
    arrPath,
    byteSize,
    logicalSize: row.fileSize,
    version: authoritativeVersion,
  };
}

export async function buildAuthoritativeSeasonPlan(input: {
  serverId: number;
  machineIdentifier: string;
  plexClient: PlexClient;
  seasonRatingKey: string;
  selections: readonly SeasonDeletionSelection[];
  inspectSonarr?: boolean;
  coordinateSonarr?: boolean;
  inspectDownloadCleanup?: boolean;
  cleanupDownloads?: boolean;
}): Promise<AuthoritativeSeasonPlan> {
  const [selectedServer] = await db.select({
    machineIdentifier: servers.machineIdentifier,
  }).from(servers).where(eq(servers.id, input.serverId)).limit(1);
  if (!selectedServer) throw new Error('the selected Plex server identity is unavailable');
  if (selectedServer.machineIdentifier !== input.machineIdentifier) {
    throw new Error('the live Plex machine identity does not match the selected server');
  }
  const eligibleEpisodes = await db.select({
    episodeRatingKey: episodeMediaVersions.episodeRatingKey,
  }).from(episodeMediaVersions).where(and(
    eq(episodeMediaVersions.serverId, input.serverId),
    eq(episodeMediaVersions.seasonRatingKey, input.seasonRatingKey),
    not(episodeRootIsWorkflowOwned(
      input.serverId,
      sql`${episodeMediaVersions.libraryKey}`,
      sql`${episodeMediaVersions.episodeRatingKey}`,
      sql`${episodeMediaVersions.showRatingKey}`,
    )),
  )).groupBy(episodeMediaVersions.episodeRatingKey).having(sql`count(*) >= 2`).limit(
    MAX_EPISODES + 1,
  );
  if (eligibleEpisodes.length === 0) {
    throw new Error('no eligible duplicate episodes remain in this season');
  }
  if (eligibleEpisodes.length > MAX_EPISODES) {
    throw new Error(
      `this season exceeds the supported safety limit of ${MAX_EPISODES} eligible duplicate episodes and cannot be processed as one cleanup`,
    );
  }
  const eligibleKeys = eligibleEpisodes.map((entry) => entry.episodeRatingKey);
  const rows = await db.select().from(episodeMediaVersions).where(and(
    eq(episodeMediaVersions.serverId, input.serverId),
    eq(episodeMediaVersions.seasonRatingKey, input.seasonRatingKey),
    inArray(episodeMediaVersions.episodeRatingKey, eligibleKeys),
    not(episodeRootIsWorkflowOwned(
      input.serverId,
      sql`${episodeMediaVersions.libraryKey}`,
      sql`${episodeMediaVersions.episodeRatingKey}`,
      sql`${episodeMediaVersions.showRatingKey}`,
    )),
  )).limit(MAX_EPISODES * MAX_VERSIONS_PER_EPISODE + 1);
  if (rows.length > MAX_EPISODES * MAX_VERSIONS_PER_EPISODE) {
    throw new Error('the season exceeds the supported per-episode version limit');
  }
  const byEpisode = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = byEpisode.get(row.episodeRatingKey) ?? [];
    group.push(row);
    byEpisode.set(row.episodeRatingKey, group);
  }
  for (const [key, group] of byEpisode) {
    if (group.length < 2) byEpisode.delete(key);
    else if (group.length > MAX_VERSIONS_PER_EPISODE) {
      throw new Error('an episode exceeds the supported media-version limit');
    }
  }
  if (byEpisode.size !== eligibleKeys.length) {
    throw new Error('season identity changed during planning');
  }
  const first = [...byEpisode.values()][0]![0]!;
  if (
    rows.some((row) =>
      row.libraryKey !== first.libraryKey || row.showRatingKey !== first.showRatingKey
    )
  ) {
    throw new Error('season identity is ambiguous');
  }
  const normalizedSelections = input.selections.map((selection) => ({
    episodeRatingKey: selection.episodeRatingKey,
    mediaIds: [...new Set(selection.mediaIds)].sort((a, b) => a - b),
  })).sort((a, b) => a.episodeRatingKey.localeCompare(b.episodeRatingKey));
  if (
    normalizedSelections.length === 0 || normalizedSelections.length > MAX_EPISODES ||
    new Set(normalizedSelections.map((entry) => entry.episodeRatingKey)).size !==
      normalizedSelections.length ||
    normalizedSelections.some((entry) => entry.mediaIds.length === 0)
  ) {
    throw new Error('season deletion selections are invalid');
  }
  const selectedEpisodeKeys = new Set(normalizedSelections.map((entry) => entry.episodeRatingKey));
  const activePlayback = activeWholeItemRatingKeys(
    selectedEpisodeKeys,
    await input.plexClient.activeSessions(),
  );
  if (activePlayback.size > 0) {
    throw new Error(
      `active playback blocks season cleanup for ${[...activePlayback].sort().join(', ')}`,
    );
  }
  const [show] = await db.select({
    ratingKey: items.ratingKey,
    title: items.title,
    type: items.type,
    tmdbId: items.tmdbId,
    tvdbId: items.tvdbId,
  }).from(items).where(
    and(
      eq(items.serverId, input.serverId),
      eq(items.ratingKey, first.showRatingKey),
    ),
  ).limit(1);
  if (!show) throw new Error('the Plex show identity is unavailable');
  const targets = (await getArrDeleteTargets(input.serverId, first.libraryKey)).filter((entry) =>
    entry.instanceType === 'sonarr'
  );
  const inspectedTargets = input.inspectSonarr === true || input.coordinateSonarr === true
    ? targets
    : [];
  if (
    inspectedTargets.length > 0 &&
    (!Number.isSafeInteger(show.tvdbId) || show.tvdbId! <= 0)
  ) {
    throw new Error('the Plex show has no exact TVDB identity for Sonarr inspection');
  }
  const arrMappingIdentities = inspectedTargets.map((target) => ({
    instanceId: target.instanceId,
    instanceType: target.instanceType,
    instanceUrl: target.instanceUrl,
    configurationUpdatedAt: target.configurationUpdatedAt,
    mappingIdentity: target.mappingIdentity,
  } satisfies PersistedArrMappingIdentity)).sort((left, right) =>
    left.instanceId - right.instanceId
  );
  const missingRecordOwnerships: PersistedArrOwnership[] = [];
  const targetPlans: PreparedTargetPlan[] = [];
  for (const target of inspectedTargets) {
    const capabilities = await target.client.sonarrSeasonCoordinationCapabilities();
    if (!capabilities.available || !capabilities.version) {
      throw new Error(capabilities.reason ?? 'Sonarr v4 coordination is unavailable');
    }
    const series = await target.client.lookup(show.tvdbId!);
    if (!series) {
      missingRecordOwnerships.push({
        instanceId: target.instanceId,
        recordId: null,
        episodeId: null,
        managedFileId: null,
        managedPath: null,
        managedMediaId: null,
      });
      continue;
    }
    if (!series.path) throw new Error('Sonarr series path is unavailable');
    const [snapshot, activity] = await Promise.all([
      target.client.sonarrSeriesSnapshot(series.id),
      target.client.sonarrSeriesActivity(series.id),
    ]);
    if (!activity.quiet) {
      throw new Error(
        `Sonarr has conflicting series activity: ${
          activity.blocking.map((entry) => entry.name).join(', ')
        }`,
      );
    }
    targetPlans.push({
      target,
      seriesId: series.id,
      seriesPath: series.path,
      version: capabilities.version,
      snapshot,
    });
  }
  const plexOnlyChildren: AuthoritativeSeasonPlan['plexOnlyChildren'] = [];
  const managedGroups = new Map<string, PlannedManagedSeasonGroup>();
  const members: SeasonDeletionMemberPreview[] = [];
  const preparedSelections = await mapWithConcurrency(
    normalizedSelections,
    PLEX_VALIDATION_CONCURRENCY,
    async (selection): Promise<PreparedSeasonSelection> => {
      const local = byEpisode.get(selection.episodeRatingKey);
      if (!local) throw new Error('a selected episode is not in the complete eligible season set');
      const ids = new Set(local.map((row) => row.mediaId));
      if (selection.mediaIds.some((id) => !ids.has(id)) || selection.mediaIds.length >= ids.size) {
        throw new Error('selected media identities changed or would remove every episode version');
      }
      const [identity, live, liveTechnical] = await Promise.all([
        input.plexClient.metadataIdentity(selection.episodeRatingKey),
        input.plexClient.mediaVersionPathPreviews(selection.episodeRatingKey),
        input.plexClient.mediaVersionTechnicalDetails(selection.episodeRatingKey),
      ]);
      if (
        !identity || identity.type !== 'episode' ||
        identity.librarySectionId !== first.libraryKey ||
        identity.parentRatingKey !== input.seasonRatingKey ||
        identity.grandparentRatingKey !== first.showRatingKey ||
        identity.seasonIndex !== first.seasonIndex || identity.index !== local[0]!.episodeIndex
      ) {
        throw new Error('live Plex episode ancestry no longer matches the accepted season');
      }
      const liveIds = new Set(live.map((entry) => entry.mediaId));
      if (liveIds.size !== ids.size || [...ids].some((id) => !liveIds.has(id))) {
        throw new Error(
          'live Plex media identities differ from the complete synced episode versions',
        );
      }
      const identityByMediaId = new Map(identity.media.map((entry) => [entry.mediaId, entry]));
      if (
        identityByMediaId.size !== ids.size || [...ids].some((id) => !identityByMediaId.has(id))
      ) {
        throw new Error('live Plex technical identities differ from the complete episode versions');
      }
      const alignedOwners: Array<{
        plan: typeof targetPlans[number];
        episode: typeof targetPlans[number]['snapshot']['episodes'][number];
        file: typeof targetPlans[number]['snapshot']['files'][number];
        mediaId: number;
      }> = [];
      const arrOwnerships = [...missingRecordOwnerships];
      for (const plan of targetPlans) {
        const episode = plan.snapshot.episodes.find((entry) =>
          entry.seasonNumber === first.seasonIndex && entry.episodeNumber === local[0]!.episodeIndex
        );
        if (!episode) {
          arrOwnerships.push({
            instanceId: plan.target.instanceId,
            recordId: plan.seriesId,
            episodeId: null,
            managedFileId: null,
            managedPath: null,
            managedMediaId: null,
          });
          continue;
        }
        if (episode.episodeFileId === 0) {
          arrOwnerships.push({
            instanceId: plan.target.instanceId,
            recordId: plan.seriesId,
            episodeId: episode.id,
            managedFileId: null,
            managedPath: null,
            managedMediaId: null,
          });
          continue;
        }
        const file = plan.snapshot.files.find((entry) => entry.id === episode.episodeFileId);
        if (!file) throw new Error('Sonarr episode references a missing EpisodeFile');
        const filePath = normalizeRemoteAbsolute(file.path)?.comparison;
        const matchingMediaIds = live.flatMap((version) => {
          const arrPath = resolveArrPath(
            exactPath(
              version,
              selection.mediaIds.includes(version.mediaId) ? 'selected' : 'retained',
            ),
            'library',
            plan.target.pathMappings,
          );
          return arrPath && normalizeRemoteAbsolute(arrPath)?.comparison === filePath
            ? [version.mediaId]
            : [];
        });
        if (matchingMediaIds.length !== 1) {
          throw new Error(
            matchingMediaIds.length === 0
              ? 'Sonarr EpisodeFile ownership could not be aligned to one Plex version'
              : 'Sonarr EpisodeFile path matches multiple Plex versions',
          );
        }
        arrOwnerships.push({
          instanceId: plan.target.instanceId,
          recordId: plan.seriesId,
          episodeId: episode.id,
          managedFileId: file.id,
          managedPath: file.path,
          managedMediaId: matchingMediaIds[0]!,
        });
        alignedOwners.push({ plan, episode, file, mediaId: matchingMediaIds[0]! });
      }
      if (alignedOwners.length > 1) {
        throw new Error('the selected episode is managed by multiple Sonarr instances');
      }
      const match = alignedOwners.find((owner) => selection.mediaIds.includes(owner.mediaId));
      if (!match) {
        const selectedMedia = selection.mediaIds.map((id) =>
          mediaEvidence(
            live.find((entry) => entry.mediaId === id)!,
            local.find((row) => row.mediaId === id)!,
            identityByMediaId.get(id)!,
            liveTechnical.get(id),
            null,
            'selected',
          )
        );
        const retainedMedia = local.filter((row) => !selection.mediaIds.includes(row.mediaId)).map((
          row,
        ) =>
          mediaEvidence(
            live.find((entry) => entry.mediaId === row.mediaId)!,
            row,
            identityByMediaId.get(row.mediaId)!,
            liveTechnical.get(row.mediaId),
            null,
            'retained',
          )
        );
        return {
          kind: 'plex_only',
          child: {
            episodeRatingKey: selection.episodeRatingKey,
            episodeTitle: local[0]!.episodeTitle,
            selectedMedia,
            retainedMedia,
            seasonNumber: first.seasonIndex,
            episodeNumber: local[0]!.episodeIndex,
          },
          members: selection.mediaIds.map((mediaId) => ({
            episodeRatingKey: selection.episodeRatingKey,
            selectedMediaIds: [mediaId],
            retainedMediaIds: retainedMedia.map((entry) => entry.mediaId),
            outcome: 'plex_only',
            sonarrInstanceId: null,
            reason: null,
          })),
          arrOwnerships,
        };
      }
      if (match.file.episodeIds.length !== 1 || match.file.episodeIds[0] !== match.episode.id) {
        throw new Error(
          'Sonarr manages a selected version but cannot safely adopt the version being kept because its EpisodeFile is shared across episodes',
        );
      }
      const selectedMedia = selection.mediaIds.map((id) =>
        mediaEvidence(
          live.find((entry) => entry.mediaId === id)!,
          local.find((row) => row.mediaId === id)!,
          identityByMediaId.get(id)!,
          liveTechnical.get(id),
          match.plan.target,
          'selected',
        )
      );
      const retainedMedia = local.filter((row) => !selection.mediaIds.includes(row.mediaId)).map((
        row,
      ) =>
        mediaEvidence(
          live.find((entry) => entry.mediaId === row.mediaId)!,
          row,
          identityByMediaId.get(row.mediaId)!,
          liveTechnical.get(row.mediaId),
          match.plan.target,
          'retained',
        )
      );
      const managedPath = normalizeRemoteAbsolute(match.file.path)?.comparison;
      if (
        !selectedMedia.some((entry) =>
          normalizeRemoteAbsolute(entry.arrPath)?.comparison === managedPath
        )
      ) {
        throw new Error('the selected Plex path does not exactly own the Sonarr EpisodeFile');
      }
      const adoptable = retainedMedia.filter((entry) =>
        arrPathIsWithin(entry.arrPath, match.plan.seriesPath)
      );
      if (adoptable.length !== 1 || retainedMedia.length !== 1) {
        if (input.coordinateSonarr !== true) {
          return {
            kind: 'plex_only',
            child: {
              episodeRatingKey: selection.episodeRatingKey,
              episodeTitle: local[0]!.episodeTitle,
              selectedMedia,
              retainedMedia,
              seasonNumber: first.seasonIndex,
              episodeNumber: local[0]!.episodeIndex,
            },
            members: selection.mediaIds.map((mediaId) => ({
              episodeRatingKey: selection.episodeRatingKey,
              selectedMediaIds: [mediaId],
              retainedMediaIds: retainedMedia.map((entry) => entry.mediaId),
              outcome: 'plex_only',
              sonarrInstanceId: null,
              reason: null,
            })),
            arrOwnerships,
          };
        }
        throw new Error(
          'Sonarr manages a selected version but cannot safely adopt one exact retained version inside the series folder',
        );
      }

      return {
        kind: 'managed',
        selection,
        plan: match.plan,
        episode: match.episode,
        file: match.file,
        selectedMedia,
        retainedMedia,
        retainedCandidate: adoptable[0]!,
        seasonNumber: first.seasonIndex,
        episodeNumber: local[0]!.episodeIndex,
        arrOwnerships,
      };
    },
  );

  const managedSelections = new Map<
    string,
    Extract<PreparedSeasonSelection, { kind: 'managed' }>[]
  >();
  for (const prepared of preparedSelections) {
    if (prepared.kind === 'plex_only') {
      plexOnlyChildren.push(prepared.child);
      members.push(...prepared.members);
      continue;
    }
    const key = `${prepared.plan.target.instanceId}:${prepared.plan.seriesId}`;
    const group = managedSelections.get(key) ?? [];
    group.push(prepared);
    managedSelections.set(key, group);
  }

  for (const [key, group] of managedSelections) {
    const firstPrepared = group[0]!;
    let preflight:
      | Awaited<
        ReturnType<typeof firstPrepared.plan.target.client.sonarrManualImportPreflight>
      >
      | null = null;
    try {
      preflight = await firstPrepared.plan.target.client.sonarrManualImportPreflight(
        group.map((prepared) => ({
          path: prepared.retainedCandidate.arrPath,
          seriesId: prepared.plan.seriesId,
          seasonNumber: prepared.seasonNumber,
          episodeIds: [prepared.episode.id],
        })),
      );
    } catch (error) {
      if (input.coordinateSonarr === true) throw error;
    }
    const managedGroup: PlannedManagedSeasonGroup = {
      arrInstanceId: firstPrepared.plan.target.instanceId,
      seriesId: firstPrepared.plan.seriesId,
      seriesPath: firstPrepared.plan.seriesPath,
      configurationUpdatedAt: firstPrepared.plan.target.configurationUpdatedAt,
      mappingIdentity: firstPrepared.plan.target.mappingIdentity,
      sonarrVersion: firstPrepared.plan.version,
      children: [],
    };
    for (let index = 0; index < group.length; index++) {
      const prepared = group[index]!;
      const result = preflight?.[index];
      if (
        !result || result.rejectionReasons.length > 0 || result.episodeIds.length !== 1 ||
        result.episodeIds[0] !== prepared.episode.id
      ) {
        if (input.coordinateSonarr !== true) {
          plexOnlyChildren.push({
            episodeRatingKey: prepared.selection.episodeRatingKey,
            episodeTitle: byEpisode.get(prepared.selection.episodeRatingKey)![0]!.episodeTitle,
            selectedMedia: prepared.selectedMedia,
            retainedMedia: prepared.retainedMedia,
            seasonNumber: prepared.seasonNumber,
            episodeNumber: prepared.episodeNumber,
          });
          members.push(...prepared.selection.mediaIds.map((mediaId) => ({
            episodeRatingKey: prepared.selection.episodeRatingKey,
            selectedMediaIds: [mediaId],
            retainedMediaIds: prepared.retainedMedia.map((entry) => entry.mediaId),
            outcome: 'plex_only' as const,
            sonarrInstanceId: null,
            reason: null,
          })));
          continue;
        }
        throw new Error(
          'Sonarr manages a selected version but could not safely identify the version being kept for this exact episode',
        );
      }
      const outcome: SeasonDeletionOutcome = input.coordinateSonarr === true
        ? 'automatic_adoption'
        : 'plex_only';
      managedGroup.children.push({
        schemaVersion: 1,
        episodeRatingKey: prepared.selection.episodeRatingKey,
        episodeTitle: byEpisode.get(prepared.selection.episodeRatingKey)![0]!.episodeTitle,
        selectedMedia: prepared.selectedMedia,
        retainedMedia: prepared.retainedMedia,
        sonarrEpisodeId: prepared.episode.id,
        seasonNumber: prepared.seasonNumber,
        episodeNumber: prepared.episodeNumber,
        originalMonitored: prepared.episode.monitored,
        intendedMonitored: prepared.episode.monitored,
        episodeFileId: prepared.file.id,
        episodeFilePath: prepared.file.path,
        episodeFileSize: prepared.file.size,
        episodeFileOwners: prepared.file.episodeIds,
        outcome,
      });
      const managedMediaId = prepared.arrOwnerships.find((entry) =>
        entry.instanceId === prepared.plan.target.instanceId
      )?.managedMediaId;
      members.push(...prepared.selection.mediaIds.map((mediaId) => {
        const memberOutcome: SeasonDeletionOutcome = input.coordinateSonarr === true &&
            mediaId === managedMediaId
          ? 'automatic_adoption'
          : 'plex_only';
        return {
          episodeRatingKey: prepared.selection.episodeRatingKey,
          selectedMediaIds: [mediaId],
          retainedMediaIds: prepared.retainedMedia.map((entry) => entry.mediaId),
          outcome: memberOutcome,
          sonarrInstanceId: memberOutcome === 'automatic_adoption'
            ? prepared.plan.target.instanceId
            : null,
          reason: null,
        };
      }));
    }
    if (managedGroup.children.length > 0) managedGroups.set(key, managedGroup);
  }
  const downloadTargets = await getDownloadClientTargets(input.serverId);
  const seriesCleanup = input.inspectDownloadCleanup === true
    ? await resolveDownloadCleanup(
      first.showRatingKey,
      { ...show, type: 'show' },
      targets,
      downloadTargets,
    )
    : null;
  const cleanupEligibleMedia: AuthoritativeSeasonPlan['cleanupEligibleMedia'] = [];
  const cleanupPlans: AuthoritativeSeasonPlan['cleanupPlans'] = [];
  if (seriesCleanup) {
    const selectedEntries = preparedSelections.flatMap((prepared) => {
      const episodeRatingKey = prepared.kind === 'plex_only'
        ? prepared.child.episodeRatingKey
        : prepared.selection.episodeRatingKey;
      const selectedMedia = prepared.kind === 'plex_only'
        ? prepared.child.selectedMedia
        : prepared.selectedMedia;
      return selectedMedia.flatMap((media) => {
        const path = normalizeRemoteAbsolute(media.path)?.comparison;
        return path ? [{ episodeRatingKey, media, path }] : [];
      });
    });
    const selectedCleanup = selectVersionDownloadCleanup(
      seriesCleanup,
      new Set(selectedEntries.map((entry) => entry.path)),
      true,
    );
    if (selectedCleanup) {
      const selectedJobIds = new Set(selectedCleanup.downloadJobs.map((job) => job.jobId));
      for (const entry of selectedEntries) {
        const sources = selectedCleanup.sources.filter((source) =>
          selectedJobIds.has(source.downloadId) && source.importedPath !== null &&
          normalizeRemoteAbsolute(source.importedPath)?.comparison === entry.path
        );
        const sourceJobIds = new Set(sources.map((source) => source.downloadId));
        const orphanFiles = selectedCleanup.orphanFiles.filter((file) =>
          normalizeRemoteAbsolute(file.importedPath)?.comparison === entry.path
        );
        if (sourceJobIds.size === 0 && orphanFiles.length === 0) continue;
        const scopedCleanup = {
          ...selectedCleanup,
          downloadJobs: selectedCleanup.downloadJobs.filter((job) => sourceJobIds.has(job.jobId)),
          sources,
          orphanFiles,
        };
        cleanupEligibleMedia.push({
          episodeRatingKey: entry.episodeRatingKey,
          mediaId: entry.media.mediaId,
        });
        cleanupPlans.push({
          episodeRatingKey: entry.episodeRatingKey,
          mediaId: entry.media.mediaId,
          cleanup: persistResolvedCleanupIdentity(scopedCleanup),
        });
      }
    }
  }
  const targetEvidence: AuthoritativeSeasonPlan['targetEvidence'] = preparedSelections.flatMap(
    (prepared) => {
      const episodeRatingKey = prepared.kind === 'plex_only'
        ? prepared.child.episodeRatingKey
        : prepared.selection.episodeRatingKey;
      const selectedMedia = prepared.kind === 'plex_only'
        ? prepared.child.selectedMedia
        : prepared.selectedMedia;
      const managedMediaId = prepared.kind === 'managed'
        ? prepared.arrOwnerships.find((entry) =>
          entry.instanceId === prepared.plan.target.instanceId
        )?.managedMediaId ?? null
        : null;
      return selectedMedia.map((media) => ({
        episodeRatingKey,
        mediaId: media.mediaId,
        outcome: input.coordinateSonarr === true && managedMediaId === media.mediaId
          ? 'automatic_adoption'
          : 'plex_only',
        arrMappingIdentities,
        arrOwnerships: [...prepared.arrOwnerships].sort((left, right) =>
          left.instanceId - right.instanceId
        ),
      }));
    },
  );
  const evidence = {
    serverId: input.serverId,
    machineIdentifier: input.machineIdentifier,
    serverUrl: input.plexClient.serverUrl,
    libraryKey: first.libraryKey,
    showRatingKey: first.showRatingKey,
    seasonRatingKey: input.seasonRatingKey,
    showTitle: show.title,
    showTvdbId: show.tvdbId,
    activePlaybackRatingKeys: [],
    selections: normalizedSelections,
    coordinateSonarr: input.coordinateSonarr === true,
    inspectDownloadCleanup: input.inspectDownloadCleanup === true,
    cleanupDownloads: input.cleanupDownloads === true,
    cleanupEligibleMedia,
    cleanupPlans,
    targetEvidence,
    plexOnlyChildren,
    managedGroups: [...managedGroups.values()].map((entry) => ({
      ...entry,
      children: [...entry.children].sort((a, b) =>
        a.episodeRatingKey.localeCompare(b.episodeRatingKey)
      ),
    })),
  };
  const planFingerprint = await fingerprint(evidence);
  const selectedVersionCount = normalizedSelections.reduce(
    (sum, entry) => sum + entry.mediaIds.length,
    0,
  );
  const preview: SeasonDeletionPreviewResponse = {
    seasonRatingKey: input.seasonRatingKey,
    completeEpisodeCount: byEpisode.size,
    selectedEpisodeCount: normalizedSelections.length,
    selectedVersionCount,
    plexOnlyCount: members.filter((entry) => entry.outcome === 'plex_only').length,
    automaticAdoptionCount:
      members.filter((entry) => entry.outcome === 'automatic_adoption').length,
    blockers: [],
    members,
    sonarrAvailable: managedGroups.size > 0,
    sonarrConfigured: targets.length > 0,
    cleanupConfigured: downloadTargets.length > 0,
    cleanupEligibleVersionCount: cleanupEligibleMedia.length,
    cleanupReason: seriesCleanup?.reason ?? null,
    fingerprint: planFingerprint,
    expiresAt: seasonDeletionPreviewExpiry(),
  };
  return { ...evidence, preview };
}

function technicalSnapshot(version: MediaVersion): Record<string, unknown> | undefined {
  if (!version.streamDetailsAvailable) return undefined;
  return {
    width: version.width,
    height: version.height,
    duration: version.duration,
    videoProfile: version.videoProfile,
    videoBitDepth: version.videoBitDepth,
    videoDynamicRange: version.videoDynamicRange,
    videoFrameRate: version.videoFrameRate,
    videoScanType: version.videoScanType,
    audioCodec: version.audioCodec,
    audioChannels: version.audioChannels,
    audioProfile: version.audioProfile,
    audioStreams: version.audioStreams,
    subtitleStreams: version.subtitleStreams,
    streamDetailsAvailable: version.streamDetailsAvailable,
  };
}

export function authoritativeSeasonTargets(plan: AuthoritativeSeasonPlan): NewDeletionTarget[] {
  const children = new Map<string, {
    episodeRatingKey: string;
    episodeTitle: string;
    selectedMedia: PlannedMediaEvidence[];
    retainedMedia: PlannedMediaEvidence[];
    seasonNumber: number;
    episodeNumber: number;
  }>();
  for (const child of plan.plexOnlyChildren) children.set(child.episodeRatingKey, child);
  for (const group of plan.managedGroups) {
    for (const child of group.children) children.set(child.episodeRatingKey, child);
  }
  const targets = plan.selections.flatMap((selection) => {
    const child = children.get(selection.episodeRatingKey);
    if (!child) throw new Error('authoritative season target evidence is incomplete');
    const operationMediaIds = child.selectedMedia.map((entry) => entry.mediaId).sort((a, b) =>
      a - b
    );
    const retained = [...child.retainedMedia].sort((a, b) => a.mediaId - b.mediaId);
    if (retained.length === 0) {
      throw new Error('authoritative retained-version evidence is incomplete');
    }
    return child.selectedMedia.map((selected) => {
      const accepted = plan.targetEvidence.find((entry) =>
        entry.episodeRatingKey === child.episodeRatingKey && entry.mediaId === selected.mediaId
      );
      if (!accepted) throw new Error('authoritative season coordination evidence is incomplete');
      const cleanup = plan.cleanupDownloads
        ? plan.cleanupPlans.find((entry) =>
          entry.episodeRatingKey === child.episodeRatingKey && entry.mediaId === selected.mediaId
        )
        : undefined;
      const selectedTechnical = technicalSnapshot(selected.version);
      const expectedRetainedVersions = retained.map((entry) => {
        const retainedTechnical = technicalSnapshot(entry.version);
        return {
          mediaId: entry.mediaId,
          plexPath: entry.path,
          fileSize: entry.version.fileSize,
          videoResolution: entry.version.videoResolution,
          height: entry.version.height,
          bitrate: entry.version.bitrate,
          videoCodec: entry.version.videoCodec,
          container: entry.version.container,
          ...(retainedTechnical ? { classificationTechnicalDetails: retainedTechnical } : {}),
        };
      });
      return {
        kind: 'episode_version' as const,
        key: `${child.episodeRatingKey}:${selected.mediaId}`,
        title: `${plan.showTitle} — ${child.episodeTitle}`,
        logicalSize: selected.logicalSize,
        snapshot: {
          machineIdentifier: plan.machineIdentifier,
          serverUrl: plan.serverUrl,
          libraryKey: plan.libraryKey,
          ratingKey: child.episodeRatingKey,
          mediaId: selected.mediaId,
          title: plan.showTitle,
          type: 'episode',
          tmdbId: null,
          tvdbId: plan.showTvdbId,
          fileSize: selected.version.fileSize,
          videoResolution: selected.version.videoResolution,
          height: selected.version.height,
          bitrate: selected.version.bitrate,
          videoCodec: selected.version.videoCodec,
          container: selected.version.container,
          showTitle: plan.showTitle,
          episodeTitle: child.episodeTitle,
          showRatingKey: plan.showRatingKey,
          seasonRatingKey: plan.seasonRatingKey,
          seasonIndex: child.seasonNumber,
          episodeIndex: child.episodeNumber,
          seasonCleanup: true,
          skipArrCoordination: !plan.coordinateSonarr,
          cleanupDownloads: cleanup !== undefined,
          expectedPlexPath: selected.path,
          selectedMediaIds: [selected.mediaId],
          operationMediaIds,
          ...(selectedTechnical ? { classificationTechnicalDetails: selectedTechnical } : {}),
          expectedRetainedVersion: expectedRetainedVersions[0],
          expectedRetainedVersions,
          ...(!plan.coordinateSonarr
            ? {
              seasonSonarrInspection: {
                mappings: accepted.arrMappingIdentities,
                managedSelectedMediaIds: accepted.arrOwnerships.some((ownership) =>
                    ownership.managedMediaId === selected.mediaId
                  )
                  ? [selected.mediaId]
                  : [],
              },
            }
            : {}),
          ...(plan.coordinateSonarr
            ? {
              seasonCoordinationOutcome: accepted.outcome,
              arrReassignmentMappings: accepted.arrMappingIdentities,
              arrOwnerships: accepted.arrOwnerships,
            }
            : {}),
          ...(cleanup ? { seasonDownloadCleanup: cleanup.cleanup } : {}),
        },
        reservation: {
          mediaKind: 'episode' as const,
          mediaId: selected.mediaId,
          ratingKey: child.episodeRatingKey,
        },
      };
    });
  });
  return targets.sort((left, right) =>
    Number(left.snapshot.episodeIndex) - Number(right.snapshot.episodeIndex) ||
    String(left.snapshot.ratingKey).localeCompare(String(right.snapshot.ratingKey)) ||
    Number(left.snapshot.seasonCoordinationOutcome === 'automatic_adoption') -
      Number(right.snapshot.seasonCoordinationOutcome === 'automatic_adoption') ||
    Number(left.snapshot.mediaId) - Number(right.snapshot.mediaId)
  );
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await map(values[index]!);
      }
    }),
  );
  return results;
}
