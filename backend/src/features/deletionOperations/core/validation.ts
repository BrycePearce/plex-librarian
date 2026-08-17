import { withTransaction } from '../../../db/index.ts';
import { resolveActiveServer } from '../../../integrations/plex/index.ts';
import type { PlexClient } from '../../../integrations/plex/client.ts';
import type {
  PlexMediaStreamSummary,
  PlexMediaTechnicalDetails,
  PlexMetadataIdentity,
} from '../../../integrations/plex/types.ts';
import type {
  PersistedArrMappingIdentity,
  PersistedArrOwnership,
  PersistedArrReassignment,
  PersistedRadarrRemovalFallback,
} from '../../mediaDeletion/arrReassignmentPlanning/types.ts';
import type { PersistedResolvedCleanupItem } from '../../mediaDeletion/cleanup.ts';
import { isStaleQuickCleanupCandidate } from '../../libraries/quickCleanup.ts';
import type { RelocationGuidance, RelocationSyncBarrier } from '../relocation/relocationModel.ts';

export interface DurableTargetRecord {
  id: number;
  targetKind: 'whole_item' | 'movie_version' | 'episode_version';
  snapshot: string;
}

export type DurableVersionTechnicalSnapshot = PlexMediaTechnicalDetails;

export interface DurableRetainedVersionSnapshot {
  mediaId: number;
  plexPath?: string;
  fileSize: number | null;
  videoResolution: string | null;
  height: number | null;
  bitrate: number | null;
  videoCodec: string | null;
  container: string | null;
  classificationTechnicalDetails?: DurableVersionTechnicalSnapshot;
}

export interface DurableTargetSnapshot {
  machineIdentifier: string;
  serverUrl: string;
  libraryKey: string;
  ratingKey: string;
  title: string;
  type: string;
  tmdbId: number | null;
  tvdbId: number | null;
  mode?: 'coordinated' | 'plex-only';
  cleanupDownloads?: boolean;
  skipArrCoordination?: boolean;
  seasonCleanup?: boolean;
  seasonCoordinationOutcome?: 'plex_only' | 'automatic_adoption' | 'removed_and_unmonitored';
  seasonSonarrInspection?: {
    mappings: PersistedArrMappingIdentity[];
    inspectedInstanceIds?: number[];
    managedSelectedMediaIds: number[];
  };
  seasonDownloadCleanup?: PersistedResolvedCleanupItem;
  seasonSelectedCandidateMediaId?: number;
  seasonSafeCandidateMediaIds?: number[];
  seasonSonarrVersion?: string;
  seasonPreDeletionPreflight?:
    import('../../../integrations/arr/client.ts').SonarrManualImportCandidate;
  seasonBreakGlass?: {
    instanceId: number;
    seriesId: number;
    episodeId: number;
    episodeFileId: number;
    episodeFilePath: string;
    episodeFileSize: number;
    originalMonitored: boolean;
    monitoringProtectedAt?: number;
    fileRemovalAttemptedAt?: number;
    fileRemovalConfirmedAt?: number;
    recoveryAcceptedAt?: number;
  };
  selectedRatingKeys?: string[];
  selectedMediaIds?: number[];
  operationMediaIds?: number[];
  classificationTechnicalDetails?: DurableVersionTechnicalSnapshot;
  expectedPlexPath?: string;
  expectedRetainedVersion?: DurableRetainedVersionSnapshot;
  expectedRetainedVersions?: DurableRetainedVersionSnapshot[];
  mediaId?: number;
  fileSize?: number | null;
  videoResolution?: string | null;
  height?: number | null;
  bitrate?: number | null;
  videoCodec?: string | null;
  container?: string | null;
  showTitle?: string | null;
  episodeTitle?: string | null;
  showRatingKey?: string | null;
  seasonRatingKey?: string | null;
  seasonIndex?: number | null;
  episodeIndex?: number | null;
  arrReassignmentMappings?: PersistedArrMappingIdentity[];
  arrOwnerships?: PersistedArrOwnership[];
  arrReassignments?: PersistedArrReassignment[];
  radarrRemovalFallback?: PersistedRadarrRemovalFallback;
  radarrRemovalDownloadCleanup?: PersistedResolvedCleanupItem;
  resolutionState?: 'management_hold';
  relocationGuidance?: RelocationGuidance | unknown;
  relocationSyncBarrier?: RelocationSyncBarrier | unknown;
  unmonitorFromArr?: boolean;
  quickCleanupEvidence?: {
    thresholdDays: number;
    reason: 'never-watched' | 'long-dormant';
    lastViewedAt: number | null;
    addedAt: number | null;
  };
}

export class DeletionValidationError extends Error {}

function mismatch(label: string): never {
  throw new DeletionValidationError(`${label} changed after deletion was accepted`);
}

function equalNullable(expected: unknown, actual: unknown, label: string): void {
  if (expected !== null && expected !== undefined && expected !== actual) mismatch(label);
}

export function validateArrMonitoringEvidence(snapshot: DurableTargetSnapshot): void {
  if (
    snapshot.seasonCleanup === true && snapshot.skipArrCoordination === true &&
    snapshot.seasonSonarrInspection === undefined
  ) {
    throw new DeletionValidationError('durable Sonarr inspection guard is missing');
  }
  if (snapshot.seasonSonarrInspection !== undefined) {
    const inspection = snapshot.seasonSonarrInspection;
    const mappingInstanceIds = new Set(
      Array.isArray(inspection.mappings)
        ? inspection.mappings.map((mapping) => mapping?.instanceId)
        : [],
    );
    const inspectedInstanceIds = inspection.inspectedInstanceIds ?? [];
    if (
      snapshot.seasonCleanup !== true || snapshot.skipArrCoordination !== true ||
      !inspection || typeof inspection !== 'object' ||
      !Array.isArray(inspection.mappings) ||
      (inspection.inspectedInstanceIds !== undefined &&
        (!Array.isArray(inspection.inspectedInstanceIds) ||
          inspection.inspectedInstanceIds.some((id) => !Number.isSafeInteger(id) || id <= 0))) ||
      new Set(inspectedInstanceIds).size !== inspectedInstanceIds.length ||
      inspectedInstanceIds.some((id) => !mappingInstanceIds.has(id)) ||
      !Array.isArray(inspection.managedSelectedMediaIds) ||
      inspection.managedSelectedMediaIds.some((mediaId) => !Number.isSafeInteger(mediaId)) ||
      snapshot.arrReassignmentMappings !== undefined || snapshot.arrOwnerships !== undefined ||
      snapshot.seasonCoordinationOutcome !== undefined ||
      inspection.mappings.some((entry) =>
        !entry || entry.instanceType !== 'sonarr' ||
        !Number.isSafeInteger(entry.instanceId) || entry.instanceId <= 0 ||
        typeof entry.instanceUrl !== 'string' || !entry.instanceUrl ||
        !Number.isSafeInteger(entry.configurationUpdatedAt) ||
        typeof entry.mappingIdentity !== 'string' || !entry.mappingIdentity
      )
    ) {
      throw new DeletionValidationError('durable Sonarr inspection guard is malformed');
    }
  }
  if (snapshot.seasonCoordinationOutcome !== undefined) {
    if (
      !['plex_only', 'automatic_adoption', 'removed_and_unmonitored'].includes(
        snapshot.seasonCoordinationOutcome,
      ) ||
      snapshot.seasonCleanup !== true || snapshot.skipArrCoordination === true ||
      (snapshot.seasonCoordinationOutcome !== 'plex_only' &&
        (typeof snapshot.seasonSonarrVersion !== 'string' || !snapshot.seasonSonarrVersion)) ||
      !Array.isArray(snapshot.arrReassignmentMappings) || !Array.isArray(snapshot.arrOwnerships)
    ) {
      throw new DeletionValidationError('durable season coordination evidence is malformed');
    }
    if (
      snapshot.seasonCoordinationOutcome === 'automatic_adoption' &&
      (!Number.isSafeInteger(snapshot.seasonSelectedCandidateMediaId) ||
        !Array.isArray(snapshot.seasonSafeCandidateMediaIds) ||
        snapshot.seasonSafeCandidateMediaIds.length === 0 ||
        snapshot.seasonSafeCandidateMediaIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
        !snapshot.seasonSafeCandidateMediaIds.includes(snapshot.seasonSelectedCandidateMediaId!) ||
        !snapshot.seasonPreDeletionPreflight ||
        typeof snapshot.seasonPreDeletionPreflight.path !== 'string' ||
        !Number.isSafeInteger(snapshot.seasonPreDeletionPreflight.size) ||
        snapshot.seasonPreDeletionPreflight.size <= 0 ||
        !Number.isSafeInteger(snapshot.seasonPreDeletionPreflight.seriesId) ||
        snapshot.seasonPreDeletionPreflight.seriesId <= 0 ||
        snapshot.seasonPreDeletionPreflight.seasonNumber !== snapshot.seasonIndex ||
        !Array.isArray(snapshot.seasonPreDeletionPreflight.episodeIds) ||
        snapshot.seasonPreDeletionPreflight.episodeIds.length !== 1 ||
        snapshot.seasonPreDeletionPreflight.episodeIds.some((id) =>
          !Number.isSafeInteger(id) || id <= 0
        ) || !Array.isArray(snapshot.seasonPreDeletionPreflight.rejectionReasons) ||
        snapshot.seasonPreDeletionPreflight.rejectionReasons.length > 0)
    ) {
      throw new DeletionValidationError('durable Sonarr adoption allowlist is malformed');
    }
    const breakGlass = snapshot.seasonBreakGlass;
    if (
      snapshot.seasonCoordinationOutcome === 'removed_and_unmonitored' &&
      (!breakGlass ||
        [
          breakGlass.instanceId,
          breakGlass.seriesId,
          breakGlass.episodeId,
          breakGlass.episodeFileId,
          breakGlass.episodeFileSize,
        ].some((value) => !Number.isSafeInteger(value) || value <= 0) ||
        typeof breakGlass.episodeFilePath !== 'string' || !breakGlass.episodeFilePath ||
        typeof breakGlass.originalMonitored !== 'boolean' ||
        [
          breakGlass.monitoringProtectedAt,
          breakGlass.fileRemovalAttemptedAt,
          breakGlass.fileRemovalConfirmedAt,
          breakGlass.recoveryAcceptedAt,
        ].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value <= 0)))
    ) {
      throw new DeletionValidationError('durable Sonarr break-glass evidence is malformed');
    }
  }
  if (snapshot.seasonDownloadCleanup !== undefined) {
    if (
      !snapshot.seasonDownloadCleanup || typeof snapshot.seasonDownloadCleanup !== 'object' ||
      snapshot.seasonCleanup !== true || snapshot.cleanupDownloads !== true ||
      snapshot.seasonDownloadCleanup.status !== 'resolved' ||
      snapshot.seasonDownloadCleanup.ratingKey !== snapshot.showRatingKey
    ) {
      throw new DeletionValidationError('durable season download cleanup evidence is malformed');
    }
  } else if (snapshot.seasonCleanup === true && snapshot.cleanupDownloads === true) {
    throw new DeletionValidationError('durable season download cleanup evidence is missing');
  }
  const removal = snapshot.radarrRemovalFallback;
  if (removal !== undefined) {
    if (
      !removal || removal.mode !== 'remove_from_radarr' ||
      !Number.isSafeInteger(removal.arrInstanceId) || removal.arrInstanceId <= 0 ||
      !Number.isSafeInteger(removal.arrConfigurationUpdatedAt) ||
      typeof removal.arrMappingIdentity !== 'string' || !removal.arrMappingIdentity ||
      !Number.isSafeInteger(removal.movieId) || removal.movieId <= 0 ||
      !Number.isSafeInteger(removal.tmdbId) || removal.tmdbId <= 0 ||
      removal.tmdbId !== snapshot.tmdbId ||
      !Number.isSafeInteger(removal.selectedMediaId) ||
      removal.selectedMediaId !== snapshot.mediaId ||
      !Number.isSafeInteger(removal.retainedMediaId) ||
      removal.retainedMediaId === removal.selectedMediaId ||
      typeof removal.movieTitle !== 'string' || !removal.movieTitle ||
      !Number.isSafeInteger(removal.movieYear) || removal.movieYear <= 0 ||
      typeof removal.selectedPlexPath !== 'string' || !removal.selectedPlexPath ||
      typeof removal.managedPath !== 'string' || !removal.managedPath ||
      typeof removal.retainedPlexPath !== 'string' || !removal.retainedPlexPath ||
      !Number.isSafeInteger(removal.retainedFileSize) || removal.retainedFileSize <= 0 ||
      typeof removal.originalMoviePath !== 'string' || !removal.originalMoviePath ||
      typeof removal.originalMonitored !== 'boolean' ||
      removal.createImportExclusion !== true || removal.deleteFiles !== false ||
      removal.addImportExclusion !== true || removal.userAuthorizedRadarrRemoval !== true ||
      typeof removal.planFingerprint !== 'string' || !removal.planFingerprint
    ) throw new DeletionValidationError('durable Radarr movie-removal evidence is malformed');
    const mapping = snapshot.arrReassignmentMappings?.find(
      (entry) => entry.instanceId === removal.arrInstanceId,
    );
    if (
      !mapping || mapping.configurationUpdatedAt !== removal.arrConfigurationUpdatedAt ||
      mapping.mappingIdentity !== removal.arrMappingIdentity
    ) {
      throw new DeletionValidationError(
        'durable Radarr movie-removal mapping identity is inconsistent',
      );
    }
  }
  if (snapshot.arrReassignments === undefined) return;
  if (!Array.isArray(snapshot.arrReassignments)) {
    throw new DeletionValidationError('durable Arr reassignment evidence is malformed');
  }
  for (const entry of snapshot.arrReassignments) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DeletionValidationError('durable Arr reassignment evidence is malformed');
    }
    if (Object.hasOwn(entry, 'originalMonitored') && typeof entry.originalMonitored !== 'boolean') {
      throw new DeletionValidationError('durable Arr monitoring evidence is malformed');
    }
    const sonarrTransition = entry.sonarrTransition;
    const selectedSonarrCandidate = sonarrTransition?.candidateAllowlist.find((candidate) =>
      candidate.mediaId === entry.retainedMediaId
    );
    const preDeletionPreflight = sonarrTransition?.preDeletionPreflight;
    const rescanAuthorizedChanges = sonarrTransition?.rescanAuthorizedChanges;
    if (
      sonarrTransition !== undefined &&
      (entry.instanceType !== 'sonarr' || !Array.isArray(sonarrTransition.candidateAllowlist) ||
        sonarrTransition.candidateAllowlist.length === 0 ||
        sonarrTransition.candidateAllowlist.some((candidate) =>
          !Number.isSafeInteger(candidate.mediaId) || candidate.mediaId <= 0 ||
          typeof candidate.path !== 'string' || !candidate.path ||
          !Number.isSafeInteger(candidate.size) || candidate.size <= 0
        ) ||
        [
          sonarrTransition.payloadProtectionAt,
          sonarrTransition.oldFileRemovalConfirmedAt,
          sonarrTransition.manualImportAttemptedAt,
          sonarrTransition.manualImportRejectedAt,
          sonarrTransition.rescanAuthorizedAt,
          sonarrTransition.rescanAttemptedAt,
        ].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) ||
        (rescanAuthorizedChanges !== undefined &&
          (!Array.isArray(rescanAuthorizedChanges) || rescanAuthorizedChanges.length === 0 ||
            new Set(rescanAuthorizedChanges.map((change) => change.targetId)).size !==
              rescanAuthorizedChanges.length ||
            new Set(rescanAuthorizedChanges.map((change) => change.episodeId)).size !==
              rescanAuthorizedChanges.length ||
            rescanAuthorizedChanges.some((change) =>
              !Number.isSafeInteger(change.targetId) || change.targetId <= 0 ||
              !Number.isSafeInteger(change.episodeId) || change.episodeId <= 0 ||
              !Number.isSafeInteger(change.oldFileId) || change.oldFileId < 0 ||
              (change.restoredMonitored !== undefined &&
                typeof change.restoredMonitored !== 'boolean') ||
              !Array.isArray(change.candidates) || change.candidates.length === 0 ||
              change.candidates.some((candidate) =>
                !Number.isSafeInteger(candidate.mediaId) || candidate.mediaId <= 0 ||
                typeof candidate.path !== 'string' || !candidate.path ||
                !Number.isSafeInteger(candidate.size) || candidate.size <= 0
              )
            ))) ||
        (snapshot.seasonCoordinationOutcome === 'automatic_adoption' &&
          (JSON.stringify(preDeletionPreflight) !==
              JSON.stringify(snapshot.seasonPreDeletionPreflight) ||
            !selectedSonarrCandidate || !preDeletionPreflight ||
            preDeletionPreflight.path !== selectedSonarrCandidate.path ||
            preDeletionPreflight.size !== selectedSonarrCandidate.size ||
            preDeletionPreflight.seriesId !== entry.recordId ||
            preDeletionPreflight.seasonNumber !== snapshot.seasonIndex ||
            preDeletionPreflight.episodeIds.length !== 1 ||
            preDeletionPreflight.episodeIds[0] !== entry.episodeId)))
    ) {
      throw new DeletionValidationError('durable Sonarr transition evidence is malformed');
    }
    const plan = entry.radarrPathPlan;
    if (plan === undefined) continue;
    if (
      entry.instanceType !== 'radarr' ||
      !['existing_path', 'adopt_safe_path', 'adopt_path_with_consent'].includes(plan.mode) ||
      !Number.isSafeInteger(plan.arrInstanceId) ||
      plan.arrInstanceId !== entry.instanceId ||
      !Number.isSafeInteger(plan.movieId) ||
      plan.movieId !== entry.recordId ||
      !Number.isSafeInteger(plan.retainedMediaId) ||
      typeof plan.originalMoviePath !== 'string' ||
      !plan.originalMoviePath ||
      typeof plan.targetMoviePath !== 'string' ||
      !plan.targetMoviePath ||
      typeof plan.retainedPath !== 'string' ||
      !plan.retainedPath ||
      typeof plan.radarrVersion !== 'string' ||
      !plan.radarrVersion ||
      typeof plan.radarrBehaviorFingerprint !== 'string' ||
      !plan.radarrBehaviorFingerprint ||
      typeof plan.originalMovieFile?.id !== 'number' ||
      typeof plan.originalMovieFile?.path !== 'string' ||
      typeof plan.originalMovieFile?.relativePath !== 'string' ||
      typeof plan.originalMovieFile?.size !== 'number' ||
      plan.originalMovieFile.size <= 0 ||
      !plan.namespaceEvidence?.selected ||
      !plan.namespaceEvidence?.retained ||
      !Array.isArray(plan.namespaceEvidence?.libraryLocations) ||
      !plan.physicalIdentityEvidence
    ) {
      throw new DeletionValidationError('durable Radarr path-adoption evidence is malformed');
    }
    if (
      plan.mode !== 'existing_path' &&
      (typeof plan.planFingerprint !== 'string' || !plan.planFingerprint)
    ) {
      throw new DeletionValidationError('durable Radarr path-adoption fingerprint is missing');
    }
    if (plan.mode === 'adopt_path_with_consent' && plan.userAuthorizedPathManagement !== true) {
      throw new DeletionValidationError('durable Radarr path-management consent is missing');
    }
  }
}

function normalized(value: string | null): string | null {
  const result = value?.trim().toLowerCase();
  return result ? result : null;
}

function normalizedStream(stream: PlexMediaStreamSummary): Record<string, unknown> {
  return {
    codec: normalized(stream.codec),
    language: normalized(stream.language),
    channels: stream.channels,
    channelLayout: normalized(stream.channelLayout),
    title: normalized(stream.title),
    forced: stream.forced,
    default: stream.default,
  };
}

function technicalFingerprint(details: DurableVersionTechnicalSnapshot): string {
  const streams = (values: PlexMediaStreamSummary[]) =>
    values
      .map(normalizedStream)
      .map((stream) => JSON.stringify(stream))
      .sort();
  return JSON.stringify({
    width: details.width,
    height: details.height,
    duration: details.duration,
    videoProfile: normalized(details.videoProfile),
    videoBitDepth: details.videoBitDepth,
    videoDynamicRange: normalized(details.videoDynamicRange),
    videoFrameRate: normalized(details.videoFrameRate),
    videoScanType: normalized(details.videoScanType),
    audioCodec: normalized(details.audioCodec),
    audioChannels: details.audioChannels,
    audioProfile: normalized(details.audioProfile),
    audioStreams: streams(details.audioStreams),
    subtitleStreams: streams(details.subtitleStreams),
    streamDetailsAvailable: details.streamDetailsAvailable,
  });
}

function validateTechnicalDetails(
  expected: DurableVersionTechnicalSnapshot,
  actual: PlexMediaTechnicalDetails | undefined,
  label: string,
): void {
  if (!actual || technicalFingerprint(expected) !== technicalFingerprint(actual)) mismatch(label);
}

function validateLiveItem(snapshot: DurableTargetSnapshot, live: PlexMetadataIdentity): void {
  if (live.ratingKey !== snapshot.ratingKey) mismatch('Plex rating key');
  if (live.type !== snapshot.type) mismatch('Plex media type');
  if (live.title !== (snapshot.episodeTitle ?? snapshot.title)) mismatch('Plex title');
  if (live.librarySectionId !== null && live.librarySectionId !== snapshot.libraryKey) {
    mismatch('Plex library ownership');
  }
  if (snapshot.type !== 'episode') {
    equalNullable(snapshot.tmdbId, live.tmdbId, 'TMDB identity');
    equalNullable(snapshot.tvdbId, live.tvdbId, 'TVDB identity');
  }
  if (snapshot.quickCleanupEvidence && snapshot.type === 'movie' && live.media.length >= 2) {
    mismatch('quick cleanup Plex versions');
  }
}

function validateLocalTarget(
  serverId: number,
  kind: DurableTargetRecord['targetKind'],
  snapshot: DurableTargetSnapshot,
): void {
  const row = withTransaction((client) => {
    if (kind === 'whole_item') {
      return client
        .prepare(
          `SELECT library_key, title, type, tmdb_id, tvdb_id, last_viewed_at, added_at
           FROM items i WHERE server_id = ? AND rating_key = ?
             AND NOT EXISTS (SELECT 1 FROM ignored_content ignored
               WHERE ignored.server_id = i.server_id AND ignored.rating_key = i.rating_key)`,
        )
        .value<unknown[]>(serverId, snapshot.ratingKey);
    }
    if (kind === 'movie_version') {
      return client
        .prepare(
          `SELECT v.library_key, i.title, i.type, i.tmdb_id, i.tvdb_id, v.file_size,
                  v.video_resolution, v.height, v.bitrate, v.video_codec, v.container
           FROM item_media_versions v
           JOIN items i ON i.server_id = v.server_id AND i.rating_key = v.item_rating_key
           WHERE v.server_id = ? AND v.item_rating_key = ? AND v.media_id = ?
             AND NOT EXISTS (SELECT 1 FROM ignored_content ignored
               WHERE ignored.server_id = i.server_id AND ignored.rating_key = i.rating_key)`,
        )
        .value<unknown[]>(serverId, snapshot.ratingKey, snapshot.mediaId!);
    }
    return client
      .prepare(
        `SELECT v.library_key, v.episode_title, v.show_rating_key, v.season_rating_key,
                v.season_index, v.episode_index, v.file_size, v.video_resolution, v.height,
                v.bitrate, v.video_codec, v.container
         FROM episode_media_versions v
         WHERE v.server_id = ? AND v.episode_rating_key = ? AND v.media_id = ?
           AND NOT EXISTS (SELECT 1 FROM ignored_content ignored
             WHERE ignored.server_id = v.server_id AND ignored.rating_key = v.show_rating_key)`,
      )
      .value<unknown[]>(serverId, snapshot.ratingKey, snapshot.mediaId!);
  });
  if (!row) throw new DeletionValidationError('local target disappeared before finalization');
  if (row[0] !== snapshot.libraryKey) mismatch('local library ownership');
  if (kind === 'whole_item') {
    if (row[1] !== snapshot.title || row[2] !== snapshot.type) mismatch('local item identity');
    equalNullable(snapshot.tmdbId, row[3], 'local TMDB identity');
    equalNullable(snapshot.tvdbId, row[4], 'local TVDB identity');
    const evidence = snapshot.quickCleanupEvidence;
    if (evidence) {
      if (row[5] !== evidence.lastViewedAt) mismatch('quick cleanup watch history');
      if (row[6] !== evidence.addedAt) mismatch('quick cleanup added date');
      if (
        !isStaleQuickCleanupCandidate(
          serverId,
          snapshot.libraryKey,
          evidence.thresholdDays,
          snapshot.ratingKey,
        )
      ) {
        mismatch('quick cleanup eligibility');
      }
    }
    return;
  }
  if (kind === 'movie_version') {
    if (row[1] !== snapshot.title || row[2] !== snapshot.type) mismatch('local movie identity');
    equalNullable(snapshot.tmdbId, row[3], 'local TMDB identity');
    equalNullable(snapshot.tvdbId, row[4], 'local TVDB identity');
    for (
      const [index, key] of [
        'fileSize',
        'videoResolution',
        'height',
        'bitrate',
        'videoCodec',
        'container',
      ].entries()
    ) {
      equalNullable(
        snapshot[key as keyof DurableTargetSnapshot],
        row[index + 5],
        `local version ${key}`,
      );
    }
    return;
  }
  const expected = [
    snapshot.episodeTitle,
    snapshot.showRatingKey,
    snapshot.seasonRatingKey,
    snapshot.seasonIndex,
    snapshot.episodeIndex,
    ...(snapshot.seasonCleanup === true ? [] : [
      snapshot.fileSize,
      snapshot.videoResolution,
      snapshot.height,
      snapshot.bitrate,
      snapshot.videoCodec,
      snapshot.container,
    ]),
  ];
  expected.forEach((value, index) =>
    equalNullable(value, row[index + 1], 'local episode identity')
  );
}

export async function validateDeletionTarget(
  serverId: number,
  target: DurableTargetRecord,
): Promise<{
  client: PlexClient;
  snapshot: DurableTargetSnapshot;
  live: PlexMetadataIdentity | null;
}> {
  const active = await resolveActiveServer();
  if (active.serverId !== serverId) {
    throw new DeletionValidationError('the active Plex server changed after deletion was accepted');
  }
  const snapshot = JSON.parse(target.snapshot) as DurableTargetSnapshot;
  validateArrMonitoringEvidence(snapshot);
  if (snapshot.serverUrl !== active.client.serverUrl) mismatch('Plex server address');
  if ((await active.client.identity()) !== snapshot.machineIdentifier) {
    mismatch('Plex machine identity');
  }
  validateLocalTarget(serverId, target.targetKind, snapshot);

  const live = await active.client.metadataIdentity(snapshot.ratingKey);
  if (!live) return { client: active.client, snapshot, live: null };
  await validateLiveDeletionIdentity(active.client, target.targetKind, snapshot, live);
  return { client: active.client, snapshot, live };
}

export async function validateLiveDeletionIdentity(
  client: PlexClient,
  targetKind: DurableTargetRecord['targetKind'],
  snapshot: DurableTargetSnapshot,
  live: PlexMetadataIdentity,
): Promise<void> {
  validateLiveItem(snapshot, live);
  if (
    snapshot.quickCleanupEvidence &&
    live.type === 'show' &&
    (await client.showHasMultiVersionEpisodes(snapshot.ratingKey))
  ) {
    mismatch('quick cleanup Plex versions');
  }
  if (targetKind !== 'whole_item') {
    const liveVersion = live.media.find((version) => version.mediaId === snapshot.mediaId);
    if (liveVersion) {
      for (
        const key of [
          'fileSize',
          'videoResolution',
          'height',
          'bitrate',
          'videoCodec',
          'container',
        ] as const
      ) {
        equalNullable(snapshot[key], liveVersion[key], `Plex version ${key}`);
      }
    }
    const expectedRetainedVersions = snapshot.expectedRetainedVersions ??
      (snapshot.expectedRetainedVersion ? [snapshot.expectedRetainedVersion] : []);
    if (
      snapshot.expectedPlexPath !== undefined ||
      expectedRetainedVersions.some((entry) => entry.plexPath !== undefined)
    ) {
      const pathPreviews = await client.mediaVersionPathPreviews(snapshot.ratingKey);
      const assertExactPath = (mediaId: number, expectedPath: string, label: string) => {
        const preview = pathPreviews.find((entry) => entry.mediaId === mediaId);
        if (
          !preview || preview.truncated || preview.paths.length !== 1 ||
          preview.paths[0] !== expectedPath
        ) mismatch(label);
      };
      if (snapshot.expectedPlexPath !== undefined && liveVersion) {
        assertExactPath(snapshot.mediaId!, snapshot.expectedPlexPath, 'Plex version path');
      }
      for (const expectedRetained of expectedRetainedVersions) {
        if (expectedRetained.plexPath !== undefined) {
          assertExactPath(
            expectedRetained.mediaId,
            expectedRetained.plexPath,
            'retained Plex version path',
          );
        }
      }
    }
    for (const expectedRetained of expectedRetainedVersions) {
      const liveRetained = live.media.find(
        (version) => version.mediaId === expectedRetained.mediaId,
      );
      if (!liveRetained) {
        throw new DeletionValidationError(
          'the version selected to keep is no longer available in Plex',
        );
      }
      for (
        const key of [
          'fileSize',
          'videoResolution',
          'height',
          'bitrate',
          'videoCodec',
          'container',
        ] as const
      ) {
        equalNullable(expectedRetained[key], liveRetained[key], `retained Plex version ${key}`);
      }
    }
    if (
      (liveVersion && snapshot.classificationTechnicalDetails) ||
      expectedRetainedVersions.some((entry) => entry.classificationTechnicalDetails)
    ) {
      const liveDetails = await client.mediaVersionTechnicalDetails(snapshot.ratingKey);
      if (liveVersion && snapshot.classificationTechnicalDetails) {
        validateTechnicalDetails(
          snapshot.classificationTechnicalDetails,
          liveDetails.get(snapshot.mediaId!),
          'Plex version technical profile',
        );
      }
      for (const expectedRetained of expectedRetainedVersions) {
        if (expectedRetained.classificationTechnicalDetails) {
          validateTechnicalDetails(
            expectedRetained.classificationTechnicalDetails,
            liveDetails.get(expectedRetained.mediaId),
            'retained Plex version technical profile',
          );
        }
      }
    }
  }
  if (targetKind === 'episode_version') {
    if (
      live.grandparentRatingKey !== snapshot.showRatingKey ||
      live.parentRatingKey !== snapshot.seasonRatingKey ||
      live.seasonIndex !== snapshot.seasonIndex ||
      live.index !== snapshot.episodeIndex
    ) {
      mismatch('Plex episode ancestry');
    }
    const show = await client.metadataIdentity(snapshot.showRatingKey!);
    if (!show || show.title !== snapshot.showTitle) mismatch('Plex show identity');
    equalNullable(snapshot.tvdbId, show.tvdbId, 'Plex show TVDB identity');
  }
}
