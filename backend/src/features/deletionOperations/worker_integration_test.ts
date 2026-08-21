import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from '@std/assert';
import { resolve } from '@std/path';
import type { PlexRawMetadata } from '../../integrations/plex/types.ts';

const testDirectory = await Deno.makeTempDir();
const testDbPath = resolve(testDirectory, 'deletion-worker.db');
Deno.env.set('DB_PATH', testDbPath);

const { runMigrations } = await import('../../db/migrate.ts');
await runMigrations(testDbPath, resolve(import.meta.dirname!, '../../../drizzle'));
const { withTransaction } = await import('../../db/index.ts');
const {
  cancelDeletionOperation,
  DeletionConflictError,
  dismissDeletionOperation,
  enqueueDeletionOperation,
  enqueueDeletionOperations,
  getDeletionOperation,
  retryDeletionOperation,
  runDeletionWorkerOnceForTest,
  setAutomaticDeletionWorkerForTest,
} = await import('./service.ts');
const { recoverInterruptedDeletionWork } = await import('./core/recovery.ts');
const { DeletionValidationError } = await import('./core/validation.ts');
const { ensureDeletionTarget } = await import('./workflow/targetWorkflow.ts');
const {
  assertRelocationWorkflowClear,
  canonicalJson,
  completeRelocationBarriers,
  finishRelocation,
} = await import('./relocation/relocation.ts');
const { createRelocationGuidance, relocationManualReason } = await import(
  './relocation/relocationModel.ts'
);
const { refreshDeletionOperation } = await import('./core/state.ts');
const {
  deletionRecoveryLibraryKeys,
  deletionRecoveryNeedsProjection,
  deletionRecoveryProjectionRoots,
} = await import('./core/coordination.ts');
const { orphanRootIdentity } = await import('../mediaDeletion/hardlinks.ts');
const { runLibrarySync, runSync } = await import('../sync/service.ts');
const { finalizeSyncLog } = await import('../sync/syncLog.ts');
const { clearPlexClientCache, resolveActiveServer } = await import(
  '../../integrations/plex/index.ts'
);
const { createApp } = await import('../../app.ts');
const rawApp = createApp();
const app = {
  request(input: string | Request, init?: RequestInit) {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/duplicates/seasons/') && typeof init?.body === 'string') {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (typeof body.coordinateSonarr === 'boolean' && !Object.hasOwn(body, 'sonarrMode')) {
        body.sonarrMode = body.coordinateSonarr ? 'adopt_retained' : 'none';
        delete body.coordinateSonarr;
        init = { ...init, body: JSON.stringify(body) };
      }
    }
    return rawApp.request(input, init);
  },
};

async function seasonPreviewEvidence(
  seasonRatingKey: string,
  episodeRatingKeys: string[],
  options: {
    coordinateSonarr?: boolean;
    sonarrMode?: 'none' | 'adopt_retained' | 'remove_and_unmonitor';
    cleanupDownloads: boolean;
  } = { coordinateSonarr: false, cleanupDownloads: false },
) {
  const response = await app.request(
    `/api/duplicates/seasons/${encodeURIComponent(seasonRatingKey)}/analysis`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ episodeRatingKeys, totalEpisodeCount: episodeRatingKeys.length }),
    },
  );
  assertEquals(response.status, 200, await response.clone().text());
  const selections = episodeRatingKeys.map((episodeRatingKey) => {
    const mediaIds = withTransaction((client) =>
      client.prepare(
        'SELECT media_id FROM episode_media_versions WHERE episode_rating_key = ? ORDER BY media_id',
      ).values<[number]>(episodeRatingKey).map(([id]) => id)
    );
    return { episodeRatingKey, mediaIds: mediaIds.slice(0, -1) };
  });
  const deletionResponse = await app.request(
    `/api/duplicates/seasons/${encodeURIComponent(seasonRatingKey)}/deletion-preview`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selections,
        sonarrMode: options.sonarrMode ??
          (options.coordinateSonarr ? 'adopt_retained' : 'none'),
        cleanupDownloads: options.cleanupDownloads,
      }),
    },
  );
  assertEquals(deletionResponse.status, 200, await deletionResponse.clone().text());
  const deletionPreview = await deletionResponse.json();
  return {
    previewFingerprint: deletionPreview.fingerprint,
    sonarrMode: options.sonarrMode ?? (options.coordinateSonarr ? 'adopt_retained' : 'none'),
    cleanupDownloads: options.cleanupDownloads,
  };
}

async function seasonCleanupRequest(
  seasonRatingKey: string,
  init: RequestInit,
): Promise<Response> {
  return await app.request(
    `/api/duplicates/seasons/${encodeURIComponent(seasonRatingKey)}/cleanup`,
    init,
  );
}

const live = new Map<string, PlexRawMetadata>();
const bulkMetadataOverrides = new Map<string, PlexRawMetadata>();
let exactMetadataFailureStatus: number | null = null;
let plexMachineIdentifier = 'machine-1';
let loseDeleteResponse = false;
let failDeleteBeforeMutation = false;
let plexMediaDeleteCount = 0;
let coordinatedRatingKey: string | null = null;
let arrPresent = false;
let arrDeleteCount = 0;
const destinationOrder: string[] = [];
let loseArrRemovalResponse = false;
let radarrExclusion: {
  id: number;
  tmdbId: number;
  movieTitle: string;
  movieYear: number;
} | null = null;
let arrManagedFilePresent = true;
let arrManagedFileId = 70;
let arrManagedFileSize = 100_000;
let arrExtraMovieFileId: number | null = null;
let arrRescanFileSize = 50_000;
let arrManagedPath = '/library/Coordinated/movie.mkv';
let arrManagedMediaId: number | null = null;
let arrRescanTargetPath: string | null = null;
let restoreArrPathOnRescan: string | null = null;
let restoredArrPath: string | null = null;
let arrMoviePath = '/library/Coordinated';
let arrMonitored = true;
let arrMonitorMutationCount = 0;
let loseMonitorResponseAtMutation: number | null = null;
let rejectMonitorAtMutation: number | null = null;
let monitorDriftAfterSelectedDelete = false;
let monitorDriftAfterRestorationReads: number | null = null;
let monitorDriftAfterUnmonitoredEvidence = false;
let rejectMonitoringWrites = false;
let loseArrManagedDeleteResponse = false;
let loseArrMoviePathResponse = false;
let loseArrRescanResponse = false;
let rejectArrRescanStatus: number | null = null;
let arrManagedFileReads = 0;
let activatePlaybackOnManagedFileRead: number | null = null;
let changeArrOwnershipOnManagedFileRead: {
  read: number;
  mediaId: number;
  path: string;
} | null = null;
let removePlexMediaOnManagedFileRead: {
  read: number;
  ratingKey: string;
  mediaId: number;
} | null = null;
let pendingPlexMediaRemoval: { ratingKey: string; mediaId: number } | null = null;
let activePlaybackRatingKey: string | null = null;
let activeSessionsHook: (() => void) | null = null;
let sonarrManagedFilePresent = true;
let sonarrManagedFileId = 10;
let sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
let sonarrManagedMediaId: number | null = null;
let sonarrRescanTargetPath: string | null = null;
interface AdditionalSonarrEpisode {
  ratingKey: string;
  episodeId: number;
  episodeNumber: number;
  managedFileId: number;
  managedPath: string;
  managedMediaId: number;
  retainedPath: string;
  retainedMediaId: number;
  monitored: boolean;
  managedFilePresent: boolean;
}
let additionalSonarrEpisodes: AdditionalSonarrEpisode[] = [];
let rejectSonarrMonitoringEpisodeId: number | null = null;
let rejectSonarrManualImportPreflight = false;
let rejectSonarrManualImportStatus: number | null = null;
let sonarrManualImportSize = 40_000;
let sonarrRescanHook: (() => void) | null = null;
let sonarrRescanCount = 0;
let sonarrMonitorMutationCount = 0;
let sonarrMonitored = true;
let sonarrManagedFileShared = false;
let sonarrOldPathLingersAfterDelete = false;
let sonarrReportedVersion = '4.0.19.2979';
let sonarrUnavailable = false;
let sonarrHistoryUnavailable = false;
let sonarrActivityReadCount = 0;
let blockSonarrActivityAtRead: number | null = null;
let seasonPackQbit = false;
let seasonPackMixed = false;
let seasonPackForeignOwner = false;
let qbitPresent = false;
let qbitDeleteCount = 0;
let qbitRequestCount = 0;
let loseQbitDeleteResponse = false;
let fetchCount = 0;
let technicalDetailsRequestCount = 0;
let historyAccountId: unknown = null;
let reportedPlexLibraries: Array<{ key: string; title: string; type: string }> | null = null;
const torrentHash = 'a'.repeat(40);
const wholeDeleteOrder: string[] = [];
const versionDeleteOrder: string[] = [];
setAutomaticDeletionWorkerForTest(false);

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  fetchCount++;
  const url = new URL(String(input));
  if (url.pathname === '/identity') {
    return Promise.resolve(
      Response.json({ MediaContainer: { machineIdentifier: plexMachineIdentifier } }),
    );
  }
  if (url.pathname === '/status/sessions') {
    activeSessionsHook?.();
    return Promise.resolve(Response.json({
      MediaContainer: {
        Metadata: activePlaybackRatingKey
          ? [{ ratingKey: activePlaybackRatingKey, type: 'movie' }]
          : [],
      },
    }));
  }
  if (url.pathname === '/library/sections') {
    return Promise.resolve(Response.json({
      MediaContainer: { Directory: reportedPlexLibraries ?? [] },
    }));
  }
  if (url.pathname === '/library/sections/movies/all') {
    const metadata = [...live.values()].filter((item) => item.type === 'movie').map((item) =>
      bulkMetadataOverrides.get(item.ratingKey) ?? item
    );
    return Promise.resolve(Response.json({
      MediaContainer: { Metadata: metadata, totalSize: metadata.length },
    }));
  }
  if (url.pathname === '/library/sections/shows/all') {
    const requestedType = url.searchParams.get('type');
    const metadata = [...live.values()].filter((item) =>
      requestedType === '4' ? item.type === 'episode' : item.type === 'show'
    );
    return Promise.resolve(Response.json({
      MediaContainer: { Metadata: metadata, totalSize: metadata.length },
    }));
  }
  if (url.pathname === '/status/sessions/history/all') {
    const metadata = historyAccountId === null
      ? []
      : [{ ratingKey: 'history-item', viewedAt: 100, accountID: historyAccountId }];
    return Promise.resolve(Response.json({
      MediaContainer: { Metadata: metadata, totalSize: metadata.length },
    }));
  }
  if (url.hostname === 'plex.tv' && url.pathname === '/api/v2/user') {
    return Promise.resolve(Response.json({ id: 1, username: 'owner' }));
  }
  if (url.hostname === 'plex.tv' && url.pathname === '/api/users') {
    return Promise.resolve(new Response('<MediaContainer />'));
  }
  if (url.pathname === '/accounts') {
    return Promise.resolve(Response.json({ MediaContainer: { Account: [] } }));
  }
  if (url.hostname.startsWith('radarr')) {
    if (url.pathname === '/api/v3/movie') {
      return Promise.resolve(
        Response.json(
          arrPresent
            ? [{
              id: 7,
              tmdbId: 10,
              title: 'Coordinated movie',
              year: 2000,
              path: arrMoviePath,
              monitored: arrMonitored,
            }]
            : [],
        ),
      );
    }
    if (url.pathname === '/api/v3/exclusions/paged') {
      const records = radarrExclusion ? [radarrExclusion] : [];
      return Promise.resolve(Response.json({ records, totalRecords: records.length }));
    }
    if (url.pathname === '/api/v3/exclusions' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Omit<NonNullable<typeof radarrExclusion>, 'id'>;
      radarrExclusion = { id: 91, ...body };
      return Promise.resolve(Response.json(radarrExclusion));
    }
    if (url.pathname === '/api/v3/queue') {
      return Promise.resolve(Response.json({ records: [], totalRecords: 0 }));
    }
    if (url.pathname === '/api/v3/command' && (init?.method ?? 'GET') === 'GET') {
      return Promise.resolve(Response.json([]));
    }
    if (url.pathname === '/api/v3/moviefile') {
      arrManagedFileReads++;
      if (arrManagedFileReads === changeArrOwnershipOnManagedFileRead?.read) {
        arrManagedMediaId = changeArrOwnershipOnManagedFileRead.mediaId;
        arrManagedPath = changeArrOwnershipOnManagedFileRead.path;
      }
      if (arrManagedFileReads === activatePlaybackOnManagedFileRead) {
        activePlaybackRatingKey = coordinatedRatingKey;
      }
      if (arrManagedFileReads === removePlexMediaOnManagedFileRead?.read) {
        pendingPlexMediaRemoval = {
          ratingKey: removePlexMediaOnManagedFileRead.ratingKey,
          mediaId: removePlexMediaOnManagedFileRead.mediaId,
        };
      }
      return Promise.resolve(Response.json(
        arrManagedFilePresent
          ? [{
            id: arrManagedFileId,
            relativePath: arrManagedPath.split('/').at(-1),
            path: arrManagedPath,
            size: arrManagedFileSize,
          }]
          : [],
      ));
    }
    if (url.pathname === '/api/v3/extrafile') {
      return Promise.resolve(Response.json(
        arrExtraMovieFileId === null
          ? []
          : [{ relativePath: 'movie.nfo', type: 'metadata', movieFileId: arrExtraMovieFileId }],
      ));
    }
    if (url.pathname === '/api/v3/filesystem/type') {
      const path = url.searchParams.get('path');
      const exists = path === restoredArrPath ||
        [...live.values()].some((item) =>
          item.Media?.some((media) => media.Part?.some((part) => part.file === path))
        );
      return Promise.resolve(Response.json({ type: exists ? 'file' : 'folder' }));
    }
    if (url.pathname === '/api/v3/history/movie') {
      return Promise.resolve(Response.json([{
        id: 1,
        eventType: 'downloadFolderImported',
        downloadId: torrentHash,
        data: { droppedPath: '/downloads/release/movie.mkv' },
      }]));
    }
    if (url.pathname === '/api/v3/history') {
      return Promise.resolve(Response.json({ totalRecords: 1, records: [{ movieId: 7 }] }));
    }
    if (url.pathname === '/api/v3/movie/7' && init?.method === 'DELETE') {
      destinationOrder.push('arr');
      versionDeleteOrder.push('radarr');
      arrDeleteCount++;
      arrPresent = false;
      if (loseArrRemovalResponse) {
        loseArrRemovalResponse = false;
        return Promise.reject(new TypeError('lost Radarr removal response'));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.pathname === '/api/v3/movie/7' && (init?.method ?? 'GET') === 'GET') {
      if (!arrPresent) return Promise.resolve(new Response(null, { status: 404 }));
      if (
        monitorDriftAfterUnmonitoredEvidence && withTransaction((client) =>
            client.prepare(
              "SELECT COUNT(*) FROM deletion_targets WHERE json_extract(snapshot, '$.arrReassignments[0].originalMonitored') = 0",
            ).value<[number]>()?.[0] ?? 0
          ) > 0
      ) {
        monitorDriftAfterUnmonitoredEvidence = false;
        arrMonitored = true;
      }
      const monitored = arrMonitored;
      if (
        arrMonitorMutationCount >= 2 && monitorDriftAfterRestorationReads !== null &&
        --monitorDriftAfterRestorationReads === 0
      ) {
        monitorDriftAfterRestorationReads = null;
        arrMonitored = false;
      }
      return Promise.resolve(Response.json({
        id: 7,
        tmdbId: 10,
        title: 'Coordinated movie',
        path: arrMoviePath,
        monitored,
      }));
    }
    if (url.pathname === '/api/v3/movie/7' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { path?: string; monitored?: boolean };
      if (
        body.monitored !== undefined &&
        (rejectMonitoringWrites || arrMonitorMutationCount + 1 === rejectMonitorAtMutation)
      ) {
        return Promise.resolve(new Response('monitoring rejected', { status: 503 }));
      }
      if (body.path) arrMoviePath = body.path;
      if (body.monitored !== undefined) {
        arrMonitorMutationCount++;
        arrMonitored = body.monitored;
      }
      if (arrMonitorMutationCount === loseMonitorResponseAtMutation) {
        loseMonitorResponseAtMutation = null;
        return Promise.reject(new TypeError('lost Radarr monitoring response'));
      }
      if (loseArrMoviePathResponse) {
        loseArrMoviePathResponse = false;
        return Promise.reject(new TypeError('lost Radarr movie path response'));
      }
      return Promise.resolve(Response.json({ id: 7, monitored: arrMonitored }));
    }
    if (
      url.pathname === `/api/v3/moviefile/${arrManagedFileId}` &&
      init?.method === 'DELETE'
    ) {
      arrManagedFilePresent = false;
      if (coordinatedRatingKey && arrManagedMediaId !== null) {
        const item = live.get(coordinatedRatingKey);
        if (item?.Media) {
          item.Media = item.Media.filter((media) => media.id !== arrManagedMediaId);
        }
      }
      if (loseArrManagedDeleteResponse) {
        loseArrManagedDeleteResponse = false;
        return Promise.reject(new TypeError('lost Radarr file deletion response'));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.pathname === '/api/v3/command' && init?.method === 'POST') {
      if (rejectArrRescanStatus !== null) {
        return Promise.resolve(
          new Response('rescan disabled', { status: rejectArrRescanStatus }),
        );
      }
      if (arrRescanTargetPath) {
        arrManagedPath = arrRescanTargetPath;
        arrManagedFileId++;
        arrManagedFileSize = arrRescanFileSize;
        arrManagedFilePresent = true;
      }
      restoredArrPath = restoreArrPathOnRescan;
      if (loseArrRescanResponse) {
        loseArrRescanResponse = false;
        return Promise.reject(new TypeError('lost Radarr rescan response'));
      }
      return Promise.resolve(Response.json({ id: 80 }));
    }
  }
  if (url.hostname === 'sonarr') {
    if (sonarrUnavailable) return Promise.reject(new TypeError('Sonarr is unavailable'));
    if (url.pathname === '/api/v3/system/status') {
      return Promise.resolve(Response.json({ appName: 'Sonarr', version: sonarrReportedVersion }));
    }
    if (url.pathname === '/api/v3/series') {
      return Promise.resolve(Response.json([{
        id: 8,
        tvdbId: 20,
        title: 'Example Show',
        path: '/tv/Show',
      }]));
    }
    if (url.pathname === '/api/v3/queue') {
      sonarrActivityReadCount++;
      const blocked = sonarrActivityReadCount === blockSonarrActivityAtRead;
      return Promise.resolve(Response.json({
        records: blocked ? [{ id: 901, seriesId: 8, status: 'importing' }] : [],
        totalRecords: blocked ? 1 : 0,
      }));
    }
    if (url.pathname === '/api/v3/command' && (init?.method ?? 'GET') === 'GET') {
      return Promise.resolve(Response.json([]));
    }
    if (url.pathname === '/api/v3/command/81') {
      return Promise.resolve(Response.json({ id: 81, name: 'ManualImport', status: 'completed' }));
    }
    if (url.pathname === '/api/v3/filesystem/type') {
      const path = url.searchParams.get('path');
      const visible = (sonarrManagedFilePresent || sonarrOldPathLingersAfterDelete) &&
          path === sonarrManagedPath ||
        path === sonarrRescanTargetPath ||
        additionalSonarrEpisodes.some((episode) =>
          episode.managedFilePresent && path === episode.managedPath ||
          path === episode.retainedPath
        );
      return Promise.resolve(Response.json({ type: visible ? 'file' : 'missing' }));
    }
    if (url.pathname === '/api/v3/manualimport' && init?.method === 'POST') {
      const candidates = JSON.parse(String(init.body)) as Array<
        { path: string; episodeIds: number[] }
      >;
      return Promise.resolve(Response.json(candidates.map((candidate) => ({
        path: candidate.path,
        size: sonarrManualImportSize,
        seriesId: 8,
        seasonNumber: 1,
        // Model Sonarr independently parsing the retained path. The production
        // preflight deliberately sends no caller-selected episode IDs.
        episodes: candidate.path === sonarrRescanTargetPath
          ? [{ id: 9 }]
          : additionalSonarrEpisodes.flatMap((episode) =>
            candidate.path === episode.retainedPath ? [{ id: episode.episodeId }] : []
          ),
        quality: {
          quality: { id: 6, name: 'WEB 1080p', source: 'web', resolution: 1080 },
          revision: { version: 1, real: 0, isRepack: false },
        },
        languages: [{ id: 1, name: 'English' }],
        releaseGroup: 'Group',
        indexerFlags: 0,
        releaseType: 'webRip',
        rejections: rejectSonarrManualImportPreflight
          ? [{ reason: 'manual import unavailable' }]
          : [],
      }))));
    }
    if (url.pathname === '/api/v3/manualimport' && (init?.method ?? 'GET') === 'GET') {
      return Promise.resolve(Response.json([
        ...(sonarrRescanTargetPath
          ? [{
            path: sonarrRescanTargetPath,
            size: sonarrManualImportSize,
            seriesId: 8,
            episodes: [{ id: 9 }],
            rejections: [],
          }]
          : []),
        ...additionalSonarrEpisodes.map((episode) => ({
          path: episode.retainedPath,
          size: sonarrManualImportSize,
          seriesId: 8,
          episodes: [{ id: episode.episodeId }],
          rejections: [],
        })),
      ]));
    }
    if (
      url.pathname === '/api/v3/history/series' && seasonPackQbit && !sonarrHistoryUnavailable
    ) {
      return Promise.resolve(Response.json([{
        id: 501,
        eventType: 'downloadFolderImported',
        downloadId: torrentHash,
        data: {
          droppedPath: '/downloads/release/old.mkv',
          sourcePath: '/downloads/release',
          importedPath: sonarrManagedPath,
        },
      }]));
    }
    if (url.pathname === '/api/v3/history' && seasonPackQbit && !sonarrHistoryUnavailable) {
      const records = [{ seriesId: 8 }, ...(seasonPackForeignOwner ? [{ seriesId: 99 }] : [])];
      return Promise.resolve(Response.json({ totalRecords: records.length, records }));
    }
    if (url.pathname === '/api/v3/episode/monitor' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { episodeIds: number[]; monitored: boolean };
      sonarrMonitorMutationCount++;
      for (const episodeId of body.episodeIds) {
        if (episodeId === 9) sonarrMonitored = body.monitored;
        const additional = additionalSonarrEpisodes.find((episode) =>
          episode.episodeId === episodeId
        );
        if (additional) additional.monitored = body.monitored;
      }
      return Promise.resolve(
        Response.json(body.episodeIds.map((id) => ({ id, monitored: body.monitored }))),
      );
    }
    if (url.pathname === '/api/v3/episode') {
      return Promise.resolve(Response.json([
        {
          id: 9,
          seriesId: 8,
          seasonNumber: 1,
          episodeNumber: 1,
          episodeFileId: sonarrManagedFilePresent ? sonarrManagedFileId : 0,
          monitored: sonarrMonitored,
        },
        ...(sonarrManagedFileShared
          ? [{
            id: 11,
            seriesId: 8,
            seasonNumber: 1,
            episodeNumber: 2,
            episodeFileId: sonarrManagedFileId,
            monitored: true,
          }]
          : []),
        ...additionalSonarrEpisodes.map((episode) => ({
          id: episode.episodeId,
          seriesId: 8,
          seasonNumber: 1,
          episodeNumber: episode.episodeNumber,
          episodeFileId: episode.managedFilePresent ? episode.managedFileId : 0,
          monitored: episode.monitored,
        })),
      ]));
    }
    if (url.pathname === '/api/v3/episodefile') {
      return Promise.resolve(Response.json([
        ...(sonarrManagedFilePresent
          ? [{
            id: sonarrManagedFileId,
            seriesId: 8,
            relativePath: sonarrManagedPath.replace('/tv/Show/', ''),
            path: sonarrManagedPath,
            size: 40_000,
          }]
          : []),
        ...additionalSonarrEpisodes.flatMap((episode) =>
          episode.managedFilePresent
            ? [{
              id: episode.managedFileId,
              seriesId: 8,
              relativePath: episode.managedPath.replace('/tv/Show/', ''),
              path: episode.managedPath,
              size: 40_000,
            }]
            : []
        ),
      ]));
    }
    const episodePathMatch = /^\/api\/v3\/episode\/(\d+)$/.exec(url.pathname);
    if (episodePathMatch && (init?.method ?? 'GET') === 'GET') {
      const episodeId = Number(episodePathMatch[1]);
      const additional = additionalSonarrEpisodes.find((episode) =>
        episode.episodeId === episodeId
      );
      if (episodeId !== 9 && !additional) {
        return Promise.resolve(new Response('missing', { status: 404 }));
      }
      if (
        episodeId === 9 &&
        monitorDriftAfterUnmonitoredEvidence && withTransaction((client) =>
            client.prepare(
              "SELECT COUNT(*) FROM deletion_targets WHERE json_extract(snapshot, '$.arrReassignments[0].originalMonitored') = 0",
            ).value<[number]>()?.[0] ?? 0
          ) > 0
      ) {
        monitorDriftAfterUnmonitoredEvidence = false;
        sonarrMonitored = true;
      }
      const monitored = additional?.monitored ?? sonarrMonitored;
      if (
        episodeId === 9 &&
        sonarrMonitorMutationCount >= 2 && monitorDriftAfterRestorationReads !== null &&
        --monitorDriftAfterRestorationReads === 0
      ) {
        monitorDriftAfterRestorationReads = null;
        sonarrMonitored = false;
      }
      return Promise.resolve(Response.json({
        id: episodeId,
        seriesId: 8,
        seasonNumber: 1,
        episodeNumber: additional?.episodeNumber ?? 1,
        monitored,
      }));
    }
    if (episodePathMatch && init?.method === 'PUT') {
      const episodeId = Number(episodePathMatch[1]);
      const additional = additionalSonarrEpisodes.find((episode) =>
        episode.episodeId === episodeId
      );
      if (episodeId !== 9 && !additional) {
        return Promise.resolve(new Response('missing', { status: 404 }));
      }
      const body = JSON.parse(String(init.body)) as { monitored?: boolean };
      if (
        body.monitored !== undefined &&
        (rejectMonitoringWrites || sonarrMonitorMutationCount + 1 === rejectMonitorAtMutation ||
          episodeId === rejectSonarrMonitoringEpisodeId)
      ) {
        return Promise.resolve(new Response('monitoring rejected', { status: 503 }));
      }
      sonarrMonitorMutationCount++;
      if (typeof body.monitored === 'boolean') {
        if (additional) additional.monitored = body.monitored;
        else sonarrMonitored = body.monitored;
      }
      if (sonarrMonitorMutationCount === loseMonitorResponseAtMutation) {
        loseMonitorResponseAtMutation = null;
        return Promise.reject(new TypeError('lost Sonarr monitoring response'));
      }
      return Promise.resolve(Response.json({
        id: episodeId,
        monitored: additional?.monitored ?? sonarrMonitored,
      }));
    }
    const episodeFilePathMatch = /^\/api\/v3\/episodefile\/(\d+)$/.exec(url.pathname);
    if (episodeFilePathMatch && (init?.method ?? 'GET') === 'GET') {
      const fileId = Number(episodeFilePathMatch[1]);
      const additional = additionalSonarrEpisodes.find((episode) =>
        episode.managedFileId === fileId
      );
      if (fileId !== sonarrManagedFileId && !additional) {
        return Promise.resolve(new Response('missing', { status: 404 }));
      }
      if (additional ? !additional.managedFilePresent : !sonarrManagedFilePresent) {
        return Promise.resolve(new Response('missing', { status: 404 }));
      }
      return Promise.resolve(Response.json({
        id: fileId,
        seriesId: 8,
        relativePath: (additional?.managedPath ?? sonarrManagedPath).replace('/tv/Show/', ''),
        path: additional?.managedPath ?? sonarrManagedPath,
        size: 40_000,
      }));
    }
    if (episodeFilePathMatch && init?.method === 'DELETE') {
      const fileId = Number(episodeFilePathMatch[1]);
      const additional = additionalSonarrEpisodes.find((episode) =>
        episode.managedFileId === fileId
      );
      if (fileId !== sonarrManagedFileId && !additional) {
        return Promise.resolve(new Response('missing', { status: 404 }));
      }
      if (seasonPackQbit) versionDeleteOrder.push('sonarr');
      if (additional) additional.managedFilePresent = false;
      else sonarrManagedFilePresent = false;
      if (!additional && monitorDriftAfterSelectedDelete) sonarrMonitored = true;
      const managedMediaId = additional?.managedMediaId ?? sonarrManagedMediaId;
      if (managedMediaId !== null) {
        const episode = live.get(additional?.ratingKey ?? 'episode-1');
        if (episode?.Media) {
          episode.Media = episode.Media.filter((media) => media.id !== managedMediaId);
        }
      }
      if (loseArrManagedDeleteResponse) {
        loseArrManagedDeleteResponse = false;
        return Promise.reject(new TypeError('lost Sonarr file deletion response'));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.pathname === '/api/v3/command' && init?.method === 'POST') {
      const command = JSON.parse(String(init.body)) as { name?: string };
      sonarrRescanCount++;
      if (command.name === 'ManualImport' && rejectSonarrManualImportStatus !== null) {
        return Promise.resolve(
          new Response('manual import rejected', { status: rejectSonarrManualImportStatus }),
        );
      }
      if (sonarrRescanTargetPath) {
        sonarrManagedPath = sonarrRescanTargetPath;
        sonarrManagedFileId++;
        sonarrManagedFilePresent = true;
      }
      for (const episode of additionalSonarrEpisodes) {
        episode.managedPath = episode.retainedPath;
        episode.managedFileId++;
        episode.managedFilePresent = true;
      }
      sonarrRescanHook?.();
      if (loseArrRescanResponse) {
        loseArrRescanResponse = false;
        return Promise.reject(new TypeError('lost Sonarr rescan response'));
      }
      return Promise.resolve(Response.json({
        id: 81,
        name: command.name ?? 'ManualImport',
        status: 'queued',
      }));
    }
  }
  if (url.hostname === 'qbit') {
    qbitRequestCount++;
    if (url.pathname === '/api/v2/app/version') return Promise.resolve(new Response('5.1.2'));
    if (url.pathname === '/api/v2/torrents/info') {
      return Promise.resolve(Response.json(
        qbitPresent
          ? [{
            hash: torrentHash,
            name: 'Release',
            size: seasonPackQbit ? 40_000 : 100_000,
            content_path: seasonPackQbit ? '/downloads/release/old.mkv' : '/downloads/release',
            save_path: '/downloads',
            num_files: seasonPackMixed ? 2 : 1,
          }]
          : [],
      ));
    }
    if (url.pathname === '/api/v2/torrents/files') {
      return Promise.resolve(Response.json([{
        name: seasonPackQbit ? 'release/old.mkv' : 'release/movie.mkv',
        size: seasonPackQbit ? 40_000 : 100_000,
      }, ...(seasonPackMixed ? [{ name: 'release/unselected.mkv', size: 40_000 }] : [])]));
    }
    if (url.pathname === '/api/v2/torrents/delete' && init?.method === 'POST') {
      destinationOrder.push('qbittorrent');
      if (seasonPackQbit) versionDeleteOrder.push('qbit');
      qbitDeleteCount++;
      qbitPresent = false;
      if (loseQbitDeleteResponse) {
        loseQbitDeleteResponse = false;
        return Promise.reject(new TypeError('lost qBittorrent delete response'));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }
  }
  const seasonChildren = url.pathname.match(/^\/library\/metadata\/([^/]+)\/children$/);
  if (seasonChildren) {
    const seasonRatingKey = decodeURIComponent(seasonChildren[1]);
    const metadata = [...live.values()].filter((item) =>
      item.type === 'episode' && item.parentRatingKey === seasonRatingKey
    );
    return Promise.resolve(Response.json({
      MediaContainer: { Metadata: metadata, totalSize: metadata.length },
    }));
  }
  const allLeaves = url.pathname.match(/^\/library\/metadata\/([^/]+)\/allLeaves$/);
  if (allLeaves) {
    const showRatingKey = decodeURIComponent(allLeaves[1]);
    const metadata = [...live.values()].filter((item) =>
      item.type === 'episode' && item.grandparentRatingKey === showRatingKey
    );
    return Promise.resolve(Response.json({
      MediaContainer: { Metadata: metadata, totalSize: metadata.length },
    }));
  }
  const mediaDelete = url.pathname.match(/^\/library\/metadata\/([^/]+)\/media\/(\d+)$/);
  if (mediaDelete && init?.method === 'DELETE') {
    versionDeleteOrder.push('plex');
    plexMediaDeleteCount++;
    const ratingKey = decodeURIComponent(mediaDelete[1]);
    const mediaId = Number(mediaDelete[2]);
    const item = live.get(ratingKey);
    if (!item?.Media?.some((media) => media.id === mediaId)) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    if (failDeleteBeforeMutation) return Promise.reject(new TypeError('fetch failed'));
    item.Media = item.Media.filter((media) => media.id !== mediaId);
    if (monitorDriftAfterSelectedDelete) arrMonitored = true;
    if (loseDeleteResponse) return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(new Response(null, { status: 200 }));
  }
  const metadata = url.pathname.match(/^\/library\/metadata\/([^/]+)$/);
  if (metadata) {
    if (url.searchParams.get('includeOptionalElements') === 'Stream') {
      technicalDetailsRequestCount++;
    }
    const ratingKey = decodeURIComponent(metadata[1]);
    if (pendingPlexMediaRemoval?.ratingKey === ratingKey) {
      const pendingItem = live.get(ratingKey);
      if (pendingItem?.Media) {
        pendingItem.Media = pendingItem.Media.filter((media) =>
          media.id !== pendingPlexMediaRemoval!.mediaId
        );
      }
      pendingPlexMediaRemoval = null;
    }
    const item = live.get(ratingKey);
    if (init?.method === 'DELETE') {
      if (!item) return Promise.resolve(new Response(null, { status: 404 }));
      if (failDeleteBeforeMutation) return Promise.reject(new TypeError('fetch failed'));
      destinationOrder.push('plex');
      wholeDeleteOrder.push(ratingKey);
      live.delete(ratingKey);
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    if (exactMetadataFailureStatus !== null) {
      return Promise.resolve(new Response(null, { status: exactMetadataFailureStatus }));
    }
    return Promise.resolve(
      item
        ? Response.json({ MediaContainer: { Metadata: [item] } })
        : new Response(null, { status: 404 }),
    );
  }
  return Promise.resolve(new Response(null, { status: 404 }));
}) as typeof fetch;

withTransaction((client) => {
  client.prepare(
    "INSERT INTO servers (id, machine_identifier, name, url, access_token, last_connected_at) VALUES (1, 'machine-1', 'Test Plex', 'http://plex', 'token', 1)",
  ).run();
  client.prepare("INSERT INTO settings (id, client_id, active_server_id) VALUES (1, 'test', 1)")
    .run();
  client.prepare(
    "INSERT INTO libraries (server_id, key, title, type, synced_at) VALUES (1, 'movies', 'Movies', 'movie', 1)",
  ).run();
  client.prepare(
    "INSERT INTO libraries (server_id, key, title, type, synced_at) VALUES (1, 'shows', 'Shows', 'show', 1)",
  ).run();
});

function reset(): void {
  plexMachineIdentifier = 'machine-1';
  loseDeleteResponse = false;
  failDeleteBeforeMutation = false;
  plexMediaDeleteCount = 0;
  coordinatedRatingKey = null;
  arrPresent = false;
  arrDeleteCount = 0;
  destinationOrder.length = 0;
  loseArrRemovalResponse = false;
  radarrExclusion = null;
  arrManagedFilePresent = true;
  arrManagedFileId = 70;
  arrManagedFileSize = 100_000;
  arrExtraMovieFileId = null;
  arrRescanFileSize = 50_000;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrManagedMediaId = null;
  arrRescanTargetPath = null;
  restoreArrPathOnRescan = null;
  restoredArrPath = null;
  arrMoviePath = '/library/Coordinated';
  arrMonitored = true;
  arrMonitorMutationCount = 0;
  loseMonitorResponseAtMutation = null;
  rejectMonitorAtMutation = null;
  monitorDriftAfterSelectedDelete = false;
  monitorDriftAfterRestorationReads = null;
  monitorDriftAfterUnmonitoredEvidence = false;
  rejectMonitoringWrites = false;
  loseArrManagedDeleteResponse = false;
  loseArrMoviePathResponse = false;
  loseArrRescanResponse = false;
  rejectArrRescanStatus = null;
  arrManagedFileReads = 0;
  activatePlaybackOnManagedFileRead = null;
  changeArrOwnershipOnManagedFileRead = null;
  removePlexMediaOnManagedFileRead = null;
  pendingPlexMediaRemoval = null;
  activePlaybackRatingKey = null;
  activeSessionsHook = null;
  sonarrManagedFilePresent = true;
  sonarrManagedFileId = 10;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrManagedMediaId = null;
  sonarrRescanTargetPath = null;
  additionalSonarrEpisodes = [];
  rejectSonarrMonitoringEpisodeId = null;
  rejectSonarrManualImportPreflight = false;
  rejectSonarrManualImportStatus = null;
  sonarrManualImportSize = 40_000;
  sonarrRescanHook = null;
  sonarrRescanCount = 0;
  sonarrMonitorMutationCount = 0;
  sonarrMonitored = true;
  sonarrManagedFileShared = false;
  sonarrOldPathLingersAfterDelete = false;
  sonarrReportedVersion = '4.0.19.2979';
  sonarrUnavailable = false;
  sonarrHistoryUnavailable = false;
  sonarrActivityReadCount = 0;
  blockSonarrActivityAtRead = null;
  seasonPackQbit = false;
  seasonPackMixed = false;
  seasonPackForeignOwner = false;
  qbitPresent = false;
  qbitDeleteCount = 0;
  qbitRequestCount = 0;
  loseQbitDeleteResponse = false;
  fetchCount = 0;
  technicalDetailsRequestCount = 0;
  historyAccountId = null;
  reportedPlexLibraries = null;
  wholeDeleteOrder.length = 0;
  versionDeleteOrder.length = 0;
  live.clear();
  bulkMetadataOverrides.clear();
  exactMetadataFailureStatus = null;
  withTransaction((client) => {
    for (
      const table of [
        'media_version_reservations',
        'deletion_targets',
        'deletion_operations',
        'media_removals',
        'events',
        'sync_log',
        'torrent_delete_attempts',
        'download_file_delete_attempts',
        'arr_delete_attempts',
        'seerr_request_seasons',
        'seerr_requests',
        'seerr_instances',
        'item_media_versions',
        'episode_media_versions',
        'seasons',
        'items',
        'arr_library_mappings',
        'arr_path_mappings',
        'qbittorrent_path_mappings',
        'plex_path_mappings',
        'qbittorrent_instances',
        'arr_instances',
      ]
    ) client.exec(`DELETE FROM ${table}`);
  });
}

function addMovie(ratingKey: string, mediaIds = [11, 12], tmdbId: number | null = null): void {
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO items (server_id, rating_key, library_key, title, type, file_size, tmdb_id, updated_at) VALUES (1, ?, 'movies', ?, 'movie', 100, ?, 1)",
    ).run(ratingKey, `Movie ${ratingKey}`, tmdbId);
    for (const mediaId of mediaIds) {
      client.prepare(
        "INSERT INTO item_media_versions (server_id, media_id, item_rating_key, library_key, file_size, updated_at) VALUES (1, ?, ?, 'movies', 50, 1)",
      ).run(mediaId, ratingKey);
    }
  });
  live.set(ratingKey, {
    ratingKey,
    title: `Movie ${ratingKey}`,
    type: 'movie',
    librarySectionID: 'movies',
    Guid: tmdbId === null ? [] : [{ id: `tmdb://${tmdbId}` }],
    Media: mediaIds.map((id) => ({
      id,
      Part: [{ file: `/movies/${ratingKey}-${id}.mkv`, size: 50_000 }],
    })),
  });
}

function addQuickCleanupShow(ratingKey: string): void {
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO items (server_id, rating_key, library_key, title, type, added_at, file_size, updated_at) VALUES (1, ?, 'shows', ?, 'show', ?, 100, ?)",
    ).run(
      ratingKey,
      `Show ${ratingKey}`,
      Math.floor(Date.now() / 1000) - 366 * 86_400,
      Math.floor(Date.now() / 1000),
    );
  });
  live.set(ratingKey, {
    ratingKey,
    title: `Show ${ratingKey}`,
    type: 'show',
    librarySectionID: 'shows',
  });
  live.set(`${ratingKey}-episode`, {
    ratingKey: `${ratingKey}-episode`,
    title: 'Pilot',
    type: 'episode',
    librarySectionID: 'shows',
    grandparentRatingKey: ratingKey,
    parentRatingKey: `${ratingKey}-season`,
    parentIndex: 1,
    index: 1,
    Media: [{
      id: 9501,
      Part: [{ file: `/tv/${ratingKey}-9501.mkv`, size: 50_000 }],
    }],
  });
}

function addSmartCleanupMovie(ratingKey: string, persistDetails = true): void {
  addMovie(ratingKey, [11, 12]);
  if (persistDetails) {
    withTransaction((client) => {
      for (const [mediaId, bitrate] of [[11, 9_800], [12, 10_000]] as const) {
        client.prepare(
          `UPDATE item_media_versions
           SET video_resolution = '1080', width = 1920, height = 1080,
               duration = 7200000, bitrate = ?, video_codec = 'h264',
               video_profile = 'high', video_bit_depth = 8, video_dynamic_range = 'sdr',
               video_frame_rate = '24p', video_scan_type = 'progressive',
               container = 'mkv', audio_codec = 'aac', audio_channels = 2,
               audio_profile = 'lc', audio_streams_json = ?, subtitle_streams_json = '[]',
               stream_details_available = 1
           WHERE item_rating_key = ? AND media_id = ?`,
        ).run(
          bitrate,
          JSON.stringify([{
            codec: 'aac',
            language: 'eng',
            channels: 2,
            channelLayout: 'stereo',
            title: null,
            forced: false,
            default: true,
          }]),
          ratingKey,
          mediaId,
        );
      }
    });
  } else {
    withTransaction((client) => {
      for (const [mediaId, bitrate] of [[11, 9_800], [12, 10_000]] as const) {
        client.prepare(
          `UPDATE item_media_versions
           SET video_resolution = '1080', width = 1920, height = 1080,
               duration = 7200000, bitrate = ?, video_codec = 'h264',
               video_profile = 'high', video_dynamic_range = 'sdr',
               video_frame_rate = '24p', container = 'mkv',
               audio_codec = 'aac', audio_channels = 2, audio_profile = 'lc',
               stream_details_available = 0
           WHERE item_rating_key = ? AND media_id = ?`,
        ).run(bitrate, ratingKey, mediaId);
      }
    });
  }
  live.get(ratingKey)!.Media = [
    {
      id: 11,
      videoResolution: '1080',
      width: 1920,
      height: 1080,
      duration: 7200000,
      bitrate: 9_800,
      videoCodec: 'h264',
      videoProfile: 'high',
      videoDynamicRange: 'sdr',
      videoFrameRate: '24p',
      container: 'mkv',
      audioCodec: 'aac',
      audioChannels: 2,
      audioProfile: 'lc',
      Part: [{
        file: `/movies/${ratingKey}-11.mkv`,
        size: 50_000,
        Stream: [
          { streamType: 1, bitDepth: 8, scanType: 'progressive' },
          {
            streamType: 2,
            codec: 'aac',
            languageCode: 'eng',
            channels: 2,
            channelLayout: 'stereo',
            default: true,
          },
        ],
      }],
    },
    {
      id: 12,
      videoResolution: '1080',
      width: 1920,
      height: 1080,
      duration: 7200000,
      bitrate: 10_000,
      videoCodec: 'h264',
      videoProfile: 'high',
      videoDynamicRange: 'sdr',
      videoFrameRate: '24p',
      container: 'mkv',
      audioCodec: 'aac',
      audioChannels: 2,
      audioProfile: 'lc',
      Part: [{
        file: `/movies/${ratingKey}-12.mkv`,
        size: 50_000,
        Stream: [
          { streamType: 1, bitDepth: 8, scanType: 'progressive' },
          {
            streamType: 2,
            codec: 'aac',
            languageCode: 'eng',
            channels: 2,
            channelLayout: 'stereo',
            default: true,
          },
        ],
      }],
    },
  ];
}

function addManualSeasonEpisode(
  showRatingKey: string,
  seasonRatingKey: string,
  episodeRatingKey: string,
  episodeIndex: number,
  mediaIds: readonly number[],
): void {
  withTransaction((client) => {
    client.prepare(
      "INSERT OR IGNORE INTO items (server_id, rating_key, library_key, title, type, added_at, file_size, updated_at) VALUES (1, ?, 'shows', ?, 'show', 1, 100, 1)",
    ).run(showRatingKey, `Show ${showRatingKey}`);
    client.prepare(
      "INSERT OR IGNORE INTO seasons (server_id, rating_key, show_rating_key, library_key, season_index, title, file_size, updated_at) VALUES (1, ?, ?, 'shows', 1, 'Season 1', 100, 1)",
    ).run(seasonRatingKey, showRatingKey);
    const insert = client.prepare(
      `INSERT INTO episode_media_versions
       (server_id, media_id, episode_rating_key, season_rating_key, show_rating_key,
        library_key, episode_title, episode_index, season_index, file_size,
        video_resolution, bitrate, video_codec, container, updated_at)
       VALUES (1, ?, ?, ?, ?, 'shows', ?, ?, 1, ?, ?, ?, 'h264', 'mkv', 1)`,
    );
    for (const [index, mediaId] of mediaIds.entries()) {
      insert.run(
        mediaId,
        episodeRatingKey,
        seasonRatingKey,
        showRatingKey,
        `Episode ${episodeIndex}`,
        episodeIndex,
        index === 0 ? 40 : 80,
        index === 0 ? '720' : '1080',
        index === 0 ? 2_000 : 8_000,
      );
    }
  });
  live.set(showRatingKey, {
    ratingKey: showRatingKey,
    title: `Show ${showRatingKey}`,
    type: 'show',
    librarySectionID: 'shows',
  });
  live.set(episodeRatingKey, {
    ratingKey: episodeRatingKey,
    title: `Episode ${episodeIndex}`,
    type: 'episode',
    librarySectionID: 'shows',
    grandparentRatingKey: showRatingKey,
    parentRatingKey: seasonRatingKey,
    parentIndex: 1,
    index: episodeIndex,
    Media: mediaIds.map((id, index) => ({
      id,
      videoResolution: index === 0 ? '720' : '1080',
      width: index === 0 ? 1280 : 1920,
      height: index === 0 ? 720 : 1080,
      duration: 3_600_000,
      bitrate: index === 0 ? 2_000 : 8_000,
      videoCodec: 'h264',
      videoProfile: 'high',
      videoDynamicRange: 'sdr',
      videoFrameRate: '24p',
      container: 'mkv',
      audioCodec: 'aac',
      audioChannels: 2,
      audioProfile: 'lc',
      Part: [{
        file: `/tv/${showRatingKey}-${episodeRatingKey}-${id}.mkv`,
        size: index === 0 ? 40_000 : 80_000,
        Stream: [
          { streamType: 1, bitDepth: 8, scanType: 'progressive' },
          {
            streamType: 2,
            codec: 'aac',
            languageCode: 'eng',
            channels: 2,
            channelLayout: 'stereo',
            default: true,
          },
        ],
      }],
    })),
  });
}

function configureRadarr(withQbit = false): void {
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO arr_instances (id, server_id, type, name, url, api_key, created_at, updated_at) VALUES (1, 1, 'radarr', 'Radarr', 'http://radarr', 'key', 1, 1)",
    ).run();
    client.prepare(
      "INSERT INTO arr_library_mappings (server_id, library_key, arr_instance_id, add_import_exclusion) VALUES (1, 'movies', 1, 1)",
    ).run();
    if (withQbit) {
      client.prepare(
        "INSERT INTO qbittorrent_instances (id, server_id, name, url, username, password, created_at, updated_at) VALUES (1, 1, 'qBittorrent', 'http://qbit', '', '', 1, 1)",
      ).run();
    }
  });
}

function configureSonarr(withQbit = false): void {
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO arr_instances (id, server_id, type, name, url, api_key, created_at, updated_at) VALUES (2, 1, 'sonarr', 'Sonarr', 'http://sonarr', 'key', 1, 1)",
    ).run();
    client.prepare(
      "INSERT INTO arr_library_mappings (server_id, library_key, arr_instance_id, add_import_exclusion) VALUES (1, 'shows', 2, 0)",
    ).run();
    if (withQbit) {
      client.prepare(
        "INSERT INTO qbittorrent_instances (id, server_id, name, url, username, password, created_at, updated_at) VALUES (1, 1, 'qBittorrent', 'http://qbit', '', '', 1, 1)",
      ).run();
    }
  });
}

function addEpisode(): void {
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO items (server_id, rating_key, library_key, title, type, file_size, tvdb_id, updated_at) VALUES (1, 'show-1', 'shows', 'Example Show', 'show', 100, 20, 1)",
    ).run();
    client.prepare(
      "INSERT INTO seasons (server_id, rating_key, show_rating_key, library_key, season_index, title, file_size, updated_at) VALUES (1, 'season-1', 'show-1', 'shows', 1, 'Season 1', 100, 1)",
    ).run();
    for (const mediaId of [21, 22]) {
      client.prepare(
        "INSERT INTO episode_media_versions (server_id, media_id, episode_rating_key, season_rating_key, show_rating_key, library_key, episode_title, episode_index, season_index, file_size, updated_at) VALUES (1, ?, 'episode-1', 'season-1', 'show-1', 'shows', 'Pilot', 1, 1, 40, 1)",
      ).run(mediaId);
    }
  });
  live.set('show-1', {
    ratingKey: 'show-1',
    title: 'Example Show',
    type: 'show',
    librarySectionID: 'shows',
    Guid: [{ id: 'tvdb://20' }],
  });
  live.set('episode-1', {
    ratingKey: 'episode-1',
    title: 'Pilot',
    type: 'episode',
    librarySectionID: 'shows',
    grandparentRatingKey: 'show-1',
    parentRatingKey: 'season-1',
    parentIndex: 1,
    index: 1,
    Media: [21, 22].map((id) => ({
      id,
      Part: [{ file: `/tv/show-1-${id}.mkv`, size: 40_000 }],
    })),
  });
}

function addAdditionalSonarrEpisode(
  episodeNumber: number,
  managedMediaId: number,
  retainedMediaId: number,
): AdditionalSonarrEpisode {
  const ratingKey = `episode-${episodeNumber}`;
  const managedPath = `/tv/Show/Season 01/episode-${episodeNumber}-old.mkv`;
  const retainedPath = `/tv/Show/Season 01/episode-${episodeNumber}-retained.mkv`;
  const state: AdditionalSonarrEpisode = {
    ratingKey,
    episodeId: 9 + episodeNumber,
    episodeNumber,
    managedFileId: 10 + episodeNumber * 10,
    managedPath,
    managedMediaId,
    retainedPath,
    retainedMediaId,
    monitored: true,
    managedFilePresent: true,
  };
  additionalSonarrEpisodes.push(state);
  withTransaction((client) => {
    for (const mediaId of [managedMediaId, retainedMediaId]) {
      client.prepare(
        "INSERT INTO episode_media_versions (server_id, media_id, episode_rating_key, season_rating_key, show_rating_key, library_key, episode_title, episode_index, season_index, file_size, updated_at) VALUES (1, ?, ?, 'season-1', 'show-1', 'shows', ?, ?, 1, 40, 1)",
      ).run(mediaId, ratingKey, `Episode ${episodeNumber}`, episodeNumber);
    }
  });
  live.set(ratingKey, {
    ratingKey,
    title: `Episode ${episodeNumber}`,
    type: 'episode',
    librarySectionID: 'shows',
    grandparentRatingKey: 'show-1',
    parentRatingKey: 'season-1',
    parentIndex: 1,
    index: episodeNumber,
    Media: [
      { id: managedMediaId, Part: [{ file: managedPath, size: 40_000 }] },
      { id: retainedMediaId, Part: [{ file: retainedPath, size: 40_000 }] },
    ],
  });
  return state;
}

async function enqueueMovieReassignment(
  ratingKey: string,
  fromMediaId: number,
): Promise<string> {
  const result = await enqueueDeletionOperation({
    clientRequestId: crypto.randomUUID(),
    serverId: 1,
    libraryKey: 'movies',
    kind: 'movie_version',
    payload: {
      ratingKey,
      mediaIds: [fromMediaId],
      cleanupMediaIds: [],
    },
    targets: [{
      kind: 'movie_version',
      key: `${ratingKey}:${fromMediaId}`,
      title: `Movie ${ratingKey}`,
      logicalSize: 50,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey: 'movies',
        ratingKey,
        mediaId: fromMediaId,
        selectedMediaIds: [fromMediaId],
        operationMediaIds: [fromMediaId],
        title: `Movie ${ratingKey}`,
        type: 'movie',
        tmdbId: 10,
        tvdbId: null,
        fileSize: 50,
        videoResolution: null,
        bitrate: null,
        videoCodec: null,
        container: null,
        cleanupDownloads: false,
      },
      reservation: {
        mediaKind: 'movie',
        mediaId: fromMediaId,
        ratingKey,
      },
    }],
  });
  return result.operationId;
}

async function enqueueRadarrRemovalFallback(ratingKey: string): Promise<string> {
  const mappingIdentity = '{"addImportExclusion":true,"pathMappings":[]}';
  const planFingerprint = `remove-radarr:${ratingKey}`;
  const selectedPath = '/library/Coordinated/movie.mkv';
  const retainedPath = '/downloads/retained/movie.mkv';
  const result = await enqueueDeletionOperation({
    clientRequestId: crypto.randomUUID(),
    serverId: 1,
    libraryKey: 'movies',
    kind: 'movie_version',
    payload: {
      ratingKey,
      mediaIds: [11],
      cleanupMediaIds: [],
      planFingerprint,
      allowRadarrMovieRemoval: true,
    },
    targets: [{
      kind: 'movie_version',
      key: `${ratingKey}:11`,
      title: `Movie ${ratingKey}`,
      logicalSize: 50,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey: 'movies',
        ratingKey,
        mediaId: 11,
        selectedMediaIds: [11],
        operationMediaIds: [11],
        title: `Movie ${ratingKey}`,
        type: 'movie',
        tmdbId: 10,
        tvdbId: null,
        fileSize: 50,
        videoResolution: null,
        bitrate: null,
        videoCodec: null,
        container: null,
        cleanupDownloads: false,
        arrReassignmentMappings: [{
          instanceId: 1,
          instanceType: 'radarr',
          instanceUrl: 'http://radarr',
          configurationUpdatedAt: 1,
          mappingIdentity,
        }],
        arrOwnerships: [{
          instanceId: 1,
          recordId: 7,
          episodeId: null,
          managedFileId: 70,
          managedPath: selectedPath,
          managedMediaId: 11,
        }],
        radarrRemovalFallback: {
          mode: 'remove_from_radarr',
          arrInstanceId: 1,
          arrConfigurationUpdatedAt: 1,
          arrMappingIdentity: mappingIdentity,
          movieId: 7,
          tmdbId: 10,
          movieTitle: 'Coordinated movie',
          movieYear: 2000,
          selectedMediaId: 11,
          retainedMediaId: 12,
          selectedPlexPath: selectedPath,
          managedPath: selectedPath,
          retainedPlexPath: retainedPath,
          retainedFileSize: 50_000,
          originalMoviePath: '/library/Coordinated',
          originalMonitored: true,
          createImportExclusion: true,
          deleteFiles: false,
          addImportExclusion: true,
          userAuthorizedRadarrRemoval: true,
          planFingerprint,
        },
      },
      reservation: { mediaKind: 'movie', mediaId: 11, ratingKey },
      radarrReservation: {
        arrInstanceId: 1,
        movieId: 7,
        planFingerprint,
      },
    }],
  });
  return result.operationId;
}

async function prepareGuidedMovieRelocation(): Promise<{
  operationId: string;
  targetId: number;
  guidanceId: string;
}> {
  configureRadarr();
  addMovie('guided-relocation', [11, 12], 10);
  coordinatedRatingKey = 'guided-relocation';
  arrPresent = true;
  arrManagedMediaId = 11;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrManagedFileSize = 50_000;
  live.get('guided-relocation')!.Media = [
    { id: 11, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 12, Part: [{ file: '/library/retained.mkv', size: 50_000 }] },
  ];

  const operationId = await enqueueMovieReassignment('guided-relocation', 11);
  const guidance = createRelocationGuidance({
    service: 'radarr',
    mediaType: 'movie',
    reason: 'retained_parent_mismatch',
    selectedMediaId: 11,
    selectedPlexPath: arrManagedPath,
    selectedArrPath: arrManagedPath,
    retainedMediaId: 12,
    retainedPlexPath: '/library/retained.mkv',
    retainedFileSize: 50_000,
    managedDirectoryPath: '/library/Coordinated',
    sourceArrPath: '/library/retained.mkv',
    destinationArrPath: '/library/Coordinated/retained.mkv',
    destinationPlexPath: '/library/Coordinated/retained.mkv',
    arrInstanceId: 1,
    arrInstanceName: 'Radarr',
    arrRecordId: 7,
    arrManagedFileId,
    mappingIdentity: '{"addImportExclusion":true,"pathMappings":[]}',
  });
  const targetId = withTransaction((client) => {
    const durable = client.prepare(
      'SELECT id, snapshot FROM deletion_targets WHERE operation_id = ?',
    ).value<[number, string]>(operationId)!;
    const snapshot = JSON.parse(durable[1]);
    snapshot.relocationGuidance = guidance;
    client.prepare(
      "UPDATE deletion_targets SET snapshot = ?, status = 'needs_attention', phase = 'validating', error = ?, updated_at = ? WHERE id = ?",
    ).run(
      JSON.stringify(snapshot),
      relocationManualReason(guidance),
      guidance.observedAt,
      durable[0],
    );
    refreshDeletionOperation(client, operationId);
    return durable[0];
  });
  const operation = getDeletionOperation(operationId, 1)!;
  const target = (operation.targets as Array<Record<string, unknown>>)[0]!;
  const exposed = target.relocationGuidance as { guidanceId?: unknown } | undefined;
  assertEquals(typeof exposed?.guidanceId, 'string', String(target.error));
  return {
    operationId,
    targetId,
    guidanceId: exposed!.guidanceId as string,
  };
}

Deno.test('relocation snapshot canonicalization sorts objects but preserves array order', () => {
  assertEquals(
    canonicalJson({ z: [{ b: 2, a: 1 }, 3], a: true }),
    '{"a":true,"z":[{"a":1,"b":2},3]}',
  );
  assertThrows(
    () => canonicalJson({ invalid: Number.POSITIVE_INFINITY }),
    Error,
    'invalid number',
  );
});

async function enqueueEpisodeReassignment(
  fromMediaId: number,
): Promise<string> {
  const result = await enqueueDeletionOperation({
    clientRequestId: crypto.randomUUID(),
    serverId: 1,
    libraryKey: 'shows',
    kind: 'episode_version',
    payload: {
      ratingKey: 'episode-1',
      mediaIds: [fromMediaId],
      cleanupMediaIds: [],
    },
    targets: [{
      kind: 'episode_version',
      key: `episode-1:${fromMediaId}`,
      title: 'Example Show — Pilot',
      logicalSize: 40,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey: 'shows',
        ratingKey: 'episode-1',
        mediaId: fromMediaId,
        selectedMediaIds: [fromMediaId],
        operationMediaIds: [fromMediaId],
        title: 'Example Show — Pilot',
        type: 'episode',
        tmdbId: null,
        tvdbId: 20,
        fileSize: 40,
        videoResolution: null,
        bitrate: null,
        videoCodec: null,
        container: null,
        showTitle: 'Example Show',
        episodeTitle: 'Pilot',
        showRatingKey: 'show-1',
        seasonRatingKey: 'season-1',
        seasonIndex: 1,
        episodeIndex: 1,
        cleanupDownloads: false,
      },
      reservation: {
        mediaKind: 'episode',
        mediaId: fromMediaId,
        ratingKey: 'episode-1',
      },
    }],
  });
  return result.operationId;
}

async function enqueueVersion(
  ratingKey: string,
  mediaId = 11,
  tmdbId: number | null = null,
  snapshotOverrides: Record<string, unknown> = {},
): Promise<string> {
  const result = await enqueueDeletionOperation({
    clientRequestId: crypto.randomUUID(),
    serverId: 1,
    libraryKey: 'movies',
    kind: 'movie_version',
    payload: { ratingKey, mediaIds: [mediaId] },
    targets: [{
      kind: 'movie_version',
      key: `${ratingKey}:${mediaId}`,
      title: `Movie ${ratingKey}`,
      logicalSize: 50,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey: 'movies',
        ratingKey,
        mediaId,
        selectedMediaIds: [mediaId],
        title: `Movie ${ratingKey}`,
        type: 'movie',
        tmdbId,
        tvdbId: null,
        fileSize: 50,
        videoResolution: null,
        bitrate: null,
        videoCodec: null,
        container: null,
        ...snapshotOverrides,
      },
      reservation: { mediaKind: 'movie', mediaId, ratingKey },
    }],
  });
  return result.operationId;
}

async function enqueueWhole(ratingKey: string): Promise<string> {
  const result = await enqueueDeletionOperation({
    clientRequestId: crypto.randomUUID(),
    serverId: 1,
    libraryKey: 'movies',
    kind: 'whole_item',
    payload: { ratingKey, mode: 'plex-only' },
    targets: [{
      kind: 'whole_item',
      key: ratingKey,
      title: `Movie ${ratingKey}`,
      logicalSize: 100,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey: 'movies',
        ratingKey,
        title: `Movie ${ratingKey}`,
        type: 'movie',
        tmdbId: null,
        tvdbId: null,
        mode: 'plex-only',
      },
    }],
  });
  return result.operationId;
}

async function enqueueCoordinated(
  ratingKeys: string[],
  cleanupDownloads = false,
): Promise<string> {
  return await enqueueWholeDestinations(
    ratingKeys,
    new Set(ratingKeys),
    new Set(cleanupDownloads ? ratingKeys : []),
  );
}

async function enqueueWholeDestinations(
  ratingKeys: string[],
  coordinatedKeys: ReadonlySet<string>,
  cleanupKeys: ReadonlySet<string>,
): Promise<string> {
  const result = await enqueueDeletionOperation({
    clientRequestId: crypto.randomUUID(),
    serverId: 1,
    libraryKey: 'movies',
    kind: 'whole_item',
    payload: {
      ratingKeys,
      coordinatedRatingKeys: [...coordinatedKeys].sort(),
      cleanupDownloadRatingKeys: [...cleanupKeys].sort(),
    },
    targets: ratingKeys.map((ratingKey) => ({
      kind: 'whole_item' as const,
      key: ratingKey,
      title: `Movie ${ratingKey}`,
      logicalSize: 100,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey: 'movies',
        ratingKey,
        title: `Movie ${ratingKey}`,
        type: 'movie',
        tmdbId: 10,
        tvdbId: null,
        mode: coordinatedKeys.has(ratingKey) ? 'coordinated' : 'plex-only',
        cleanupDownloads: cleanupKeys.has(ratingKey),
        selectedRatingKeys: ratingKeys,
        cleanupDownloadRatingKeys: [...cleanupKeys].sort(),
      },
    })),
  });
  return result.operationId;
}

async function enqueueEpisode(): Promise<string> {
  const result = await enqueueDeletionOperation({
    clientRequestId: crypto.randomUUID(),
    serverId: 1,
    libraryKey: 'shows',
    kind: 'episode_version',
    payload: { ratingKey: 'episode-1', mediaIds: [21] },
    targets: [{
      kind: 'episode_version',
      key: 'episode-1:21',
      title: 'Example Show — Pilot',
      logicalSize: 40,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey: 'shows',
        ratingKey: 'episode-1',
        mediaId: 21,
        selectedMediaIds: [21],
        title: 'Example Show — Pilot',
        type: 'episode',
        tmdbId: null,
        tvdbId: 20,
        fileSize: 40,
        videoResolution: null,
        bitrate: null,
        videoCodec: null,
        container: null,
        showTitle: 'Example Show',
        episodeTitle: 'Pilot',
        showRatingKey: 'show-1',
        seasonRatingKey: 'season-1',
        seasonIndex: 1,
        episodeIndex: 1,
      },
      reservation: { mediaKind: 'episode', mediaId: 21, ratingKey: 'episode-1' },
    }],
  });
  return result.operationId;
}

async function settle(): Promise<void> {
  await runDeletionWorkerOnceForTest();
  await Promise.resolve();
}

function makeRetryReady(operationId: string): void {
  withTransaction((client) =>
    client.prepare(
      "UPDATE deletion_targets SET next_retry_at = 0 WHERE operation_id = ? AND status = 'waiting_retry'",
    ).run(operationId)
  );
}

Deno.test('media-version endpoints reject client-controlled Arr policy fields', async () => {
  reset();
  const requests = [
    {
      path: '/api/duplicates/movies/crafted/media',
      body: {
        clientRequestId: crypto.randomUUID(),
        mediaIds: [11],
        arrMediaIds: [11],
      },
    },
    {
      path: '/api/duplicates/episodes/crafted/media/21',
      body: {
        clientRequestId: crypto.randomUUID(),
        deleteFromArr: false,
      },
    },
  ];

  for (const request of requests) {
    const response = await app.request(request.path, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
    });
    assertEquals(response.status, 400);
    assertEquals(await response.json(), {
      error: 'Arr handling for media versions is determined by the backend',
    });
  }
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT COUNT(*) FROM deletion_operations').value<[number]>()?.[0]
    ),
    0,
  );
});

Deno.test('stale quick cleanup revalidates eligibility after checking active sessions', async () => {
  reset();
  const now = Math.floor(Date.now() / 1000);
  const old = now - 366 * 86_400;
  withTransaction((client) => {
    client.prepare(
      "UPDATE libraries SET history_synced_at = ? WHERE server_id = 1 AND key = 'movies'",
    ).run(now);
    client.prepare(
      "INSERT INTO items (server_id, rating_key, library_key, title, type, added_at, file_size, updated_at) VALUES (1, 'stale-race', 'movies', 'Stale race', 'movie', ?, 100, ?)",
    ).run(old, now);
  });
  activeSessionsHook = () => {
    activeSessionsHook = null;
    withTransaction((client) => {
      const statement = client.prepare(
        "INSERT INTO item_media_versions (server_id, media_id, item_rating_key, library_key, file_size, updated_at) VALUES (1, ?, 'stale-race', 'movies', 50, ?)",
      );
      statement.run(9101, now);
      statement.run(9102, now);
    });
  };

  const response = await app.request('/api/libraries/movies/items', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: crypto.randomUUID(),
      ratingKeys: ['stale-race'],
      coordinatedRatingKeys: [],
      quickCleanupThresholdDays: 365,
    }),
  });

  assertEquals(response.status, 409);
  assertEquals(
    await response.json(),
    { error: 'the quick cleanup plan changed; analyze stale items again before deleting' },
  );
});

Deno.test('stale quick cleanup rejects a live movie that gained another version', async () => {
  reset();
  const now = Math.floor(Date.now() / 1000);
  const old = now - 366 * 86_400;
  addMovie('stale-live-duplicate', [9301]);
  withTransaction((client) => {
    client.prepare(
      "UPDATE libraries SET history_synced_at = ? WHERE server_id = 1 AND key = 'movies'",
    ).run(now);
    client.prepare(
      "UPDATE items SET added_at = ? WHERE server_id = 1 AND rating_key = 'stale-live-duplicate'",
    ).run(old);
  });
  live.get('stale-live-duplicate')!.Media!.push({
    id: 9302,
    Part: [{ file: '/movies/stale-live-duplicate-9302.mkv', size: 50_000 }],
  });

  const response = await app.request('/api/libraries/movies/items', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: crypto.randomUUID(),
      ratingKeys: ['stale-live-duplicate'],
      coordinatedRatingKeys: [],
      quickCleanupThresholdDays: 365,
    }),
  });

  assertEquals(response.status, 409);
  assertEquals(
    await response.json(),
    {
      error:
        'a selected title now has multiple versions; analyze stale items again before deleting',
    },
  );
});

Deno.test('stale quick cleanup rejects a show that gained a duplicate episode', async () => {
  reset();
  const now = Math.floor(Date.now() / 1000);
  addQuickCleanupShow('stale-show-live-duplicate');
  withTransaction((client) => {
    client.prepare(
      "UPDATE libraries SET history_synced_at = ? WHERE server_id = 1 AND key = 'shows'",
    ).run(now);
  });
  live.get('stale-show-live-duplicate-episode')!.Media!.push({
    id: 9502,
    Part: [{ file: '/tv/stale-show-live-duplicate-episode-9502.mkv', size: 50_000 }],
  });

  const response = await app.request('/api/libraries/shows/items', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: crypto.randomUUID(),
      ratingKeys: ['stale-show-live-duplicate'],
      coordinatedRatingKeys: [],
      quickCleanupThresholdDays: 365,
    }),
  });

  assertEquals(response.status, 409);
  assertEquals(
    await response.json(),
    {
      error:
        'a selected title now has multiple versions; analyze stale items again before deleting',
    },
  );
});

Deno.test('stale quick cleanup rejects active playback before enqueue', async () => {
  reset();
  const now = Math.floor(Date.now() / 1000);
  const old = now - 366 * 86_400;
  addMovie('stale-playing', [9601]);
  withTransaction((client) => {
    client.prepare(
      "UPDATE libraries SET history_synced_at = ? WHERE server_id = 1 AND key = 'movies'",
    ).run(now);
    client.prepare(
      "UPDATE items SET added_at = ? WHERE server_id = 1 AND rating_key = 'stale-playing'",
    ).run(old);
  });
  activePlaybackRatingKey = 'stale-playing';

  const response = await app.request('/api/libraries/movies/items', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: crypto.randomUUID(),
      ratingKeys: ['stale-playing'],
      coordinatedRatingKeys: [],
      quickCleanupThresholdDays: 365,
    }),
  });

  assertEquals(response.status, 409);
  assertEquals(
    await response.json(),
    {
      error: 'a selected title started playing; analyze stale items again after playback stops',
    },
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT COUNT(*) FROM deletion_operations').value<[number]>()?.[0]
    ),
    0,
  );
  assertEquals(live.has('stale-playing'), true);
});

Deno.test(
  'stale quick cleanup revalidates material eligibility during durable execution',
  async () => {
    reset();
    const now = Math.floor(Date.now() / 1000);
    const old = now - 366 * 86_400;
    addMovie('stale-durable', [9201]);
    withTransaction((client) => {
      client.prepare(
        "UPDATE libraries SET history_synced_at = ? WHERE server_id = 1 AND key = 'movies'",
      ).run(now);
      client.prepare(
        "UPDATE items SET added_at = ? WHERE server_id = 1 AND rating_key = 'stale-durable'",
      ).run(old);
    });

    const response = await app.request('/api/libraries/movies/items', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientRequestId: crypto.randomUUID(),
        ratingKeys: ['stale-durable'],
        coordinatedRatingKeys: [],
        quickCleanupThresholdDays: 365,
      }),
    });
    assertEquals(response.status, 202);
    const { operationId } = await response.json() as { operationId: string };

    withTransaction((client) => {
      client.prepare(
        "INSERT INTO item_media_versions (server_id, media_id, item_rating_key, library_key, file_size, updated_at) VALUES (1, 9202, 'stale-durable', 'movies', 50, ?)",
      ).run(now);
    });
    await settle();

    assertEquals(getDeletionOperation(operationId, 1)?.status, 'needs_attention');
    assertEquals(live.has('stale-durable'), true);
    assertEquals(
      withTransaction((client) =>
        client.prepare(
          "SELECT COUNT(*) FROM items WHERE server_id = 1 AND rating_key = 'stale-durable'",
        ).value<[number]>()?.[0]
      ),
      1,
    );
  },
);

Deno.test(
  'stale quick cleanup rejects watch-history and request changes after enqueue',
  async () => {
    const cases = [
      {
        name: 'recent watch',
        ratingKey: 'stale-watched-after-enqueue',
        mediaId: 9701,
        mutate(ratingKey: string, now: number) {
          withTransaction((client) => {
            client.prepare(
              'UPDATE items SET last_viewed_at = ? WHERE server_id = 1 AND rating_key = ?',
            ).run(now, ratingKey);
          });
        },
      },
      {
        name: 'incomplete history',
        ratingKey: 'stale-history-reset-after-enqueue',
        mediaId: 9702,
        mutate(_ratingKey: string, _now: number) {
          withTransaction((client) => {
            client.prepare(
              "UPDATE libraries SET history_synced_at = NULL WHERE server_id = 1 AND key = 'movies'",
            ).run();
          });
        },
      },
      {
        name: 'recent approved request',
        ratingKey: 'stale-requested-after-enqueue',
        mediaId: 9703,
        mutate(ratingKey: string, now: number) {
          withTransaction((client) => {
            client.prepare(
              "INSERT INTO seerr_instances (id, server_id, name, url, api_key, created_at, updated_at) VALUES (1, 1, 'Seerr', 'http://seerr', 'key', ?, ?)",
            ).run(now, now);
            client.prepare(
              `INSERT INTO seerr_requests
                (server_id, seerr_instance_id, request_id, rating_key, media_type,
                 request_status, media_status, requested_at, availability_estimated, synced_at)
               VALUES (1, 1, 1, ?, 'movie', 2, 5, ?, 0, ?)`,
            ).run(ratingKey, now, now);
          });
        },
      },
    ] as const;

    for (const testCase of cases) {
      reset();
      const now = Math.floor(Date.now() / 1000);
      const old = now - 366 * 86_400;
      addMovie(testCase.ratingKey, [testCase.mediaId]);
      withTransaction((client) => {
        client.prepare(
          "UPDATE libraries SET history_synced_at = ? WHERE server_id = 1 AND key = 'movies'",
        ).run(now);
        client.prepare(
          'UPDATE items SET added_at = ? WHERE server_id = 1 AND rating_key = ?',
        ).run(old, testCase.ratingKey);
      });

      const response = await app.request('/api/libraries/movies/items', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientRequestId: crypto.randomUUID(),
          ratingKeys: [testCase.ratingKey],
          coordinatedRatingKeys: [],
          quickCleanupThresholdDays: 365,
        }),
      });
      assertEquals(response.status, 202, testCase.name);
      const { operationId } = await response.json() as { operationId: string };

      testCase.mutate(testCase.ratingKey, now);
      await settle();

      assertEquals(
        getDeletionOperation(operationId, 1)?.status,
        'needs_attention',
        testCase.name,
      );
      assertEquals(live.has(testCase.ratingKey), true, testCase.name);
      assertEquals(
        withTransaction((client) =>
          client.prepare(
            'SELECT COUNT(*) FROM items WHERE server_id = 1 AND rating_key = ?',
          ).value<[number]>(testCase.ratingKey)?.[0]
        ),
        1,
        testCase.name,
      );
    }
  },
);

Deno.test(
  'stale quick cleanup rejects a show duplicate added after enqueue',
  async () => {
    reset();
    const now = Math.floor(Date.now() / 1000);
    addQuickCleanupShow('stale-show-durable');
    withTransaction((client) => {
      client.prepare(
        "UPDATE libraries SET history_synced_at = ? WHERE server_id = 1 AND key = 'shows'",
      ).run(now);
    });

    const response = await app.request('/api/libraries/shows/items', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientRequestId: crypto.randomUUID(),
        ratingKeys: ['stale-show-durable'],
        coordinatedRatingKeys: [],
        quickCleanupThresholdDays: 365,
      }),
    });
    assertEquals(response.status, 202);
    const { operationId } = await response.json() as { operationId: string };

    live.get('stale-show-durable-episode')!.Media!.push({
      id: 9502,
      Part: [{ file: '/tv/stale-show-durable-episode-9502.mkv', size: 50_000 }],
    });
    await settle();

    assertEquals(getDeletionOperation(operationId, 1)?.status, 'needs_attention');
    assertEquals(live.has('stale-show-durable'), true);
    assertEquals(
      withTransaction((client) =>
        client.prepare(
          "SELECT COUNT(*) FROM items WHERE server_id = 1 AND rating_key = 'stale-show-durable'",
        ).value<[number]>()?.[0]
      ),
      1,
    );
  },
);

Deno.test(
  'stale quick cleanup rejects a live movie version added after enqueue',
  async () => {
    reset();
    const now = Math.floor(Date.now() / 1000);
    const old = now - 366 * 86_400;
    addMovie('stale-live-durable', [9401]);
    withTransaction((client) => {
      client.prepare(
        "UPDATE libraries SET history_synced_at = ? WHERE server_id = 1 AND key = 'movies'",
      ).run(now);
      client.prepare(
        "UPDATE items SET added_at = ? WHERE server_id = 1 AND rating_key = 'stale-live-durable'",
      ).run(old);
    });

    const response = await app.request('/api/libraries/movies/items', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientRequestId: crypto.randomUUID(),
        ratingKeys: ['stale-live-durable'],
        coordinatedRatingKeys: [],
        quickCleanupThresholdDays: 365,
      }),
    });
    assertEquals(response.status, 202);
    const { operationId } = await response.json() as { operationId: string };

    live.get('stale-live-durable')!.Media!.push({
      id: 9402,
      Part: [{ file: '/movies/stale-live-durable-9402.mkv', size: 50_000 }],
    });
    await settle();

    assertEquals(getDeletionOperation(operationId, 1)?.status, 'needs_attention');
    assertEquals(live.has('stale-live-durable'), true);
    assertEquals(
      withTransaction((client) =>
        client.prepare(
          "SELECT COUNT(*) FROM items WHERE server_id = 1 AND rating_key = 'stale-live-durable'",
        ).value<[number]>()?.[0]
      ),
      1,
    );
  },
);

Deno.test('deletion worker converges direct Plex version deletion atomically', async () => {
  reset();
  addMovie('movie-ok');
  const operationId = await enqueueVersion('movie-ok');
  await settle();
  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM item_media_versions WHERE server_id = 1 AND item_rating_key = ?',
      ).value<[number]>('movie-ok')?.[0]
    ),
    1,
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM media_version_reservations WHERE operation_id = ?',
      ).value<[number]>(operationId)?.[0]
    ),
    0,
  );
});

Deno.test('whole-item deletion keeps its projection until Plex absence is confirmed', async () => {
  reset();
  addMovie('whole-ok');
  const operationId = await enqueueWhole('whole-ok');
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT COUNT(*) FROM items WHERE rating_key = ?').value<[number]>(
        'whole-ok',
      )?.[0]
    ),
    1,
  );
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'completed');
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT COUNT(*) FROM items WHERE rating_key = ?').value<[number]>(
        'whole-ok',
      )?.[0]
    ),
    0,
  );
});

Deno.test('Plex-only whole-season deletion preserves the show and finalizes season rollups', async () => {
  reset();
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO items (server_id, rating_key, library_key, title, type, file_size, duration, tvdb_id, updated_at) VALUES (1, 'season-show', 'shows', 'Season Show', 'show', 100, 60, 42, 1)",
    ).run();
    client.prepare(
      "INSERT INTO seasons (server_id, rating_key, show_rating_key, library_key, season_index, title, file_size, duration, leaf_count, updated_at) VALUES (1, 'whole-season', 'season-show', 'shows', 1, 'Season 1', 100, 60, 1, 1)",
    ).run();
  });
  live.set('season-show', {
    ratingKey: 'season-show',
    title: 'Season Show',
    type: 'show',
    librarySectionID: 'shows',
    Guid: [{ id: 'tvdb://42' }],
  });
  live.set('whole-season', {
    ratingKey: 'whole-season',
    title: 'Season 1',
    type: 'season',
    librarySectionID: 'shows',
    parentRatingKey: 'season-show',
    index: 1,
  });
  live.set('whole-season-episode', {
    ratingKey: 'whole-season-episode',
    title: 'Pilot',
    type: 'episode',
    librarySectionID: 'shows',
    grandparentRatingKey: 'season-show',
    parentRatingKey: 'whole-season',
    parentIndex: 1,
    index: 1,
    Media: [{
      id: 1,
      Part: [{ file: '/tv/whole-season-episode.mkv', size: 100_000 }],
    }],
  });
  const result = await enqueueDeletionOperation({
    clientRequestId: crypto.randomUUID(),
    serverId: 1,
    libraryKey: 'shows',
    kind: 'whole_item',
    payload: { seasonRatingKey: 'whole-season', coordinated: false },
    targets: [{
      kind: 'whole_item',
      key: 'whole-season',
      title: 'Season Show — Season 1',
      logicalSize: 100,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey: 'shows',
        ratingKey: 'whole-season',
        title: 'Season 1',
        type: 'season',
        tmdbId: null,
        tvdbId: 42,
        mode: 'plex-only',
        cleanupDownloads: false,
        seasonCleanup: true,
        showTitle: 'Season Show',
        showRatingKey: 'season-show',
        seasonRatingKey: 'whole-season',
        seasonIndex: 1,
        fileSize: 100,
        wholeSeasonDuration: 60,
        wholeSeasonRemoval: {
          episodeRatingKeys: ['whole-season-episode'],
          plexEpisodes: [{
            ratingKey: 'whole-season-episode',
            title: 'Pilot',
            showRatingKey: 'season-show',
            seasonRatingKey: 'whole-season',
            seasonIndex: 1,
            episodeIndex: 1,
            media: [{
              mediaId: 1,
              paths: [{ path: '/tv/whole-season-episode.mkv', byteSize: 100_000 }],
            }],
          }],
          sonarrTargets: [],
        },
      },
    }],
  });

  await settle();
  assertEquals(getDeletionOperation(result.operationId, 1)?.status, 'completed');
  assertEquals(live.has('season-show'), true);
  assertEquals(live.has('whole-season'), false);
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT file_size, duration FROM items WHERE server_id = 1 AND rating_key = 'season-show'",
      ).value<[number, number]>()
    ),
    [0, 0],
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT COUNT(*) FROM seasons WHERE server_id = 1 AND rating_key = 'whole-season'",
      ).value<[number]>()?.[0]
    ),
    0,
  );
});

Deno.test('whole-season replay finalizes when Plex already confirms season absence', async () => {
  reset();
  addEpisode();
  live.set('season-1', {
    ratingKey: 'season-1',
    title: 'Season 1',
    type: 'season',
    librarySectionID: 'shows',
    parentRatingKey: 'show-1',
    index: 1,
  });
  const result = await enqueueDeletionOperation({
    clientRequestId: crypto.randomUUID(),
    serverId: 1,
    libraryKey: 'shows',
    kind: 'whole_item',
    payload: { seasonRatingKey: 'season-1', coordinated: false },
    targets: [{
      kind: 'whole_item',
      key: 'season-1',
      title: 'Example Show — Season 1',
      logicalSize: 100,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey: 'shows',
        ratingKey: 'season-1',
        title: 'Season 1',
        type: 'season',
        tmdbId: null,
        tvdbId: 20,
        mode: 'plex-only',
        cleanupDownloads: false,
        seasonCleanup: true,
        showTitle: 'Example Show',
        showRatingKey: 'show-1',
        seasonRatingKey: 'season-1',
        seasonIndex: 1,
        fileSize: 100,
        wholeSeasonDuration: null,
        wholeSeasonRemoval: {
          episodeRatingKeys: ['episode-1'],
          plexEpisodes: [{
            ratingKey: 'episode-1',
            title: 'Pilot',
            showRatingKey: 'show-1',
            seasonRatingKey: 'season-1',
            seasonIndex: 1,
            episodeIndex: 1,
            media: [21, 22].map((mediaId) => ({
              mediaId,
              paths: [{ path: `/tv/show-1-${mediaId}.mkv`, byteSize: 40_000 }],
            })),
          }],
          sonarrTargets: [],
        },
      },
    }],
  });
  live.delete('season-1');
  live.delete('episode-1');

  await settle();

  const operation = getDeletionOperation(result.operationId, 1)!;
  assertEquals(operation.status, 'completed_with_warning', JSON.stringify(operation));
  assertEquals(live.has('show-1'), true);
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT COUNT(*) FROM seasons WHERE server_id = 1 AND rating_key = 'season-1'",
      ).value<[number]>()?.[0]
    ),
    0,
  );
});

Deno.test('whole-season deletion rejects Plex membership and media drift', async () => {
  for (const drift of ['membership', 'path', 'replacement_after_cleanup'] as const) {
    reset();
    withTransaction((client) => {
      client.prepare(
        "INSERT INTO items (server_id, rating_key, library_key, title, type, file_size, duration, tvdb_id, updated_at) VALUES (1, 'drift-show', 'shows', 'Drift Show', 'show', 100, 60, 43, 1)",
      ).run();
      client.prepare(
        "INSERT INTO seasons (server_id, rating_key, show_rating_key, library_key, season_index, title, file_size, duration, leaf_count, updated_at) VALUES (1, 'drift-season', 'drift-show', 'shows', 1, 'Season 1', 100, 60, 1, 1)",
      ).run();
    });
    live.set('drift-show', {
      ratingKey: 'drift-show',
      title: 'Drift Show',
      type: 'show',
      librarySectionID: 'shows',
      Guid: [{ id: 'tvdb://43' }],
    });
    live.set('drift-season', {
      ratingKey: 'drift-season',
      title: 'Season 1',
      type: 'season',
      librarySectionID: 'shows',
      parentRatingKey: 'drift-show',
      index: 1,
    });
    live.set('drift-episode-1', {
      ratingKey: 'drift-episode-1',
      title: 'Pilot',
      type: 'episode',
      librarySectionID: 'shows',
      grandparentRatingKey: 'drift-show',
      parentRatingKey: 'drift-season',
      parentIndex: 1,
      index: 1,
      Media: [{
        id: 1,
        Part: [{ file: '/tv/drift-episode-1.mkv', size: 100_000 }],
      }],
    });
    const result = await enqueueDeletionOperation({
      clientRequestId: crypto.randomUUID(),
      serverId: 1,
      libraryKey: 'shows',
      kind: 'whole_item',
      payload: { seasonRatingKey: 'drift-season', coordinated: false },
      targets: [{
        kind: 'whole_item',
        key: 'drift-season',
        title: 'Drift Show — Season 1',
        logicalSize: 100,
        snapshot: {
          machineIdentifier: 'machine-1',
          serverUrl: 'http://plex',
          libraryKey: 'shows',
          ratingKey: 'drift-season',
          title: 'Season 1',
          type: 'season',
          tmdbId: null,
          tvdbId: 43,
          mode: 'plex-only',
          cleanupDownloads: false,
          seasonCleanup: true,
          showTitle: 'Drift Show',
          showRatingKey: 'drift-show',
          seasonRatingKey: 'drift-season',
          seasonIndex: 1,
          fileSize: 100,
          wholeSeasonDuration: 60,
          wholeSeasonRemoval: {
            episodeRatingKeys: ['drift-episode-1'],
            plexEpisodes: [{
              ratingKey: 'drift-episode-1',
              title: 'Pilot',
              showRatingKey: 'drift-show',
              seasonRatingKey: 'drift-season',
              seasonIndex: 1,
              episodeIndex: 1,
              media: [{
                mediaId: 1,
                paths: [{ path: '/tv/drift-episode-1.mkv', byteSize: 100_000 }],
              }],
            }],
            sonarrTargets: [],
          },
        },
      }],
    });

    if (drift === 'membership') {
      live.set('drift-episode-2', {
        ratingKey: 'drift-episode-2',
        title: 'Second',
        type: 'episode',
        librarySectionID: 'shows',
        grandparentRatingKey: 'drift-show',
        parentRatingKey: 'drift-season',
        parentIndex: 1,
        index: 2,
        Media: [{
          id: 2,
          Part: [{ file: '/tv/drift-episode-2.mkv', size: 100_000 }],
        }],
      });
    } else {
      live.get('drift-episode-1')!.Media![0]!.Part = [{
        file: '/tv/drift-episode-1-replaced.mkv',
        size: 100_000,
      }];
      if (drift === 'replacement_after_cleanup') {
        withTransaction((client) => {
          client.prepare(
            "UPDATE deletion_targets SET phase = 'arr_coordination' WHERE operation_id = ?",
          ).run(result.operationId);
        });
      }
    }

    await settle();
    assertEquals(getDeletionOperation(result.operationId, 1)?.status, 'needs_attention');
    assertEquals(live.has('drift-season'), true);
    assertEquals(
      withTransaction((client) =>
        client.prepare(
          "SELECT COUNT(*) FROM seasons WHERE server_id = 1 AND rating_key = 'drift-season'",
        ).value<[number]>()?.[0]
      ),
      1,
    );
  }
});

Deno.test('coordinated whole-season deletion unmonitors exact Sonarr episodes and files', async () => {
  reset();
  configureSonarr();
  addEpisode();
  live.set('season-1', {
    ratingKey: 'season-1',
    title: 'Season 1',
    type: 'season',
    librarySectionID: 'shows',
    parentRatingKey: 'show-1',
    index: 1,
  });
  const result = await enqueueDeletionOperation({
    clientRequestId: crypto.randomUUID(),
    serverId: 1,
    libraryKey: 'shows',
    kind: 'whole_item',
    payload: { seasonRatingKey: 'season-1', coordinated: true },
    targets: [{
      kind: 'whole_item',
      key: 'season-1',
      title: 'Example Show — Season 1',
      logicalSize: 100,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey: 'shows',
        ratingKey: 'season-1',
        title: 'Season 1',
        type: 'season',
        tmdbId: null,
        tvdbId: 20,
        mode: 'coordinated',
        cleanupDownloads: false,
        seasonCleanup: true,
        showTitle: 'Example Show',
        showRatingKey: 'show-1',
        seasonRatingKey: 'season-1',
        seasonIndex: 1,
        fileSize: 100,
        wholeSeasonDuration: null,
        wholeSeasonRemoval: {
          episodeRatingKeys: ['episode-1'],
          plexEpisodes: [{
            ratingKey: 'episode-1',
            title: 'Pilot',
            showRatingKey: 'show-1',
            seasonRatingKey: 'season-1',
            seasonIndex: 1,
            episodeIndex: 1,
            media: [21, 22].map((mediaId) => ({
              mediaId,
              paths: [{ path: `/tv/show-1-${mediaId}.mkv`, byteSize: 40_000 }],
            })),
          }],
          sonarrTargets: [{
            instanceId: 2,
            instanceName: 'Sonarr',
            instanceUrl: 'http://sonarr',
            configurationUpdatedAt: 1,
            mappingIdentity: '{"addImportExclusion":false,"pathMappings":[]}',
            seriesId: 8,
            seriesPath: '/tv/Show',
            version: '4.0.19.2979',
            episodes: [{
              episodeId: 9,
              seasonNumber: 1,
              episodeNumber: 1,
              originalMonitored: true,
              episodeFileId: 10,
            }],
            files: [{
              id: 10,
              path: '/tv/Show/Season 01/old.mkv',
              size: 40_000,
              episodeIds: [9],
            }],
          }],
        },
      },
    }],
  });

  await settle();
  assertEquals(getDeletionOperation(result.operationId, 1)?.status, 'completed');
  assertEquals(sonarrMonitored, false);
  assertEquals(sonarrManagedFilePresent, false);
  assertEquals(live.has('show-1'), true);
  assertEquals(live.has('season-1'), false);
});

Deno.test('target finalization atomically finalizes its parent operation', async () => {
  reset();
  addMovie('atomic-parent');
  const operationId = await enqueueWhole('atomic-parent');
  const target = withTransaction((client) => {
    const row = client.prepare(
      'SELECT t.id, t.operation_id, o.server_id, t.target_kind, t.target_key, t.snapshot, t.logical_size, t.phase, t.removal_confirmed_at, t.plex_attempt_count FROM deletion_targets t JOIN deletion_operations o ON o.id = t.operation_id WHERE t.operation_id = ?',
    ).value<[
      number,
      string,
      number,
      'whole_item',
      string,
      string,
      number | null,
      'validating',
      number | null,
      number,
    ]>(operationId)!;
    client.prepare("UPDATE deletion_targets SET status = 'running' WHERE id = ?").run(row[0]);
    client.prepare("UPDATE deletion_operations SET status = 'running' WHERE id = ?").run(
      operationId,
    );
    return {
      id: row[0],
      operationId: row[1],
      serverId: row[2],
      targetKind: row[3],
      targetKey: row[4],
      snapshot: row[5],
      logicalSize: row[6],
      phase: row[7],
      removalConfirmedAt: row[8],
      plexAttemptCount: row[9],
    };
  });

  // Invoke the workflow directly. There is deliberately no worker-level aggregate
  // refresh after this call, so the assertion proves finalization is self-contained.
  await ensureDeletionTarget(target);

  assertEquals(getDeletionOperation(operationId, 1)?.status, 'completed');
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT COUNT(*) FROM events WHERE type = 'deletion.completed' AND payload LIKE ?",
      ).value<[number]>(`%${operationId}%`)?.[0]
    ),
    1,
  );
});

Deno.test('whole-item replay finalizes when Plex already confirms absence', async () => {
  reset();
  addMovie('whole-absent');
  live.delete('whole-absent');
  const operationId = await enqueueWhole('whole-absent');
  await settle();
  const operation = getDeletionOperation(operationId, 1)!;
  assertEquals(operation.status, 'completed_with_warning');
  assertStringIncludes(
    String((operation.targets as Array<{ warning?: string }>)[0]?.warning),
    'removed outside Plex Librarian',
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT COUNT(*) FROM items WHERE rating_key = ?').value<[number]>(
        'whole-absent',
      )?.[0]
    ),
    0,
  );
});

Deno.test('externally removed version finalizes only after safe state is proven', async () => {
  reset();
  addMovie('version-absent', [11, 12]);
  const operationId = await enqueueVersion('version-absent', 11);
  live.get('version-absent')!.Media = live.get('version-absent')!.Media!.filter((media) =>
    media.id === 12
  );

  await settle();
  await settle();

  const operation = getDeletionOperation(operationId, 1)!;
  const target = (operation.targets as Array<Record<string, unknown>>)[0]!;
  assertEquals(operation.status, 'completed_with_warning', JSON.stringify(operation));
  assertEquals(target.plexAttemptCount, 0);
  assertEquals(target.removalConfirmedAt !== null, true);
  assertStringIncludes(String(target.warning), 'removed outside Plex Librarian');
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM media_version_reservations WHERE operation_id = ?',
      ).value<[number]>(operationId)?.[0]
    ),
    0,
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM item_media_versions WHERE item_rating_key = ? AND media_id = 11',
      ).value<[number]>('version-absent')?.[0]
    ),
    0,
  );
});

Deno.test('coordinated whole-item deletion converges through Radarr before local finalization', async () => {
  reset();
  configureRadarr();
  addMovie('arr-movie', [11, 12], 10);
  coordinatedRatingKey = 'arr-movie';
  arrPresent = true;
  const operationId = await enqueueCoordinated(['arr-movie']);
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'completed');
  assertEquals(arrDeleteCount, 1);
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT COUNT(*) FROM items WHERE rating_key = ?').value<[number]>(
        'arr-movie',
      )?.[0]
    ),
    0,
  );
});

Deno.test('coordinated Plex retries are phase-only, bounded, and warning-retryable', async () => {
  reset();
  addMovie('coordinated-plex-retry', [11], 10);
  configureRadarr();
  coordinatedRatingKey = 'coordinated-plex-retry';
  arrPresent = true;
  failDeleteBeforeMutation = true;
  const operationId = await enqueueCoordinated(['coordinated-plex-retry']);

  const expectedDelays = [15, 60, 300];
  for (const [index, delay] of expectedDelays.entries()) {
    const before = Math.floor(Date.now() / 1000);
    await settle();
    const operation = getDeletionOperation(operationId, 1)!;
    const target = (operation.targets as Array<Record<string, unknown>>)[0];
    assertEquals(operation.status, 'waiting_retry', JSON.stringify(operation));
    assertEquals(target.plexAttemptCount, index + 1);
    assert(Number(target.nextRetryAt) >= before + delay);
    assert(Number(target.nextRetryAt) <= Math.floor(Date.now() / 1000) + delay);
    assertEquals(arrDeleteCount, 1);
    makeRetryReady(operationId);
  }

  await settle();
  const warned = getDeletionOperation(operationId, 1)!;
  assertEquals(warned.status, 'completed_with_warning', JSON.stringify(warned));
  assertEquals(warned.warningCount, 1);
  assertEquals(warned.removalConfirmedCount, 0);
  assertEquals(warned.logicalSizeRemoved, 0);
  assertEquals(
    (warned.targets as Array<Record<string, unknown>>)[0].plexAttemptCount,
    4,
  );
  assertEquals(arrDeleteCount, 1);

  failDeleteBeforeMutation = false;
  assertEquals(retryDeletionOperation(operationId, 1, 'warning'), true);
  await settle();
  const completed = getDeletionOperation(operationId, 1)!;
  assertEquals(completed.status, 'completed', JSON.stringify(completed));
  assertEquals(completed.removalConfirmedCount, 1);
  assertEquals(completed.logicalSizeRemoved, 100);
  assertEquals(arrDeleteCount, 1);
});

Deno.test('warning retry refreshes aggregates before the worker reclaims the target', async () => {
  reset();
  addMovie('warning-aggregate', [11, 12]);
  const operationId = await enqueueVersion('warning-aggregate');
  withTransaction((client) => {
    client.prepare(
      "UPDATE deletion_targets SET status = 'completed_with_warning', phase = 'plex_reconciliation', removal_confirmed_at = 10, plex_attempt_count = 4, warning = 'warning' WHERE operation_id = ?",
    ).run(operationId);
    client.prepare(
      "UPDATE deletion_operations SET status = 'completed_with_warning', warning_count = 1, removal_confirmed_count = 1, logical_size_removed = 50, finished_at = 10 WHERE id = ?",
    ).run(operationId);
  });

  assertEquals(retryDeletionOperation(operationId, 1, 'warning'), true);
  const retried = getDeletionOperation(operationId, 1)!;
  assertEquals(retried.status, 'queued');
  assertEquals(retried.warningCount, 0);
  assertEquals(retried.removalConfirmedCount, 1);
  assertEquals(retried.logicalSizeRemoved, 50);
  assertEquals(retried.finishedAt, null);
  const target = (retried.targets as Array<Record<string, unknown>>)[0];
  assertEquals(target.plexAttemptCount, 0);
  assertEquals(target.phase, 'plex_reconciliation');
});

Deno.test('Recheck queues both ordinary failures and unresolved warnings', async () => {
  reset();
  addMovie('recheck-all', [11, 12]);
  const operationId = await enqueueVersion('recheck-all');
  withTransaction((client) => {
    client.prepare(
      "UPDATE deletion_targets SET status = 'completed_with_warning', phase = 'plex_reconciliation', warning = 'warning' WHERE operation_id = ?",
    ).run(operationId);
    client.prepare(
      `INSERT INTO deletion_targets
         (operation_id, ordinal, target_kind, target_key, title, snapshot, status, phase,
          attempt_count, plex_attempt_count, error, created_at, updated_at)
       SELECT operation_id, 1, target_kind, target_key || '-failed', title, snapshot,
              'needs_attention', 'validating', 3, plex_attempt_count, 'failure', created_at, updated_at
       FROM deletion_targets WHERE operation_id = ?`,
    ).run(operationId);
    client.prepare(
      "UPDATE deletion_operations SET status = 'needs_attention', target_count = 2, warning_count = 1, failed_count = 1 WHERE id = ?",
    ).run(operationId);
  });

  assertEquals(retryDeletionOperation(operationId, 1), true);
  const targets = getDeletionOperation(operationId, 1)!.targets as Array<Record<string, unknown>>;
  assertEquals(targets.map((target) => target.status), ['queued', 'queued']);
  assertEquals(targets.map((target) => target.error), [null, null]);
  assertEquals(targets.map((target) => target.warning), [null, null]);
  assertEquals(targets.map((target) => target.attemptCount), [0, 0]);
});

Deno.test('successful sync rechecks only targets already in Plex reconciliation', async () => {
  reset();
  addMovie('sync-recheck', [11, 12]);
  const operationId = await enqueueVersion('sync-recheck');
  const validatingTargetId = withTransaction((client) => {
    client.prepare(
      "UPDATE deletion_targets SET status = 'needs_attention', phase = 'plex_reconciliation', error = 'Plex metadata is stale' WHERE operation_id = ?",
    ).run(operationId);
    const targetId = client.prepare(
      `INSERT INTO deletion_targets
         (operation_id, ordinal, target_kind, target_key, title, snapshot, status, phase,
          attempt_count, plex_attempt_count, error, created_at, updated_at)
       SELECT operation_id, 1, target_kind, target_key || '-validation', title, snapshot,
              'needs_attention', 'validating', attempt_count, plex_attempt_count,
              'Mapping requires review', created_at, updated_at
       FROM deletion_targets WHERE operation_id = ? RETURNING id`,
    ).value<[number]>(operationId)![0];
    client.prepare(
      "UPDATE deletion_operations SET status = 'needs_attention', target_count = 2, failed_count = 2 WHERE id = ?",
    ).run(operationId);
    return targetId;
  });
  const syncId = withTransaction((client) =>
    client.prepare(
      "INSERT INTO sync_log (server_id, library_key, started_at, status, items_processed) VALUES (1, 'movies', ?, 'pending', 0) RETURNING id",
    ).value<[number]>(Math.floor(Date.now() / 1000))![0]
  );

  await finalizeSyncLog(syncId, 1, 'movies', {
    ok: true,
    itemsProcessed: 1,
    generation: Math.floor(Date.now() / 1000),
    pruneCompleted: false,
  });

  const operation = getDeletionOperation(operationId, 1)!;
  const targets = operation.targets as Array<Record<string, unknown>>;
  assertEquals(operation.status, 'queued');
  assertEquals(
    targets.find((target) => target.id === validatingTargetId)?.status,
    'needs_attention',
  );
  assertEquals(
    targets.find((target) => target.id !== validatingTargetId)?.status,
    'queued',
  );
});

Deno.test('successful sync rechecks every unresolved Plex operation in an idle library', async () => {
  reset();

  const enqueueUnresolved = async (ratingKey: string, mediaIds: number[]) => {
    addMovie(ratingKey, mediaIds);
    const operationId = await enqueueVersion(ratingKey, mediaIds[0]);
    withTransaction((client) => {
      client.prepare(
        "UPDATE deletion_targets SET status = 'needs_attention', phase = 'plex_reconciliation', error = 'Plex metadata is stale' WHERE operation_id = ?",
      ).run(operationId);
      client.prepare(
        "UPDATE deletion_operations SET status = 'needs_attention', failed_count = 1 WHERE id = ?",
      ).run(operationId);
    });
    return operationId;
  };

  const firstOperationId = await enqueueUnresolved('sync-recheck-first', [11, 12]);
  const secondOperationId = await enqueueUnresolved('sync-recheck-second', [21, 22]);
  const syncId = withTransaction((client) =>
    client.prepare(
      "INSERT INTO sync_log (server_id, library_key, started_at, status, items_processed) VALUES (1, 'movies', ?, 'pending', 0) RETURNING id",
    ).value<[number]>(Math.floor(Date.now() / 1000))![0]
  );

  await finalizeSyncLog(syncId, 1, 'movies', {
    ok: true,
    itemsProcessed: 2,
    generation: Math.floor(Date.now() / 1000),
    pruneCompleted: false,
  });

  assertEquals(getDeletionOperation(firstOperationId, 1)?.status, 'queued');
  assertEquals(getDeletionOperation(secondOperationId, 1)?.status, 'queued');
});

Deno.test('warning overlap is returned before Plex I/O or current projection lookup', async () => {
  reset();
  addMovie('warning-pruned', [11, 12]);
  const operationId = await enqueueVersion('warning-pruned');
  withTransaction((client) => {
    client.prepare(
      "UPDATE deletion_targets SET status = 'completed_with_warning', phase = 'plex_reconciliation', warning = 'warning' WHERE operation_id = ?",
    ).run(operationId);
    client.prepare(
      "UPDATE deletion_operations SET status = 'completed_with_warning', warning_count = 1 WHERE id = ?",
    ).run(operationId);
    client.prepare(
      'DELETE FROM item_media_versions WHERE server_id = 1 AND item_rating_key = ? AND media_id = 11',
    ).run('warning-pruned');
  });
  const beforeFetches = fetchCount;

  const response = await app.request('/api/duplicates/movies/warning-pruned/media/11', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
  });
  assertEquals(response.status, 409);
  assertEquals(await response.json(), {
    error: 'this item has unresolved Plex cleanup; retry Plex cleanup from Activity first',
    operationId,
  });
  assertEquals(fetchCount, beforeFetches);
});

Deno.test('warning retry needs current Arr absence but not a pruned legacy attempt row', async () => {
  reset();
  addMovie('warning-pruned-attempt', [11], 10);
  configureRadarr();
  coordinatedRatingKey = 'warning-pruned-attempt';
  arrPresent = true;
  failDeleteBeforeMutation = true;
  const operationId = await enqueueCoordinated(['warning-pruned-attempt']);
  for (let index = 0; index < 4; index++) {
    await settle();
    if (index < 3) makeRetryReady(operationId);
  }
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'completed_with_warning');

  withTransaction((client) => {
    client.prepare('DELETE FROM arr_delete_attempts WHERE rating_key = ?').run(
      'warning-pruned-attempt',
    );
    client.prepare('DELETE FROM items WHERE server_id = 1 AND rating_key = ?').run(
      'warning-pruned-attempt',
    );
  });
  live.delete('warning-pruned-attempt');
  failDeleteBeforeMutation = false;

  assertEquals(retryDeletionOperation(operationId, 1, 'warning'), true);
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'completed_with_warning');
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT COUNT(*) FROM media_removals WHERE operation_id = ?').value<[number]>(
        operationId,
      )?.[0]
    ),
    0,
  );
});

Deno.test('warning retry treats a reappeared Arr record as a safety failure', async () => {
  reset();
  addMovie('warning-arr-reappeared', [11], 10);
  configureRadarr();
  arrPresent = true;
  const operationId = await enqueueCoordinated(['warning-arr-reappeared']);
  withTransaction((client) => {
    client.prepare(
      "UPDATE deletion_targets SET status = 'completed_with_warning', phase = 'plex_reconciliation', plex_attempt_count = 4, warning = 'warning' WHERE operation_id = ?",
    ).run(operationId);
    client.prepare(
      "UPDATE deletion_operations SET status = 'completed_with_warning', warning_count = 1 WHERE id = ?",
    ).run(operationId);
  });

  assertEquals(retryDeletionOperation(operationId, 1, 'warning'), true);
  await settle();
  const operation = getDeletionOperation(operationId, 1)!;
  assertEquals(operation.status, 'needs_attention');
  assertEquals(operation.warningCount, 0);
  assertEquals(operation.failedCount, 1);
  const target = (operation.targets as Array<Record<string, unknown>>)[0];
  assertEquals(target.plexAttemptCount, 0);
  assertEquals(target.phase, 'plex_reconciliation');
});

Deno.test('coordinated deletion executes verified qBittorrent cleanup before Radarr', async () => {
  reset();
  configureRadarr(true);
  addMovie('qbit-movie', [11, 12], 10);
  coordinatedRatingKey = 'qbit-movie';
  arrPresent = true;
  qbitPresent = true;
  const operationId = await enqueueCoordinated(['qbit-movie'], true);
  await settle();
  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(qbitDeleteCount, 1);
  assertEquals(arrDeleteCount, 1);
  assertEquals(destinationOrder, ['qbittorrent', 'arr', 'plex']);
});

Deno.test('qBittorrent-only whole-item deletion does not require Arr selection', async () => {
  reset();
  configureRadarr(true);
  addMovie('qbit-only', [11, 12], 10);
  coordinatedRatingKey = 'qbit-only';
  arrPresent = true;
  qbitPresent = true;
  const operationId = await enqueueWholeDestinations(
    ['qbit-only'],
    new Set(),
    new Set(['qbit-only']),
  );

  await settle();
  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(qbitDeleteCount, 1);
  assertEquals(arrDeleteCount, 0);
  assertEquals(destinationOrder, ['qbittorrent', 'plex']);
});

Deno.test('whole-item direct-manifest cleanup converges after a lost delete response', async () => {
  reset();
  addMovie('direct-whole-item', [11]);
  const localRoot = resolve(testDirectory, 'direct-whole-item').replaceAll('\\', '/');
  const localRelease = `${localRoot}/release`;
  const localMovie = `${localRelease}/old.mkv`;
  await Deno.mkdir(localRelease, { recursive: true });
  await Deno.writeFile(localMovie, new Uint8Array(40_000));
  live.get('direct-whole-item')!.Media = [{
    id: 11,
    Part: [{ file: '/movies/old.mkv', size: 40_000 }],
  }];
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO qbittorrent_instances (id, server_id, name, url, username, password, created_at, updated_at) VALUES (1, 1, 'qBittorrent', 'http://qbit', '', '', 1, 1)",
    ).run();
    client.prepare(
      `INSERT INTO plex_path_mappings
       (server_id, library_key, plex_path, local_path, case_sensitive, revision,
        validation_plex_path, validation_local_path, validation_size,
        validated_at, created_at, updated_at)
       VALUES (1, 'movies', '/movies', ?, 1, 1,
               '/movies/old.mkv', ?, 40000, 1, 1, 1)`,
    ).run(localRelease, localMovie);
    client.prepare(
      `INSERT INTO qbittorrent_path_mappings
       (server_id, instance_key, qbittorrent_path, local_path, case_sensitive, revision,
        validation_qbittorrent_path, validation_local_path, validation_size,
        validated_at, created_at, updated_at)
       VALUES (1, 'db:1', '/downloads', ?, 1, 1,
               '/downloads/release/old.mkv', ?, 40000, 1, 1, 1)`,
    ).run(localRoot, localMovie);
  });
  seasonPackQbit = true;
  qbitPresent = true;
  loseQbitDeleteResponse = true;

  const previewResponse = await app.request(
    '/api/libraries/movies/items/download-cleanup-preview',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ratingKeys: ['direct-whole-item'] }),
    },
  );
  assertEquals(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json();
  assertEquals(preview.items[0].status, 'resolved', JSON.stringify(preview));
  assertEquals(preview.items[0].downloadJobs.length, 1);

  const response = await app.request('/api/libraries/movies/items', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: crypto.randomUUID(),
      ratingKeys: ['direct-whole-item'],
      coordinatedRatingKeys: [],
      cleanupDownloadRatingKeys: ['direct-whole-item'],
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const { operationId } = await response.json() as { operationId: string };
  const snapshotJson = withTransaction((client) =>
    client.prepare('SELECT snapshot FROM deletion_targets WHERE operation_id = ?').value<[string]>(
      operationId,
    )?.[0]
  );
  const snapshot = JSON.parse(snapshotJson!);
  assertEquals(snapshot.wholeItemDownloadCleanup.status, 'resolved');
  assertEquals(
    snapshot.wholeItemDownloadCleanup.downloadJobs.map((job: { provenance: string }) =>
      job.provenance
    ),
    ['direct_manifest'],
  );

  await settle();
  assertEquals(
    getDeletionOperation(operationId, 1)?.status,
    'waiting_retry',
    JSON.stringify(getDeletionOperation(operationId, 1)),
  );
  makeRetryReady(operationId);
  await settle();
  assertEquals(
    getDeletionOperation(operationId, 1)?.status,
    'completed',
    JSON.stringify(getDeletionOperation(operationId, 1)),
  );
  assertEquals(qbitDeleteCount, 1);
  assertEquals(destinationOrder, ['qbittorrent', 'plex']);
});

Deno.test('whole-item acceptance rejects a shared job split across cleanup selection', async () => {
  reset();
  configureRadarr(true);
  addMovie('shared-selected', [11], 10);
  addMovie('shared-unselected', [12], 10);
  arrPresent = true;
  qbitPresent = true;

  const response = await app.request('/api/libraries/movies/items', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: crypto.randomUUID(),
      ratingKeys: ['shared-selected', 'shared-unselected'],
      coordinatedRatingKeys: [],
      cleanupDownloadRatingKeys: ['shared-selected'],
    }),
  });

  assertEquals(response.status, 409, await response.clone().text());
  assertStringIncludes(
    (await response.json()).error,
    'shared by cleanup-selected and cleanup-unselected items',
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT COUNT(*) FROM deletion_operations').value<[number]>()?.[0]
    ),
    0,
  );
});

Deno.test('whole-item retry rejects changed evidence that splits a shared job', async () => {
  reset();
  configureRadarr(true);
  addMovie('retry-shared-selected', [11], 10);
  addMovie('retry-shared-unselected', [12], 10);
  arrPresent = true;
  qbitPresent = true;
  const operationId = await enqueueWholeDestinations(
    ['retry-shared-selected', 'retry-shared-unselected'],
    new Set(),
    new Set(['retry-shared-selected']),
  );

  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'needs_attention');
  assertEquals(qbitDeleteCount, 0);
  assertEquals(destinationOrder, ['plex']);
});

Deno.test('selected cleanup and Arr still execute after Plex metadata is already absent', async () => {
  reset();
  configureRadarr(true);
  addMovie('absent-retry-destinations', [11, 12], 10);
  coordinatedRatingKey = 'absent-retry-destinations';
  arrPresent = true;
  qbitPresent = true;
  const operationId = await enqueueCoordinated(['absent-retry-destinations'], true);
  live.delete('absent-retry-destinations');

  await settle();
  assertEquals(qbitDeleteCount, 1);
  assertEquals(arrDeleteCount, 1);
  assertEquals(destinationOrder, ['qbittorrent', 'arr']);
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'completed_with_warning');
});

Deno.test('active playback blocks selected destinations even after Plex metadata is absent', async () => {
  reset();
  configureRadarr(true);
  addMovie('absent-playing', [11, 12], 10);
  coordinatedRatingKey = 'absent-playing';
  arrPresent = true;
  qbitPresent = true;
  activePlaybackRatingKey = 'absent-playing';
  const operationId = await enqueueCoordinated(['absent-playing'], true);
  live.delete('absent-playing');

  await settle();
  assertEquals(qbitDeleteCount, 0);
  assertEquals(arrDeleteCount, 0);
  assertEquals(destinationOrder, []);
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'needs_attention');
});

Deno.test('coordinated Radarr work never queries qBittorrent unless cleanup is selected', async () => {
  reset();
  configureRadarr(true);
  addMovie('no-qbit-inspection', [11, 12], 10);
  coordinatedRatingKey = 'no-qbit-inspection';
  arrPresent = true;
  qbitPresent = true;

  const operationId = await enqueueCoordinated(['no-qbit-inspection'], false);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(qbitRequestCount, 0);
  assertEquals(qbitDeleteCount, 0);
  assertEquals(qbitPresent, true);
  assertEquals(arrDeleteCount, 1);
});

Deno.test({
  name: 'coordinated replay recognizes a durably attempted orphan file already absent',
  ignore: Deno.build.os === 'windows',
  fn: async () => {
    reset();
    configureRadarr();
    addMovie('orphan-movie', [11, 12], 10);
    coordinatedRatingKey = 'orphan-movie';
    arrPresent = true;
    const downloadRoot = await Deno.makeTempDir();
    try {
      const root = await orphanRootIdentity(downloadRoot);
      const localPath = resolve(downloadRoot, 'release', 'movie.mkv');
      withTransaction((client) => {
        client.prepare(
          "INSERT INTO arr_path_mappings (arr_instance_id, kind, arr_path, local_path) VALUES (1, 'download', '/downloads', ?)",
        ).run(downloadRoot);
        client.prepare(
          'INSERT INTO download_file_delete_attempts (server_id, rating_key, local_path, root_path, root_device, root_inode, started_at) VALUES (1, ?, ?, ?, ?, ?, 1)',
        ).run('orphan-movie', localPath, downloadRoot, root.rootDevice, root.rootInode);
      });
      const operationId = await enqueueCoordinated(['orphan-movie'], true);
      await settle();
      const operation = getDeletionOperation(operationId, 1);
      assertEquals(operation?.status, 'completed', JSON.stringify(operation));
      assertEquals(arrDeleteCount, 1);
    } finally {
      await Deno.remove(downloadRoot, { recursive: true });
    }
  },
});

Deno.test('episode-version deletion converges and updates show and season rollups', async () => {
  reset();
  addEpisode();
  const operationId = await enqueueEpisode();
  await settle();
  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM episode_media_versions WHERE episode_rating_key = ?',
      ).value<[number]>('episode-1')?.[0]
    ),
    1,
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT file_size FROM seasons WHERE rating_key = ?',
      ).value<[number]>('season-1')?.[0]
    ),
    60,
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT file_size FROM items WHERE rating_key = ?',
      ).value<[number]>('show-1')?.[0]
    ),
    60,
  );
});

Deno.test('multi-target operation processes every target in ordinal order', async () => {
  reset();
  addMovie('batch-a');
  addMovie('batch-b', [31, 32]);
  const result = await enqueueDeletionOperation({
    clientRequestId: crypto.randomUUID(),
    serverId: 1,
    libraryKey: 'movies',
    kind: 'whole_item',
    payload: { ratingKeys: ['batch-a', 'batch-b'], mode: 'plex-only' },
    targets: ['batch-a', 'batch-b'].map((ratingKey) => ({
      kind: 'whole_item' as const,
      key: ratingKey,
      title: `Movie ${ratingKey}`,
      logicalSize: 100,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey: 'movies',
        ratingKey,
        title: `Movie ${ratingKey}`,
        type: 'movie',
        tmdbId: null,
        tvdbId: null,
        mode: 'plex-only',
      },
    })),
  });
  await settle();
  assertEquals(getDeletionOperation(result.operationId, 1)?.status, 'completed');
  assertEquals(wholeDeleteOrder, ['batch-a', 'batch-b']);
});

Deno.test('multi-operation enqueue rolls back every library when one library conflicts', async () => {
  reset();
  const existing = await enqueueDeletionOperation({
    clientRequestId: 'atomic-existing',
    serverId: 1,
    libraryKey: 'shows',
    kind: 'whole_item',
    payload: { ratingKeys: ['existing-show'] },
    targets: [{
      kind: 'whole_item',
      key: 'existing-show',
      title: 'Existing show',
      logicalSize: null,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey: 'shows',
        ratingKey: 'existing-show',
        title: 'Existing show',
        type: 'show',
      },
    }],
  });

  const operation = (
    clientRequestId: string,
    libraryKey: string,
    ratingKey: string,
  ) => ({
    clientRequestId,
    serverId: 1,
    libraryKey,
    kind: 'whole_item' as const,
    payload: { ratingKeys: [ratingKey] },
    targets: [{
      kind: 'whole_item' as const,
      key: ratingKey,
      title: ratingKey,
      logicalSize: null,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey,
        ratingKey,
        title: ratingKey,
        type: libraryKey === 'shows' ? 'show' : 'movie',
      },
    }],
  });
  const conflict = await assertRejects(
    () =>
      enqueueDeletionOperations([
        operation('atomic-batch:0', 'movies', 'new-movie'),
        operation('atomic-batch:1', 'shows', 'new-show'),
      ]),
    DeletionConflictError,
    'this library already has an active deletion operation',
  );
  assertEquals(conflict.operationId, existing.operationId);

  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT client_request_id FROM deletion_operations WHERE client_request_id LIKE 'atomic-batch:%'",
      ).values()
    ),
    [],
  );
});

Deno.test('season enqueue rejects mapping drift and rolls back all durable rows', async () => {
  reset();
  configureSonarr();
  addEpisode();
  withTransaction((client) =>
    client.prepare('UPDATE arr_instances SET updated_at = 2 WHERE id = 2').run()
  );
  await assertRejects(
    () =>
      enqueueDeletionOperation({
        clientRequestId: 'season-mapping-race',
        serverId: 1,
        libraryKey: 'shows',
        kind: 'episode_version',
        payload: {
          seasonRatingKey: 'season-1',
          selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
          coordinateSonarr: true,
          cleanupDownloads: false,
        },
        targets: [{
          kind: 'episode_version',
          key: 'episode-1:21',
          title: 'Example Show — Pilot',
          logicalSize: 40,
          snapshot: {
            libraryKey: 'shows',
            ratingKey: 'episode-1',
            showRatingKey: 'show-1',
            mediaId: 21,
            arrReassignmentMappings: [{
              instanceId: 2,
              instanceType: 'sonarr',
              instanceUrl: 'http://sonarr',
              configurationUpdatedAt: 1,
              mappingIdentity: '{"addImportExclusion":false,"pathMappings":[]}',
            }],
          },
          reservation: { mediaKind: 'episode', mediaId: 21, ratingKey: 'episode-1' },
        }],
      }),
    DeletionConflictError,
    'accepted Arr mapping configuration changed',
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        `SELECT
           (SELECT COUNT(*) FROM deletion_operations WHERE client_request_id = ?),
           (SELECT COUNT(*) FROM deletion_targets),
           (SELECT COUNT(*) FROM media_version_reservations)`,
      ).value<[number, number, number]>(
        'season-mapping-race',
      )
    ),
    [0, 0, 0],
  );
});

Deno.test('season enqueue rolls back operation, targets, and reservations after a late conflict', async () => {
  reset();
  addManualSeasonEpisode('atomic-show', 'atomic-season', 'atomic-episode-1', 1, [101, 102]);
  addManualSeasonEpisode('atomic-show', 'atomic-season', 'atomic-episode-2', 2, [201, 202, 203]);

  const existing = await enqueueDeletionOperation({
    clientRequestId: 'season-existing-reservation',
    serverId: 1,
    libraryKey: 'shows',
    kind: 'episode_version',
    payload: { ratingKey: 'atomic-episode-2', mediaIds: [201] },
    targets: [{
      kind: 'episode_version',
      key: 'atomic-episode-2:201',
      title: 'Existing reservation',
      logicalSize: 40,
      snapshot: {
        libraryKey: 'shows',
        ratingKey: 'atomic-episode-2',
        showRatingKey: 'atomic-show',
        seasonRatingKey: 'atomic-season',
        mediaId: 201,
        seasonCleanup: true,
      },
      reservation: { mediaKind: 'episode', mediaId: 201, ratingKey: 'atomic-episode-2' },
    }],
  });
  withTransaction((client) => {
    client.prepare("UPDATE deletion_targets SET status = 'completed' WHERE operation_id = ?").run(
      existing.operationId,
    );
    client.prepare("UPDATE deletion_operations SET status = 'completed' WHERE id = ?").run(
      existing.operationId,
    );
  });

  const target = (episodeRatingKey: string, mediaId: number) => ({
    kind: 'episode_version' as const,
    key: `${episodeRatingKey}:${mediaId}`,
    title: episodeRatingKey,
    logicalSize: 40,
    snapshot: {
      libraryKey: 'shows',
      ratingKey: episodeRatingKey,
      showRatingKey: 'atomic-show',
      seasonRatingKey: 'atomic-season',
      mediaId,
      seasonCleanup: true,
    },
    reservation: { mediaKind: 'episode' as const, mediaId, ratingKey: episodeRatingKey },
  });
  const conflict = await assertRejects(
    () =>
      enqueueDeletionOperation({
        clientRequestId: 'season-late-reservation-conflict',
        serverId: 1,
        libraryKey: 'shows',
        kind: 'episode_version',
        payload: {
          seasonRatingKey: 'atomic-season',
          selections: [
            { episodeRatingKey: 'atomic-episode-1', mediaIds: [101] },
            { episodeRatingKey: 'atomic-episode-2', mediaIds: [201] },
          ],
          coordinateSonarr: false,
          cleanupDownloads: false,
        },
        targets: [target('atomic-episode-1', 101), target('atomic-episode-2', 201)],
      }),
    DeletionConflictError,
    'already reserved by another deletion',
  );
  assertEquals(conflict.operationId, existing.operationId);

  assertEquals(
    withTransaction((client) =>
      client.prepare(
        `SELECT
           (SELECT COUNT(*) FROM deletion_operations WHERE client_request_id = ?),
           (SELECT COUNT(*) FROM deletion_targets t
              JOIN deletion_operations o ON o.id = t.operation_id
             WHERE o.client_request_id = ?),
           (SELECT COUNT(*) FROM media_version_reservations)`,
      ).value<[number, number, number]>(
        'season-late-reservation-conflict',
        'season-late-reservation-conflict',
      )
    ),
    [0, 0, 1],
  );
});

Deno.test('Plex-only season enqueue requires reviewed Sonarr inspection evidence', async () => {
  reset();
  configureSonarr();
  addEpisode();

  await assertRejects(
    () =>
      enqueueDeletionOperation({
        clientRequestId: 'season-plex-only-no-arr-evidence',
        serverId: 1,
        libraryKey: 'shows',
        kind: 'episode_version',
        payload: {
          seasonRatingKey: 'season-1',
          selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
          coordinateSonarr: false,
          cleanupDownloads: false,
        },
        targets: [{
          kind: 'episode_version',
          key: 'episode-1:21',
          title: 'Example Show — Pilot',
          logicalSize: 40,
          snapshot: {
            libraryKey: 'shows',
            ratingKey: 'episode-1',
            showRatingKey: 'show-1',
            seasonRatingKey: 'season-1',
            mediaId: 21,
            seasonCleanup: true,
            skipArrCoordination: true,
          },
          reservation: { mediaKind: 'episode', mediaId: 21, ratingKey: 'episode-1' },
        }],
      }),
    DeletionValidationError,
    'durable Sonarr inspection guard is missing',
  );
});

Deno.test('Plex-only season enqueue rejects inspected Sonarr mapping drift', async () => {
  reset();
  configureSonarr();
  addEpisode();

  await assertRejects(
    () =>
      enqueueDeletionOperation({
        clientRequestId: 'season-plex-only-mapping-race',
        serverId: 1,
        libraryKey: 'shows',
        kind: 'episode_version',
        payload: {
          seasonRatingKey: 'season-1',
          selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
          coordinateSonarr: false,
          cleanupDownloads: false,
        },
        targets: [{
          kind: 'episode_version',
          key: 'episode-1:21',
          title: 'Example Show — Pilot',
          logicalSize: 40,
          snapshot: {
            libraryKey: 'shows',
            ratingKey: 'episode-1',
            showRatingKey: 'show-1',
            seasonRatingKey: 'season-1',
            mediaId: 21,
            seasonCleanup: true,
            skipArrCoordination: true,
            seasonSonarrInspection: {
              mappings: [{
                instanceId: 2,
                instanceType: 'sonarr',
                instanceUrl: 'http://sonarr',
                configurationUpdatedAt: 0,
                mappingIdentity: '{"addImportExclusion":false,"pathMappings":[]}',
              }],
              managedSelectedMediaIds: [21],
            },
          },
          reservation: { mediaKind: 'episode', mediaId: 21, ratingKey: 'episode-1' },
        }],
      }),
    DeletionConflictError,
    'accepted Arr mapping configuration changed',
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT COUNT(*) FROM deletion_operations WHERE client_request_id = 'season-plex-only-mapping-race'",
      ).value<[number]>()?.[0]
    ),
    0,
  );
});

Deno.test('enqueue race replay returns the existing operation status', async () => {
  reset();
  addMovie('race-status');
  const input = {
    clientRequestId: 'race-status-request',
    serverId: 1,
    libraryKey: 'movies',
    kind: 'whole_item' as const,
    payload: { ratingKeys: ['race-status'] },
    targets: [{
      kind: 'whole_item' as const,
      key: 'race-status',
      title: 'Race status',
      logicalSize: 100,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey: 'movies',
        ratingKey: 'race-status',
        title: 'Movie race-status',
        type: 'movie',
      },
    }],
  };
  const created = await enqueueDeletionOperation(input);
  withTransaction((client) =>
    client.prepare("UPDATE deletion_operations SET status = 'running' WHERE id = ?").run(
      created.operationId,
    )
  );

  assertEquals(await enqueueDeletionOperation(input), {
    operationId: created.operationId,
    status: 'running',
  });
});

Deno.test('quick cleanup endpoints persist the analyzed keeper in the durable target', async () => {
  reset();
  addSmartCleanupMovie('smart-route');

  const analysisResponse = await app.request('/api/duplicates/smart-analysis', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ movies: true, tv: false }),
  });
  assertEquals(analysisResponse.status, 200);
  const analysis = await analysisResponse.json();
  assertEquals(analysis.analyzedGroups, 1);
  assertEquals(analysis.protectedGroups, 0);
  assertEquals(analysis.candidates[0].keepMediaId, 12);

  const cleanupResponse = await app.request('/api/duplicates/smart-cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'smart-route-cleanup',
      selections: [{
        mediaType: 'movie',
        ratingKey: 'smart-route',
        deleteMediaIds: [11],
      }],
      includeNearIdentical: false,
    }),
  });
  assertEquals(cleanupResponse.status, 202, await cleanupResponse.text());
  const [snapshot] = withTransaction((client) =>
    client.prepare(
      `SELECT t.snapshot
       FROM deletion_targets t
       JOIN deletion_operations o ON o.id = t.operation_id
       WHERE o.client_request_id = 'smart-route-cleanup:0'`,
    ).value<[string]>() ?? []
  );
  assert(snapshot);
  const parsed = JSON.parse(snapshot);
  assertEquals(parsed.expectedRetainedVersion.mediaId, 12);
  assertEquals(parsed.expectedRetainedVersion.bitrate, 10_000);
  assertEquals(parsed.height, 1080);
});

Deno.test('manual season cleanup queues one durable operation across episodes', async () => {
  reset();
  addManualSeasonEpisode('manual-show', 'manual-season', 'manual-episode-1', 1, [101, 102]);
  addManualSeasonEpisode('manual-show', 'manual-season', 'manual-episode-2', 2, [201, 202]);

  const preview = await seasonPreviewEvidence('manual-season', [
    'manual-episode-1',
    'manual-episode-2',
  ]);
  const requestBody = JSON.stringify({
    clientRequestId: 'manual-season-cleanup',
    selections: [
      { episodeRatingKey: 'manual-episode-1', mediaIds: [101] },
      { episodeRatingKey: 'manual-episode-2', mediaIds: [201] },
    ],
    ...preview,
  });
  const response = await seasonCleanupRequest('manual-season', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: requestBody,
  });
  assertEquals(response.status, 202, await response.clone().text());
  const result = await response.json();
  assertEquals(result.targetCount, 2);
  assert(result.operationId);
  const repeated = await seasonCleanupRequest('manual-season', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...JSON.parse(requestBody),
      selections: [...JSON.parse(requestBody).selections].reverse(),
    }),
  });
  assertEquals(repeated.status, 202, await repeated.clone().text());
  assertEquals(await repeated.json(), result);
  const conflicting = await seasonCleanupRequest('manual-season', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...JSON.parse(requestBody),
      selections: [
        { episodeRatingKey: 'manual-episode-1', mediaIds: [102] },
        { episodeRatingKey: 'manual-episode-2', mediaIds: [201] },
      ],
    }),
  });
  assertEquals(conflicting.status, 409);
  assertEquals((await conflicting.clone().json()).code, 'REQUEST_ID_CONFLICT');
  const changedSeason = await app.request('/api/duplicates/seasons/another-season/cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'manual-season-cleanup',
      previewFingerprint: preview.previewFingerprint,
      selections: [{ episodeRatingKey: 'manual-episode-1', mediaIds: [101] }],
      coordinateSonarr: false,
      cleanupDownloads: false,
    }),
  });
  assertEquals(changedSeason.status, 409);
  assertEquals((await changedSeason.json()).code, 'REQUEST_ID_CONFLICT');
  const changedDestination = await app.request(
    '/api/duplicates/seasons/manual-season/cleanup',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientRequestId: 'manual-season-cleanup',
        previewFingerprint: preview.previewFingerprint,
        selections: [
          { episodeRatingKey: 'manual-episode-1', mediaIds: [101] },
          { episodeRatingKey: 'manual-episode-2', mediaIds: [201] },
        ],
        coordinateSonarr: true,
        cleanupDownloads: false,
      }),
    },
  );
  assertEquals(changedDestination.status, 409);
  assertEquals((await changedDestination.json()).code, 'REQUEST_ID_CONFLICT');
  const rows = withTransaction((client) =>
    client.prepare(
      `SELECT o.client_request_id, t.target_kind, t.target_key,
              json_extract(t.snapshot, '$.seasonCleanup'),
              json_extract(t.snapshot, '$.skipArrCoordination'),
              json_extract(t.snapshot, '$.expectedRetainedVersion.mediaId')
       FROM deletion_operations o
       JOIN deletion_targets t ON t.operation_id = o.id
       WHERE o.id = ? ORDER BY t.ordinal`,
    ).values(result.operationId)
  );
  assertEquals(rows, [
    ['manual-season-cleanup', 'episode_version', 'manual-episode-1:101', 1, 1, 102],
    ['manual-season-cleanup', 'episode_version', 'manual-episode-2:201', 1, 1, 202],
  ]);
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM media_version_reservations WHERE operation_id = ?',
      ).value<[number]>(result.operationId)?.[0]
    ),
    2,
  );
  // Analysis, preview, and command rebuilding each read exact live technical evidence
  // once per selected episode. Worker execution reuses the accepted snapshots unless
  // a final safety validation requires another read.
  assertEquals(technicalDetailsRequestCount, 6);
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        `SELECT SUM(stream_details_available)
         FROM episode_media_versions
         WHERE episode_rating_key IN ('manual-episode-1', 'manual-episode-2')`,
      ).value<[number]>()?.[0]
    ),
    4,
  );
  await settle();
  const executionErrors = withTransaction((client) =>
    client.prepare(
      'SELECT target_key, error FROM deletion_targets WHERE operation_id = ? ORDER BY ordinal',
    ).values(result.operationId)
  );
  assertEquals(
    getDeletionOperation(result.operationId, 1)?.status,
    'completed',
    JSON.stringify(executionErrors),
  );
  assertEquals(live.get('manual-episode-1')?.Media?.map((media) => media.id), [102]);
  assertEquals(live.get('manual-episode-2')?.Media?.map((media) => media.id), [202]);
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM media_version_reservations WHERE operation_id = ?',
      ).value<[number]>(result.operationId)?.[0]
    ),
    0,
  );
});

Deno.test('season planner persists live Plex metadata instead of a stale sync projection', async () => {
  reset();
  addManualSeasonEpisode('live-show', 'live-season', 'live-episode', 1, [701, 702]);
  withTransaction((client) =>
    client.prepare(
      `UPDATE episode_media_versions
       SET video_resolution = '4k', bitrate = 99, video_codec = 'hevc', container = 'mp4'
       WHERE episode_rating_key = 'live-episode' AND media_id = 701`,
    ).run()
  );
  const previewResponse = await app.request(
    '/api/duplicates/seasons/live-season/deletion-preview',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selections: [{ episodeRatingKey: 'live-episode', mediaIds: [701] }],
        coordinateSonarr: false,
        cleanupDownloads: false,
      }),
    },
  );
  assertEquals(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json();
  const cleanupResponse = await app.request('/api/duplicates/seasons/live-season/cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'live-authoritative-season',
      previewFingerprint: preview.fingerprint,
      selections: [{ episodeRatingKey: 'live-episode', mediaIds: [701] }],
      coordinateSonarr: false,
      cleanupDownloads: false,
    }),
  });
  assertEquals(cleanupResponse.status, 202, await cleanupResponse.clone().text());
  const { operationId } = await cleanupResponse.json();
  const snapshot = withTransaction((client) =>
    client.prepare('SELECT snapshot FROM deletion_targets WHERE operation_id = ?').value<[string]>(
      operationId,
    )?.[0]
  );
  assertEquals(JSON.parse(snapshot!).videoResolution, '720');
  assertEquals(JSON.parse(snapshot!).bitrate, 2_000);
  assertEquals(JSON.parse(snapshot!).videoCodec, 'h264');
  assertEquals(JSON.parse(snapshot!).container, 'mkv');

  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'completed');
});

Deno.test('season worker revalidates every reviewed retained version', async () => {
  reset();
  addManualSeasonEpisode('retained-show', 'retained-season', 'retained-episode', 1, [
    801,
    802,
    803,
  ]);
  const previewResponse = await app.request(
    '/api/duplicates/seasons/retained-season/deletion-preview',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selections: [{ episodeRatingKey: 'retained-episode', mediaIds: [801] }],
        coordinateSonarr: false,
        cleanupDownloads: false,
      }),
    },
  );
  assertEquals(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json();
  const cleanupResponse = await app.request('/api/duplicates/seasons/retained-season/cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'all-retained-season',
      previewFingerprint: preview.fingerprint,
      selections: [{ episodeRatingKey: 'retained-episode', mediaIds: [801] }],
      coordinateSonarr: false,
      cleanupDownloads: false,
    }),
  });
  assertEquals(cleanupResponse.status, 202, await cleanupResponse.clone().text());
  const { operationId } = await cleanupResponse.json();
  const snapshot = withTransaction((client) =>
    client.prepare('SELECT snapshot FROM deletion_targets WHERE operation_id = ?').value<[string]>(
      operationId,
    )?.[0]
  );
  assertEquals(
    JSON.parse(snapshot!).expectedRetainedVersions.map((entry: { mediaId: number }) =>
      entry.mediaId
    ),
    [802, 803],
  );

  const changedRetained = live.get('retained-episode')!.Media!.find((media) => media.id === 803)!;
  changedRetained.bitrate = 99_000;
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'needs_attention');
  assertEquals(live.get('retained-episode')?.Media?.map((media) => media.id), [801, 802, 803]);
});

Deno.test('season worker rejects selected or retained Plex path drift after enqueue', async () => {
  for (const changedMediaId of [801, 802]) {
    reset();
    addManualSeasonEpisode('path-show', 'path-season', 'path-episode', 1, [801, 802]);
    const previewResponse = await app.request(
      '/api/duplicates/seasons/path-season/deletion-preview',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          selections: [{ episodeRatingKey: 'path-episode', mediaIds: [801] }],
          coordinateSonarr: false,
          cleanupDownloads: false,
        }),
      },
    );
    assertEquals(previewResponse.status, 200, await previewResponse.clone().text());
    const preview = await previewResponse.json();
    const cleanupResponse = await app.request('/api/duplicates/seasons/path-season/cleanup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientRequestId: `season-path-drift-${changedMediaId}`,
        previewFingerprint: preview.fingerprint,
        selections: [{ episodeRatingKey: 'path-episode', mediaIds: [801] }],
        coordinateSonarr: false,
        cleanupDownloads: false,
      }),
    });
    assertEquals(cleanupResponse.status, 202, await cleanupResponse.clone().text());
    const { operationId } = await cleanupResponse.json();
    live.get('path-episode')!.Media!.find((media) => media.id === changedMediaId)!.Part = [{
      file: `/tv/path-drift-${changedMediaId}.mkv`,
      size: 50_000,
    }];

    await settle();
    assertEquals(getDeletionOperation(operationId, 1)?.status, 'needs_attention');
    assertEquals(live.get('path-episode')?.Media?.map((media) => media.id), [801, 802]);
  }
});

Deno.test('season planning rejects a live Plex machine that is not the selected server', async () => {
  reset();
  addManualSeasonEpisode('identity-show', 'identity-season', 'identity-episode', 1, [701, 702]);
  plexMachineIdentifier = 'different-machine';

  const requests = [
    {
      path: '/api/duplicates/seasons/identity-season/deletion-preview',
      body: {
        selections: [{ episodeRatingKey: 'identity-episode', mediaIds: [701] }],
        coordinateSonarr: false,
        cleanupDownloads: false,
      },
    },
    {
      path: '/api/duplicates/seasons/identity-season/cleanup',
      body: {
        clientRequestId: 'identity-mismatch-season',
        previewFingerprint: 'a'.repeat(64),
        selections: [{ episodeRatingKey: 'identity-episode', mediaIds: [701] }],
        coordinateSonarr: false,
        cleanupDownloads: false,
      },
    },
  ];
  for (const request of requests) {
    const response = await app.request(request.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
    });
    assertEquals(response.status, 409);
    assertStringIncludes((await response.json()).error, 'does not match the selected server');
  }
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM deletion_operations WHERE client_request_id = ?',
      ).value<[number]>('identity-mismatch-season')?.[0]
    ),
    0,
  );
});

Deno.test('season worker rejects ancestry, playback, and machine drift after enqueue', async () => {
  for (const scenario of ['ancestry', 'playback', 'machine'] as const) {
    reset();
    addManualSeasonEpisode('safety-show', 'safety-season', 'safety-episode', 1, [811, 812]);
    const previewResponse = await app.request(
      '/api/duplicates/seasons/safety-season/deletion-preview',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          selections: [{ episodeRatingKey: 'safety-episode', mediaIds: [811] }],
          coordinateSonarr: false,
          cleanupDownloads: false,
        }),
      },
    );
    assertEquals(previewResponse.status, 200, await previewResponse.clone().text());
    const preview = await previewResponse.json();
    const cleanupResponse = await app.request('/api/duplicates/seasons/safety-season/cleanup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientRequestId: `season-${scenario}-drift`,
        previewFingerprint: preview.fingerprint,
        selections: [{ episodeRatingKey: 'safety-episode', mediaIds: [811] }],
        coordinateSonarr: false,
        cleanupDownloads: false,
      }),
    });
    assertEquals(cleanupResponse.status, 202, await cleanupResponse.clone().text());
    const { operationId } = await cleanupResponse.json();

    if (scenario === 'ancestry') {
      live.get('safety-episode')!.parentRatingKey = 'another-season';
    } else if (scenario === 'playback') {
      activePlaybackRatingKey = 'safety-episode';
    } else {
      plexMachineIdentifier = 'another-machine';
    }

    await settle();
    assertEquals(getDeletionOperation(operationId, 1)?.status, 'needs_attention');
    assertEquals(live.get('safety-episode')?.Media?.map((media) => media.id), [811, 812]);
  }
});

Deno.test('season worker rejects an active server change after enqueue', async () => {
  reset();
  addManualSeasonEpisode('server-show', 'server-season', 'server-episode', 1, [821, 822]);
  const preview = await seasonPreviewEvidence('server-season', ['server-episode']);
  const response = await seasonCleanupRequest('server-season', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-active-server-drift',
      selections: [{ episodeRatingKey: 'server-episode', mediaIds: [821] }],
      ...preview,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const { operationId } = await response.json();

  withTransaction((client) => {
    client.prepare(
      "INSERT OR IGNORE INTO servers (id, machine_identifier, name, url, access_token, last_connected_at) VALUES (2, 'machine-2', 'Other Plex', 'http://plex-two', 'other-token', 1)",
    ).run();
    client.prepare('UPDATE settings SET active_server_id = 2 WHERE id = 1').run();
  });
  clearPlexClientCache();
  try {
    await settle();
    assertEquals(getDeletionOperation(operationId, 1)?.status, 'needs_attention');
    assertEquals(live.get('server-episode')?.Media?.map((media) => media.id), [821, 822]);
  } finally {
    withTransaction((client) =>
      client.prepare('UPDATE settings SET active_server_id = 1 WHERE id = 1').run()
    );
    clearPlexClientCache();
  }
});

Deno.test('dedicated season cleanup accepts episode selections without a media type', async () => {
  reset();
  addManualSeasonEpisode('legacy-show', 'legacy-season', 'legacy-episode', 1, [111, 112]);
  const preview = await seasonPreviewEvidence('legacy-season', ['legacy-episode']);

  const response = await seasonCleanupRequest('legacy-season', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'legacy-season-cleanup',
      selections: [{ episodeRatingKey: 'legacy-episode', mediaIds: [111] }],
      ...preview,
    }),
  });

  assertEquals(response.status, 202, await response.clone().text());
  const result = await response.json();
  assertEquals(result.targetCount, 1);
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT target_kind, target_key FROM deletion_targets WHERE operation_id = ?',
      ).value<[string, string]>(result.operationId)
    ),
    ['episode_version', 'legacy-episode:111'],
  );
});

Deno.test('concurrent identical season commands converge on one operation', async () => {
  reset();
  addManualSeasonEpisode('concurrent-show', 'concurrent-season', 'concurrent-episode', 1, [
    111,
    112,
  ]);
  const preview = await seasonPreviewEvidence('concurrent-season', ['concurrent-episode']);
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'concurrent-season-command',
      previewFingerprint: preview.previewFingerprint,
      selections: [{ episodeRatingKey: 'concurrent-episode', mediaIds: [111] }],
      coordinateSonarr: false,
      cleanupDownloads: false,
    }),
  };
  const responses = await Promise.all([
    app.request('/api/duplicates/seasons/concurrent-season/cleanup', init),
    app.request('/api/duplicates/seasons/concurrent-season/cleanup', init),
  ]);
  assertEquals(responses.map((response) => response.status), [202, 202]);
  const results = await Promise.all(responses.map((response) => response.json()));
  assertEquals(results[0].operationId, results[1].operationId);
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM deletion_operations WHERE client_request_id = ?',
      ).value<[number]>('concurrent-season-command')?.[0]
    ),
    1,
  );
});

Deno.test('concurrent conflicting season commands enqueue only one intent', async () => {
  reset();
  addManualSeasonEpisode('conflict-show', 'conflict-season', 'conflict-episode', 1, [121, 122]);
  const preview = async (mediaId: number) => {
    const response = await app.request('/api/duplicates/seasons/conflict-season/deletion-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selections: [{ episodeRatingKey: 'conflict-episode', mediaIds: [mediaId] }],
        coordinateSonarr: false,
        cleanupDownloads: false,
      }),
    });
    assertEquals(response.status, 200, await response.clone().text());
    return await response.json();
  };
  const [leftPreview, rightPreview] = await Promise.all([preview(121), preview(122)]);
  const submit = (mediaId: number, previewFingerprint: string) =>
    app.request('/api/duplicates/seasons/conflict-season/cleanup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientRequestId: 'concurrent-conflicting-season',
        previewFingerprint,
        selections: [{ episodeRatingKey: 'conflict-episode', mediaIds: [mediaId] }],
        coordinateSonarr: false,
        cleanupDownloads: false,
      }),
    });
  const responses = await Promise.all([
    submit(121, leftPreview.fingerprint),
    submit(122, rightPreview.fingerprint),
  ]);
  assertEquals(responses.map((response) => response.status).sort(), [202, 409]);
  const conflict = responses.find((response) => response.status === 409)!;
  assertEquals((await conflict.json()).code, 'REQUEST_ID_CONFLICT');
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM deletion_operations WHERE client_request_id = ?',
      ).value<[number]>('concurrent-conflicting-season')?.[0]
    ),
    1,
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        `SELECT COUNT(*)
         FROM deletion_targets t
         JOIN deletion_operations o ON o.id = t.operation_id
         WHERE o.client_request_id = ?`,
      ).value<[number]>('concurrent-conflicting-season')?.[0]
    ),
    1,
  );
});

Deno.test('ordinary smart cleanup still requires an explicit media type', async () => {
  reset();
  addSmartCleanupMovie('strict-smart-route');

  const response = await app.request('/api/duplicates/smart-cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'strict-smart-cleanup',
      selections: [{ ratingKey: 'strict-smart-route', deleteMediaIds: [11] }],
      includeNearIdentical: false,
    }),
  });

  assertEquals(response.status, 400);
  assertEquals((await response.json()).error, 'one or more cleanup selections are invalid');
});

Deno.test('generic smart cleanup rejects the removed manual-season path', async () => {
  reset();
  const response = await app.request('/api/duplicates/smart-cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'removed-manual-season-path',
      selections: [{ mediaType: 'episode', ratingKey: 'episode-1', deleteMediaIds: [21] }],
      includeNearIdentical: true,
      manualSeasonReview: true,
    }),
  });
  assertEquals(response.status, 400);
  assertStringIncludes((await response.json()).error, 'dedicated season endpoint');
});

Deno.test('season deletion preview rejects empty and oversized selections before planning', async () => {
  reset();

  for (
    const selections of [
      [],
      [{
        episodeRatingKey: 'episode-1',
        mediaIds: Array.from({ length: 11 }, (_, index) => index),
      }],
    ]
  ) {
    const response = await app.request('/api/duplicates/seasons/season-1/deletion-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selections,
        coordinateSonarr: false,
        cleanupDownloads: false,
      }),
    });
    assertEquals(response.status, 400);
    assert(typeof (await response.json()).error === 'string');
  }
});

Deno.test('season cleanup requires verified download coverage when cleanup is selected', async () => {
  reset();
  addManualSeasonEpisode('download-show', 'download-season', 'download-episode', 1, [111, 112]);
  const preview = await seasonPreviewEvidence('download-season', ['download-episode'], {
    coordinateSonarr: false,
    cleanupDownloads: true,
  });
  const response = await seasonCleanupRequest('download-season', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-download-cleanup',
      selections: [{ episodeRatingKey: 'download-episode', mediaIds: [111] }],
      ...preview,
    }),
  });
  assertEquals(response.status, 409);
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT COUNT(*) FROM deletion_operations WHERE client_request_id LIKE 'season-download-cleanup:%'",
      ).value<[number]>()?.[0]
    ),
    0,
  );
});

Deno.test('season cleanup deletes an exactly verified qBittorrent job when selected', async () => {
  reset();
  configureSonarr(true);
  addEpisode();
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/better.mkv';
  seasonPackQbit = true;
  qbitPresent = true;
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];
  const availabilityPreview = await seasonPreviewEvidence('season-1', ['episode-1'], {
    coordinateSonarr: true,
    cleanupDownloads: false,
  });
  const preview = await seasonPreviewEvidence('season-1', ['episode-1'], {
    coordinateSonarr: true,
    cleanupDownloads: true,
  });
  assert(preview.previewFingerprint !== availabilityPreview.previewFingerprint);
  const response = await seasonCleanupRequest('season-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-qbit-cleanup',
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      ...preview,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const result = await response.json();
  const queuedSnapshot = withTransaction((client) =>
    client.prepare('SELECT snapshot FROM deletion_targets WHERE operation_id = ?').value<[string]>(
      result.operationId,
    )?.[0]
  );
  const snapshot = JSON.parse(queuedSnapshot!);
  assertEquals(snapshot.cleanupDownloads, true);
  assertEquals(snapshot.seasonCoordinationOutcome, 'automatic_adoption');
  assertEquals(snapshot.arrOwnerships, [{
    instanceId: 2,
    recordId: 8,
    episodeId: 9,
    managedFileId: 10,
    managedPath: sonarrManagedPath,
    managedMediaId: 21,
  }]);
  assertEquals(snapshot.seasonDownloadCleanup.ratingKey, 'show-1');
  assertEquals(
    snapshot.seasonDownloadCleanup.downloadJobs.map((job: { jobId: string }) => job.jobId),
    [
      torrentHash,
    ],
  );
  withTransaction((client) =>
    client.prepare("UPDATE deletion_targets SET phase = 'arr_coordination' WHERE operation_id = ?")
      .run(result.operationId)
  );
  await settle();
  const operation = getDeletionOperation(result.operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(qbitDeleteCount, 1);
  assertEquals(versionDeleteOrder, ['qbit', 'sonarr']);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [22]);
});

Deno.test('season cleanup proves direct qBittorrent ownership without Sonarr', async () => {
  reset();
  addEpisode();
  const localRoot = resolve(testDirectory, 'direct-qbit').replaceAll('\\', '/');
  const localRelease = `${localRoot}/release`;
  const localSelected = `${localRelease}/old.mkv`;
  const localRetained = `${localRelease}/retained.mkv`;
  await Deno.mkdir(localRelease, { recursive: true });
  await Promise.all([
    Deno.writeFile(localSelected, new Uint8Array(40_000)),
    Deno.writeFile(localRetained, new Uint8Array(40_000)),
  ]);
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO qbittorrent_instances (id, server_id, name, url, username, password, created_at, updated_at) VALUES (1, 1, 'qBittorrent', 'http://qbit', '', '', 1, 1)",
    ).run();
    client.prepare(
      `INSERT INTO plex_path_mappings
       (server_id, library_key, plex_path, local_path, case_sensitive, revision,
        validation_plex_path, validation_local_path, validation_size,
        validated_at, created_at, updated_at)
       VALUES (1, 'shows', '/tv/Show/Season 01', ?, 1, 1,
               '/tv/Show/Season 01/old.mkv', ?, 40000, 1, 1, 1)`,
    ).run(localRelease, localSelected);
    client.prepare(
      `INSERT INTO qbittorrent_path_mappings
       (server_id, instance_key, qbittorrent_path, local_path, case_sensitive, revision,
        validation_qbittorrent_path, validation_local_path, validation_size,
        validated_at, created_at, updated_at)
       VALUES (1, 'db:1', '/downloads', ?, 1, 1,
               '/downloads/release/old.mkv', ?, 40000, 1, 1, 1)`,
    ).run(localRoot, localSelected);
  });
  seasonPackQbit = true;
  qbitPresent = true;
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: '/tv/Show/Season 01/old.mkv', size: 40_000 }] },
    { id: 22, Part: [{ file: '/tv/Show/Season 01/retained.mkv', size: 40_000 }] },
  ];

  const preview = await seasonPreviewEvidence('season-1', ['episode-1'], {
    sonarrMode: 'none',
    cleanupDownloads: true,
  });
  const response = await seasonCleanupRequest('season-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-direct-qbit-without-sonarr',
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      ...preview,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const result = await response.json();
  await settle();

  assertEquals(
    getDeletionOperation(result.operationId, 1)?.status,
    'completed',
    JSON.stringify(getDeletionOperation(result.operationId, 1)),
  );
  assertEquals(qbitDeleteCount, 1);
  assertEquals(versionDeleteOrder, ['qbit', 'plex']);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [22]);
});

Deno.test('direct qBittorrent cleanup survives Sonarr becoming unavailable', async () => {
  reset();
  addEpisode();
  configureSonarr();
  const localRoot = resolve(testDirectory, 'direct-qbit-sonarr-outage').replaceAll('\\', '/');
  const localRelease = `${localRoot}/release`;
  const localSelected = `${localRelease}/old.mkv`;
  const localRetained = `${localRelease}/retained.mkv`;
  await Deno.mkdir(localRelease, { recursive: true });
  await Promise.all([
    Deno.writeFile(localSelected, new Uint8Array(40_000)),
    Deno.writeFile(localRetained, new Uint8Array(40_000)),
  ]);
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO qbittorrent_instances (id, server_id, name, url, username, password, created_at, updated_at) VALUES (1, 1, 'qBittorrent', 'http://qbit', '', '', 1, 1)",
    ).run();
    client.prepare(
      `INSERT INTO plex_path_mappings
       (server_id, library_key, plex_path, local_path, case_sensitive, revision,
        validation_plex_path, validation_local_path, validation_size,
        validated_at, created_at, updated_at)
       VALUES (1, 'shows', '/tv/Show/Season 01', ?, 1, 1,
               '/tv/Show/Season 01/old.mkv', ?, 40000, 1, 1, 1)`,
    ).run(localRelease, localSelected);
    client.prepare(
      `INSERT INTO qbittorrent_path_mappings
       (server_id, instance_key, qbittorrent_path, local_path, case_sensitive, revision,
        validation_qbittorrent_path, validation_local_path, validation_size,
        validated_at, created_at, updated_at)
       VALUES (1, 'db:1', '/downloads', ?, 1, 1,
               '/downloads/release/old.mkv', ?, 40000, 1, 1, 1)`,
    ).run(localRoot, localSelected);
  });
  seasonPackQbit = true;
  sonarrHistoryUnavailable = true;
  qbitPresent = true;
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: '/tv/Show/Season 01/old.mkv', size: 40_000 }] },
    { id: 22, Part: [{ file: '/tv/Show/Season 01/retained.mkv', size: 40_000 }] },
  ];

  const preview = await seasonPreviewEvidence('season-1', ['episode-1'], {
    sonarrMode: 'none',
    cleanupDownloads: true,
  });
  const response = await seasonCleanupRequest('season-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-direct-qbit-sonarr-outage',
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      ...preview,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const result = await response.json();
  sonarrUnavailable = true;
  await settle();

  assertEquals(
    getDeletionOperation(result.operationId, 1)?.status,
    'completed',
    JSON.stringify(getDeletionOperation(result.operationId, 1)),
  );
  assertEquals(qbitDeleteCount, 1);
  assertEquals(versionDeleteOrder, ['qbit', 'plex']);
});

Deno.test('direct qBittorrent cleanup rejects Plex mapping drift after enqueue', async () => {
  reset();
  addEpisode();
  const localRoot = resolve(testDirectory, 'direct-qbit-mapping-drift').replaceAll('\\', '/');
  const localRelease = `${localRoot}/release`;
  const localSelected = `${localRelease}/old.mkv`;
  const localRetained = `${localRelease}/retained.mkv`;
  await Deno.mkdir(localRelease, { recursive: true });
  await Promise.all([
    Deno.writeFile(localSelected, new Uint8Array(40_000)),
    Deno.writeFile(localRetained, new Uint8Array(40_000)),
  ]);
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO qbittorrent_instances (id, server_id, name, url, username, password, created_at, updated_at) VALUES (1, 1, 'qBittorrent', 'http://qbit', '', '', 1, 1)",
    ).run();
    client.prepare(
      `INSERT INTO plex_path_mappings
       (server_id, library_key, plex_path, local_path, case_sensitive, revision,
        validation_plex_path, validation_local_path, validation_size,
        validated_at, created_at, updated_at)
       VALUES (1, 'shows', '/tv/Show/Season 01', ?, 1, 1,
               '/tv/Show/Season 01/old.mkv', ?, 40000, 1, 1, 1)`,
    ).run(localRelease, localSelected);
    client.prepare(
      `INSERT INTO qbittorrent_path_mappings
       (server_id, instance_key, qbittorrent_path, local_path, case_sensitive, revision,
        validation_qbittorrent_path, validation_local_path, validation_size,
        validated_at, created_at, updated_at)
       VALUES (1, 'db:1', '/downloads', ?, 1, 1,
               '/downloads/release/old.mkv', ?, 40000, 1, 1, 1)`,
    ).run(localRoot, localSelected);
  });
  seasonPackQbit = true;
  qbitPresent = true;
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: '/tv/Show/Season 01/old.mkv', size: 40_000 }] },
    { id: 22, Part: [{ file: '/tv/Show/Season 01/retained.mkv', size: 40_000 }] },
  ];

  const preview = await seasonPreviewEvidence('season-1', ['episode-1'], {
    sonarrMode: 'none',
    cleanupDownloads: true,
  });
  const response = await seasonCleanupRequest('season-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-direct-qbit-plex-mapping-drift',
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      ...preview,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const result = await response.json();
  withTransaction((client) =>
    client.prepare(
      "UPDATE plex_path_mappings SET revision = 2, updated_at = 2 WHERE server_id = 1 AND library_key = 'shows'",
    ).run()
  );

  await settle();

  const operation = getDeletionOperation(result.operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assertStringIncludes(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error),
    'Plex path mapping changed',
  );
  assertEquals(qbitDeleteCount, 0);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [21, 22]);
});

Deno.test('Plex-only season cleanup remains available with unsupported Sonarr', async () => {
  reset();
  configureSonarr();
  addEpisode();
  sonarrReportedVersion = '4.0.18.1000';
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: '/tv/Show/Season 01/old.mkv', size: 40_000 }] },
    { id: 22, Part: [{ file: '/tv/Show/Season 01/retained.mkv', size: 40_000 }] },
  ];

  const previewResponse = await app.request(
    '/api/duplicates/seasons/season-1/deletion-preview',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
        sonarrMode: 'none',
        cleanupDownloads: false,
      }),
    },
  );
  assertEquals(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json();
  assertStringIncludes(
    String(preview.sonarrInspectionWarning),
    'Plex-only cleanup remains available',
  );
  assertEquals(preview.sonarrAvailable, false);
  assertEquals(preview.breakGlassAvailable, false);

  const response = await seasonCleanupRequest('season-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-plex-only-unsupported-sonarr',
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      previewFingerprint: preview.fingerprint,
      sonarrMode: 'none',
      cleanupDownloads: false,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const result = await response.json();
  await settle();

  assertEquals(
    getDeletionOperation(result.operationId, 1)?.status,
    'completed',
    JSON.stringify(getDeletionOperation(result.operationId, 1)),
  );
  assertEquals(sonarrMonitorMutationCount, 0);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [22]);
});

Deno.test('season adoption selects the best retained candidate that passes exact preflight', async () => {
  reset();
  configureSonarr(true);
  addEpisode();
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO episode_media_versions (server_id, media_id, episode_rating_key, season_rating_key, show_rating_key, library_key, episode_title, episode_index, season_index, file_size, updated_at) VALUES (1, 23, 'episode-1', 'season-1', 'show-1', 'shows', 'Pilot', 1, 1, 40, 1)",
    ).run();
  });
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/retained-safe.mkv';
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: '/tv/Show/Season 01/retained-rejected.mkv', size: 40_000 }] },
    { id: 23, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];

  const previewResponse = await app.request(
    '/api/duplicates/seasons/season-1/deletion-preview',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
        sonarrMode: 'adopt_retained',
        cleanupDownloads: false,
      }),
    },
  );
  assertEquals(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json();
  assertEquals(preview.sonarrAdoptionTargets, [{
    episodeRatingKey: 'episode-1',
    episodeTitle: 'Pilot',
    mediaId: 23,
    path: sonarrRescanTargetPath,
    fallbackCandidateCount: 0,
  }]);
  const response = await seasonCleanupRequest('season-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-safe-retained-candidate',
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      previewFingerprint: preview.fingerprint,
      sonarrMode: 'adopt_retained',
      cleanupDownloads: false,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const { operationId } = await response.json();
  const queuedSnapshot = withTransaction((client) =>
    client.prepare('SELECT snapshot FROM deletion_targets WHERE operation_id = ?').value<[string]>(
      operationId,
    )?.[0]
  );
  const snapshot = JSON.parse(queuedSnapshot!);
  assertEquals(snapshot.seasonSelectedCandidateMediaId, 23);
  assertEquals(snapshot.seasonSafeCandidateMediaIds, [23]);
  assertEquals(snapshot.seasonPreDeletionPreflight.path, sonarrRescanTargetPath);

  await settle();
  assertEquals(
    getDeletionOperation(operationId, 1)?.status,
    'completed',
    JSON.stringify(getDeletionOperation(operationId, 1)),
  );
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [22, 23]);
});

Deno.test('season adoption rejects a retained candidate whose Sonarr preflight size differs', async () => {
  reset();
  configureSonarr(true);
  addEpisode();
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/retained.mkv';
  sonarrManualImportSize = 41_000;
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];

  const response = await app.request(
    '/api/duplicates/seasons/season-1/deletion-preview',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
        sonarrMode: 'adopt_retained',
        cleanupDownloads: false,
      }),
    },
  );

  assertEquals(response.status, 409, await response.clone().text());
  assertEquals(sonarrMonitorMutationCount, 0);
  assertEquals(sonarrManagedFilePresent, true);
});

Deno.test('season adoption refuses Sonarr version drift before the first mutation', async () => {
  reset();
  configureSonarr(true);
  addEpisode();
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/retained.mkv';
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];
  const preview = await seasonPreviewEvidence('season-1', ['episode-1'], {
    sonarrMode: 'adopt_retained',
    cleanupDownloads: false,
  });
  const response = await seasonCleanupRequest('season-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-sonarr-version-drift',
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      ...preview,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const { operationId } = await response.json();
  const acceptedSnapshot = withTransaction((client) =>
    client.prepare('SELECT snapshot FROM deletion_targets WHERE operation_id = ?').value<[string]>(
      operationId,
    )?.[0]
  );
  assertEquals(
    JSON.parse(acceptedSnapshot!).seasonPreDeletionPreflight.path,
    sonarrRescanTargetPath,
  );

  sonarrReportedVersion = '5.0.0.1';
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assertStringIncludes(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error),
    'supported v4 baseline',
  );
  assertEquals(
    (operation?.targets as Array<{ seasonRemovedUnmonitoredAvailable?: boolean }>)[0]
      ?.seasonRemovedUnmonitoredAvailable,
    false,
  );
  assertEquals(sonarrMonitorMutationCount, 0);
  assertEquals(sonarrManagedFilePresent, true);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [21, 22]);
});

Deno.test('season cleanup rejects download manifest drift after enqueue', async () => {
  reset();
  configureSonarr(true);
  addEpisode();
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/better.mkv';
  seasonPackQbit = true;
  qbitPresent = true;
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];
  const previewResponse = await app.request(
    '/api/duplicates/seasons/season-1/deletion-preview',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
        coordinateSonarr: true,
        cleanupDownloads: true,
      }),
    },
  );
  assertEquals(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json();
  const response = await app.request('/api/duplicates/seasons/season-1/cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-qbit-manifest-drift',
      previewFingerprint: preview.fingerprint,
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      coordinateSonarr: true,
      cleanupDownloads: true,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const { operationId } = await response.json();
  seasonPackMixed = true;

  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'needs_attention');
  assertEquals(qbitDeleteCount, 0);
  assertEquals(sonarrMonitored, true);
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM torrent_delete_attempts WHERE server_id = 1 AND rating_key = ?',
      ).value<[number]>('show-1')?.[0]
    ),
    0,
  );
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [21, 22]);
});

Deno.test('season cleanup rejects Sonarr ownership drift after preview acceptance', async () => {
  reset();
  configureSonarr(true);
  addEpisode();
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/better.mkv';
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];
  const preview = await seasonPreviewEvidence('season-1', ['episode-1'], {
    coordinateSonarr: true,
    cleanupDownloads: false,
  });
  const response = await seasonCleanupRequest('season-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-sonarr-drift',
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      ...preview,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const result = await response.json();

  sonarrManagedMediaId = 22;
  sonarrManagedPath = sonarrRescanTargetPath;
  await settle();

  const operation = getDeletionOperation(result.operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assertStringIncludes(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error),
    'ownership',
  );
  assertEquals(sonarrRescanCount, 0);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [21, 22]);
});

Deno.test('season cleanup coordinates the managed version after Plex-only siblings', async () => {
  reset();
  configureSonarr();
  addEpisode();
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO episode_media_versions (server_id, media_id, episode_rating_key, season_rating_key, show_rating_key, library_key, episode_title, episode_index, season_index, file_size, updated_at) VALUES (1, 23, 'episode-1', 'season-1', 'show-1', 'shows', 'Pilot', 1, 1, 40, 1)",
    ).run();
  });
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/retained.mkv';
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: '/tv/Show/Season 01/plex-only.mkv', size: 40_000 }] },
    { id: 23, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];
  const previewResponse = await app.request(
    '/api/duplicates/seasons/season-1/deletion-preview',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21, 22] }],
        coordinateSonarr: true,
        cleanupDownloads: false,
      }),
    },
  );
  assertEquals(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json();
  assertEquals(preview.automaticAdoptionCount, 1);
  assertEquals(preview.plexOnlyCount, 1);
  assertEquals(
    preview.members.map((member: { selectedMediaIds: number[]; outcome: string }) => [
      member.selectedMediaIds,
      member.outcome,
    ]),
    [
      [[21], 'automatic_adoption'],
      [[22], 'plex_only'],
    ],
  );
  const response = await seasonCleanupRequest('season-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-multi-version-sonarr',
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21, 22] }],
      previewFingerprint: preview.fingerprint,
      coordinateSonarr: true,
      cleanupDownloads: false,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const result = await response.json();
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT target_key, json_extract(snapshot, '$.seasonCoordinationOutcome') FROM deletion_targets WHERE operation_id = ? ORDER BY ordinal",
      ).values(result.operationId)
    ),
    [
      ['episode-1:22', 'plex_only'],
      ['episode-1:21', 'automatic_adoption'],
    ],
  );

  await settle();

  assertEquals(
    getDeletionOperation(result.operationId, 1)?.status,
    'completed',
    JSON.stringify(getDeletionOperation(result.operationId, 1)),
  );
  assertEquals(sonarrRescanCount, 1);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [23]);
});

Deno.test('season rescan coordinates two active automatic-adoption targets', async () => {
  reset();
  configureSonarr();
  addEpisode();
  const sibling = addAdditionalSonarrEpisode(2, 31, 32);
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/episode-1-old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/episode-1-retained.mkv';
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];
  let monitoringAtRescan: boolean[] | null = null;
  sonarrRescanHook = () => {
    monitoringAtRescan = [sonarrMonitored, sibling.monitored];
  };
  const selections = [
    { episodeRatingKey: 'episode-1', mediaIds: [21] },
    { episodeRatingKey: sibling.ratingKey, mediaIds: [sibling.managedMediaId] },
  ];
  const previewResponse = await app.request(
    '/api/duplicates/seasons/season-1/deletion-preview',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selections,
        coordinateSonarr: true,
        cleanupDownloads: false,
      }),
    },
  );
  assertEquals(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json();
  assertEquals(preview.automaticAdoptionCount, 2);
  assertEquals(preview.plexOnlyCount, 0);
  const response = await seasonCleanupRequest('season-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-two-automatic-adoptions',
      selections,
      previewFingerprint: preview.fingerprint,
      coordinateSonarr: true,
      cleanupDownloads: false,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const { operationId } = await response.json();
  rejectSonarrManualImportStatus = 400;

  await settle();

  assertEquals(
    getDeletionOperation(operationId, 1)?.status,
    'completed',
    JSON.stringify(getDeletionOperation(operationId, 1)),
  );
  assertEquals(monitoringAtRescan, [false, false]);
  assertEquals(sonarrMonitored, true);
  assertEquals(sibling.monitored, true);
  assertEquals(sonarrManagedPath, sonarrRescanTargetPath);
  assertEquals(sibling.managedPath, sibling.retainedPath);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [22]);
  assertEquals(live.get(sibling.ratingKey)?.Media?.map((media) => media.id), [32]);
});

Deno.test('season rescan restores protected automatic-adoption siblings after coordination failure', async () => {
  reset();
  configureSonarr();
  addEpisode();
  const protectedSibling = addAdditionalSonarrEpisode(2, 31, 32);
  const failingSibling = addAdditionalSonarrEpisode(3, 41, 42);
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/episode-1-old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/episode-1-retained.mkv';
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];
  const selections = [
    { episodeRatingKey: 'episode-1', mediaIds: [21] },
    { episodeRatingKey: protectedSibling.ratingKey, mediaIds: [31] },
    { episodeRatingKey: failingSibling.ratingKey, mediaIds: [41] },
  ];
  const previewResponse = await app.request(
    '/api/duplicates/seasons/season-1/deletion-preview',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selections,
        coordinateSonarr: true,
        cleanupDownloads: false,
      }),
    },
  );
  assertEquals(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json();
  assertEquals(preview.automaticAdoptionCount, 3);
  const response = await seasonCleanupRequest('season-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-automatic-adoption-protection-failure',
      selections,
      previewFingerprint: preview.fingerprint,
      coordinateSonarr: true,
      cleanupDownloads: false,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const { operationId } = await response.json();
  rejectSonarrManualImportStatus = 400;
  rejectSonarrMonitoringEpisodeId = failingSibling.episodeId;

  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'queued', JSON.stringify(operation));
  assertStringIncludes(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error),
    'monitoring rejected',
  );
  assertEquals(sonarrMonitored, false);
  assertEquals(protectedSibling.monitored, true);
  assertEquals(failingSibling.monitored, true);
  assertEquals(sonarrManagedFilePresent, false);
  assertEquals(protectedSibling.managedFilePresent, true);
  assertEquals(failingSibling.managedFilePresent, true);
});

Deno.test('Plex-only season cleanup deletes managed and unmanaged selected siblings', async () => {
  reset();
  configureSonarr();
  addEpisode();
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO episode_media_versions (server_id, media_id, episode_rating_key, season_rating_key, show_rating_key, library_key, episode_title, episode_index, season_index, file_size, updated_at) VALUES (1, 23, 'episode-1', 'season-1', 'show-1', 'shows', 'Pilot', 1, 1, 40, 1)",
    ).run();
  });
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/managed.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/retained.mkv';
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: '/tv/Show/Season 01/plex-only.mkv', size: 40_000 }] },
    { id: 23, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];
  const previewResponse = await app.request(
    '/api/duplicates/seasons/season-1/deletion-preview',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21, 22] }],
        coordinateSonarr: false,
        cleanupDownloads: false,
      }),
    },
  );
  assertEquals(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json();
  assertEquals(preview.automaticAdoptionCount, 0);
  assertEquals(preview.plexOnlyCount, 2);

  const response = await seasonCleanupRequest('season-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-multi-version-plex-only',
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21, 22] }],
      previewFingerprint: preview.fingerprint,
      coordinateSonarr: false,
      cleanupDownloads: false,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const result = await response.json();
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT target_key, json_extract(snapshot, '$.seasonSonarrInspection.managedSelectedMediaIds') FROM deletion_targets WHERE operation_id = ? ORDER BY ordinal",
      ).values(result.operationId)
    ),
    [
      ['episode-1:21', [21]],
      ['episode-1:22', []],
    ],
  );

  await settle();

  assertEquals(
    getDeletionOperation(result.operationId, 1)?.status,
    'completed',
    JSON.stringify(getDeletionOperation(result.operationId, 1)),
  );
  assertEquals(sonarrRescanCount, 0);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [23]);
});

Deno.test('Plex-only season cleanup does not require one Sonarr adoption candidate', async () => {
  reset();
  configureSonarr(true);
  addEpisode();
  withTransaction((client) => {
    client.prepare(
      "INSERT INTO episode_media_versions (server_id, media_id, episode_rating_key, season_rating_key, show_rating_key, library_key, episode_title, episode_index, season_index, file_size, updated_at) VALUES (1, 23, 'episode-1', 'season-1', 'show-1', 'shows', 'Pilot', 1, 1, 40, 1)",
    ).run();
  });
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/managed.mkv';
  seasonPackQbit = true;
  qbitPresent = true;
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: '/tv/Show/Season 01/retained-a.mkv', size: 40_000 }] },
    { id: 23, Part: [{ file: '/tv/Show/Season 01/retained-b.mkv', size: 40_000 }] },
  ];

  const alignmentResponse = await app.request(
    '/api/duplicates/seasons/season-1/analysis',
    { method: 'POST' },
  );
  assertEquals(alignmentResponse.status, 200, await alignmentResponse.clone().text());
  const alignment = await alignmentResponse.json();
  assertEquals(alignment.connections, { sonarr: true, qbittorrent: true });
  assertEquals(alignment.profiles, []);
  assertEquals(alignment.uncertainEpisodeRatingKeys, ['episode-1']);

  const coordinatedPreview = await app.request(
    '/api/duplicates/seasons/season-1/deletion-preview',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
        coordinateSonarr: true,
        cleanupDownloads: false,
      }),
    },
  );
  assertEquals(coordinatedPreview.status, 409);
  assertStringIncludes(
    await coordinatedPreview.text(),
    'could not safely identify the version being kept for this exact episode',
  );

  const previewResponse = await app.request(
    '/api/duplicates/seasons/season-1/deletion-preview',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
        coordinateSonarr: false,
        cleanupDownloads: true,
      }),
    },
  );
  assertEquals(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json();
  assertEquals(preview.sonarrAvailable, true);
  assertEquals(preview.cleanupEligibleVersionCount, 1);
  assertEquals(preview.automaticAdoptionCount, 0);
  assertEquals(preview.plexOnlyCount, 1);

  const response = await seasonCleanupRequest('season-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-multiple-retained-plex-only',
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      previewFingerprint: preview.fingerprint,
      coordinateSonarr: false,
      cleanupDownloads: true,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const result = await response.json();

  await settle();

  assertEquals(
    getDeletionOperation(result.operationId, 1)?.status,
    'completed',
    JSON.stringify(getDeletionOperation(result.operationId, 1)),
  );
  assertEquals(sonarrRescanCount, 0);
  assertEquals(qbitDeleteCount, 1);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [22, 23]);
});

Deno.test('Plex-only season preview uses rejected adoption preflight to offer break glass', async () => {
  reset();
  configureSonarr();
  addEpisode();
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/managed.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/retained.mkv';
  rejectSonarrManualImportPreflight = true;
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];

  const coordinatedPreview = await app.request(
    '/api/duplicates/seasons/season-1/deletion-preview',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
        coordinateSonarr: true,
        cleanupDownloads: false,
      }),
    },
  );
  assertEquals(coordinatedPreview.status, 409);

  const previewResponse = await app.request(
    '/api/duplicates/seasons/season-1/deletion-preview',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
        coordinateSonarr: false,
        cleanupDownloads: false,
      }),
    },
  );
  assertEquals(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json();
  assertEquals(preview.sonarrAvailable, true);
  assertEquals(preview.breakGlassAvailable, true);
  assertStringIncludes(preview.adoptionUnavailableReason, 'could not verify');
  assertEquals(preview.plexOnlyCount, 1);

  const response = await seasonCleanupRequest('season-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-preflight-rejected-plex-only',
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      previewFingerprint: preview.fingerprint,
      coordinateSonarr: false,
      cleanupDownloads: false,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const result = await response.json();

  await settle();

  assertEquals(
    getDeletionOperation(result.operationId, 1)?.status,
    'completed',
    JSON.stringify(getDeletionOperation(result.operationId, 1)),
  );
  assertEquals(sonarrRescanCount, 0);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [22]);
});

Deno.test('Plex-only season preview offers break glass when retained paths are outside Sonarr', async () => {
  reset();
  configureSonarr();
  addEpisode();
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/managed.mkv';
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: '/archive/Show/retained.mkv', size: 40_000 }] },
  ];

  const response = await app.request(
    '/api/duplicates/seasons/season-1/deletion-preview',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
        sonarrMode: 'none',
        cleanupDownloads: false,
      }),
    },
  );

  assertEquals(response.status, 200, await response.clone().text());
  const preview = await response.json();
  assertEquals(preview.sonarrAvailable, true);
  assertEquals(preview.breakGlassAvailable, true);
  assertEquals(preview.automaticAdoptionCount, 0);
  assertEquals(preview.plexOnlyCount, 1);
});

Deno.test('break-glass season removal requires exact old-path absence', async () => {
  reset();
  configureSonarr();
  addEpisode();
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/managed.mkv';
  sonarrOldPathLingersAfterDelete = true;
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: '/archive/Show/retained.mkv', size: 40_000 }] },
  ];
  const preview = await seasonPreviewEvidence('season-1', ['episode-1'], {
    sonarrMode: 'remove_and_unmonitor',
    cleanupDownloads: false,
  });
  const response = await seasonCleanupRequest('season-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-break-glass-path-lingers',
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      ...preview,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const { operationId } = await response.json();

  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'waiting_retry', JSON.stringify(operation));
  assertStringIncludes(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error),
    'record and path absence',
  );
  assertEquals(sonarrMonitored, false);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [22]);
});

Deno.test('season preview rejects break-glass when exact retained adoption is available', async () => {
  reset();
  configureSonarr();
  addEpisode();
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/managed.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/retained.mkv';
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];

  const response = await app.request(
    '/api/duplicates/seasons/season-1/deletion-preview',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
        sonarrMode: 'remove_and_unmonitor',
        cleanupDownloads: false,
      }),
    },
  );

  assertEquals(response.status, 409, await response.clone().text());
  assertStringIncludes(await response.text(), 'can safely adopt');
  assertEquals(sonarrMonitorMutationCount, 0);
  assertEquals(sonarrManagedFilePresent, true);
});

Deno.test('season cleanup uses Plex fallback without touching Sonarr-managed retained media', async () => {
  reset();
  configureSonarr(true);
  addEpisode();
  sonarrManagedMediaId = 22;
  sonarrManagedPath = '/tv/Show/Season 01/managed-retained.mkv';
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: '/tv/Show/Season 01/plex-only.mkv', size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
  ];
  const preview = await seasonPreviewEvidence('season-1', ['episode-1'], {
    coordinateSonarr: true,
    cleanupDownloads: false,
  });
  const response = await seasonCleanupRequest('season-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-plex-fallback',
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      ...preview,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const result = await response.json();
  const queuedSnapshot = withTransaction((client) =>
    client.prepare('SELECT snapshot FROM deletion_targets WHERE operation_id = ?').value<[string]>(
      result.operationId,
    )?.[0]
  );
  assertEquals(JSON.parse(queuedSnapshot!).seasonCoordinationOutcome, 'plex_only');

  await settle();

  const operation = getDeletionOperation(result.operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(sonarrRescanCount, 0);
  assertEquals(sonarrManagedFilePresent, true);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [22]);
});

Deno.test('season cleanup accepts the supported maximum as one fully persisted operation', async () => {
  reset();
  const episodeKeys: string[] = [];
  for (let episode = 1; episode <= 50; episode++) {
    const key = `maximum-episode-${episode.toString().padStart(3, '0')}`;
    episodeKeys.push(key);
    addManualSeasonEpisode(
      'maximum-show',
      'maximum-season',
      key,
      episode,
      [episode * 10 + 1, episode * 10 + 2],
    );
  }
  const preview = await seasonPreviewEvidence('maximum-season', episodeKeys);
  const response = await seasonCleanupRequest('maximum-season', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-supported-maximum',
      selections: episodeKeys.map((episodeRatingKey, index) => ({
        episodeRatingKey,
        mediaIds: [(index + 1) * 10 + 1],
      })),
      ...preview,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const result = await response.json();
  assert(result.operationId);
  assertEquals(result.targetCount, 50);
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        `SELECT COUNT(*), COUNT(r.target_id)
         FROM deletion_targets t
         LEFT JOIN media_version_reservations r ON r.target_id = t.id
         WHERE t.operation_id = ?`,
      ).value<[number, number]>(result.operationId)
    ),
    [50, 50],
  );
});

Deno.test('season cleanup pauses later ordinals and resumes without repeating completed work', async () => {
  reset();
  addManualSeasonEpisode('pause-show', 'pause-season', 'pause-episode-1', 1, [121, 122]);
  addManualSeasonEpisode('pause-show', 'pause-season', 'pause-episode-2', 2, [221, 222]);
  addManualSeasonEpisode('pause-show', 'pause-season', 'pause-episode-3', 3, [321, 322]);
  const preview = await seasonPreviewEvidence('pause-season', [
    'pause-episode-1',
    'pause-episode-2',
    'pause-episode-3',
  ]);
  const response = await seasonCleanupRequest('pause-season', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-pause-resume',
      selections: [
        { episodeRatingKey: 'pause-episode-1', mediaIds: [121] },
        { episodeRatingKey: 'pause-episode-2', mediaIds: [221] },
        { episodeRatingKey: 'pause-episode-3', mediaIds: [321] },
      ],
      ...preview,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const { operationId } = await response.json();
  const originalSecondEpisode = structuredClone(live.get('pause-episode-2')!);
  live.get('pause-episode-2')!.Media = [originalSecondEpisode.Media![0]!];
  await settle();
  const paused = getDeletionOperation(operationId, 1)!;
  assertEquals(paused.status, 'needs_attention');
  assertEquals(paused.completedCount, 1);
  assertEquals(paused.failedCount, 1);
  assertEquals(
    (paused.targets as Array<{ status: string }>).map((target) => target.status),
    ['completed', 'needs_attention', 'queued'],
  );
  const deletesBeforeRetry = plexMediaDeleteCount;
  live.set('pause-episode-2', originalSecondEpisode);
  assertEquals(retryDeletionOperation(operationId, 1), true);
  await settle();
  const completed = getDeletionOperation(operationId, 1)!;
  assertEquals(completed.status, 'completed');
  assertEquals(completed.completedCount, 3);
  assertEquals(plexMediaDeleteCount - deletesBeforeRetry, 2);
});

Deno.test('season cleanup warning pauses later ordinals and remains recheckable', async () => {
  reset();
  addManualSeasonEpisode('warning-show', 'warning-season', 'warning-episode-1', 1, [131, 132]);
  addManualSeasonEpisode('warning-show', 'warning-season', 'warning-episode-2', 2, [231, 232]);
  const preview = await seasonPreviewEvidence('warning-season', [
    'warning-episode-1',
    'warning-episode-2',
  ]);
  const response = await seasonCleanupRequest('warning-season', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-warning-pause',
      selections: [
        { episodeRatingKey: 'warning-episode-1', mediaIds: [131] },
        { episodeRatingKey: 'warning-episode-2', mediaIds: [231] },
      ],
      ...preview,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const { operationId } = await response.json();

  withTransaction((client) => {
    client.prepare(
      `UPDATE deletion_targets
       SET status = 'completed_with_warning', phase = 'plex_reconciliation', warning = 'Plex metadata needs attention'
       WHERE operation_id = ? AND ordinal = 0`,
    ).run(operationId);
    refreshDeletionOperation(client, operationId);
  });

  const paused = getDeletionOperation(operationId, 1)!;
  assertEquals(paused.status, 'needs_attention');
  assertEquals(
    (paused.targets as Array<{ status: string }>).map((target) => target.status),
    ['completed_with_warning', 'queued'],
  );
  assertEquals(retryDeletionOperation(operationId, 1, 'warning'), true);
  assertEquals(
    (getDeletionOperation(operationId, 1)!.targets as Array<{ status: string }>).map((target) =>
      target.status
    ),
    ['queued', 'queued'],
  );
});

Deno.test('finalized season audit warning allows later ordinals without replay', async () => {
  reset();
  addManualSeasonEpisode('audit-show', 'audit-season', 'audit-episode-1', 1, [151, 152]);
  addManualSeasonEpisode('audit-show', 'audit-season', 'audit-episode-2', 2, [251, 252]);
  const preview = await seasonPreviewEvidence('audit-season', [
    'audit-episode-1',
    'audit-episode-2',
  ]);
  const response = await seasonCleanupRequest('audit-season', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-finalized-warning',
      selections: [
        { episodeRatingKey: 'audit-episode-1', mediaIds: [151] },
        { episodeRatingKey: 'audit-episode-2', mediaIds: [251] },
      ],
      ...preview,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const { operationId } = await response.json();

  // Model the first selected version disappearing after acceptance. Its retained
  // version is still valid, so reconciliation produces a finalized audit warning.
  live.get('audit-episode-1')!.Media = [live.get('audit-episode-1')!.Media![1]!];
  const deletesBeforeRun = plexMediaDeleteCount;
  await settle();

  const completed = getDeletionOperation(operationId, 1)!;
  assertEquals(completed.status, 'completed_with_warning');
  assertEquals(
    (completed.targets as Array<{ status: string; phase: string }>).map((target) => [
      target.status,
      target.phase,
    ]),
    [
      ['completed_with_warning', 'finalizing'],
      ['completed', 'finalizing'],
    ],
  );
  assertEquals(plexMediaDeleteCount - deletesBeforeRun, 1);
  assertEquals(live.get('audit-episode-2')?.Media?.map((media) => media.id), [252]);
});

Deno.test('season cleanup requires queued targets to be cancelled before dismissal', async () => {
  reset();
  addManualSeasonEpisode('dismiss-show', 'dismiss-season', 'dismiss-episode-1', 1, [141, 142]);
  addManualSeasonEpisode('dismiss-show', 'dismiss-season', 'dismiss-episode-2', 2, [241, 242]);
  const preview = await seasonPreviewEvidence('dismiss-season', [
    'dismiss-episode-1',
    'dismiss-episode-2',
  ]);
  const response = await seasonCleanupRequest('dismiss-season', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-dismiss-pause',
      selections: [
        { episodeRatingKey: 'dismiss-episode-1', mediaIds: [141] },
        { episodeRatingKey: 'dismiss-episode-2', mediaIds: [241] },
      ],
      ...preview,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const { operationId } = await response.json();

  withTransaction((client) => {
    client.prepare(
      "UPDATE deletion_targets SET status = 'needs_attention', error = 'manual repair required' WHERE operation_id = ? AND ordinal = 0",
    ).run(operationId);
    refreshDeletionOperation(client, operationId);
  });

  assertEquals(dismissDeletionOperation(operationId, 1), false);
  assertEquals(cancelDeletionOperation(operationId, 1), true);
  assertEquals(dismissDeletionOperation(operationId, 1), true);
  const dismissed = getDeletionOperation(operationId, 1)!;
  assertEquals(dismissed.status, 'completed_with_warning');
  assertEquals(
    (dismissed.targets as Array<{ status: string }>).map((target) => target.status),
    ['completed_with_warning', 'cancelled'],
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM media_version_reservations WHERE operation_id = ?',
      ).value<[number]>(operationId)?.[0]
    ),
    0,
  );
});

Deno.test('manual season lanes delete multiple explicit versions while one remains', async () => {
  reset();
  addManualSeasonEpisode(
    'manual-three-show',
    'manual-three-season',
    'manual-three-episode',
    1,
    [301, 302, 303],
  );

  const preview = await seasonPreviewEvidence('manual-three-season', ['manual-three-episode']);
  const response = await seasonCleanupRequest('manual-three-season', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'manual-season-one-lane',
      selections: [
        { episodeRatingKey: 'manual-three-episode', mediaIds: [301, 302] },
      ],
      ...preview,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const result = await response.json();
  assertEquals(result.targetCount, 2);

  await settle();
  const targetErrors = withTransaction((client) =>
    client.prepare(
      'SELECT target_key, error FROM deletion_targets WHERE operation_id = ? ORDER BY ordinal',
    ).values(result.operationId)
  );
  assertEquals(
    getDeletionOperation(result.operationId, 1)?.status,
    'completed',
    JSON.stringify(targetErrors),
  );
  assertEquals(live.get('manual-three-episode')?.Media?.map((media) => media.id), [303]);
});

Deno.test('manual season cleanup rejects selections spanning seasons', async () => {
  reset();
  addManualSeasonEpisode('manual-show', 'manual-season-1', 'manual-episode-1', 1, [101, 102]);
  addManualSeasonEpisode('manual-show', 'manual-season-2', 'manual-episode-2', 2, [201, 202]);

  const response = await seasonCleanupRequest('manual-season-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'manual-cross-season',
      selections: [
        { episodeRatingKey: 'manual-episode-1', mediaIds: [101] },
        { episodeRatingKey: 'manual-episode-2', mediaIds: [201] },
      ],
      coordinateSonarr: false,
      cleanupDownloads: false,
      previewFingerprint: 'a'.repeat(64),
    }),
  });
  assertEquals(response.status, 409);
  assertStringIncludes((await response.json()).error, 'selected episode');
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT COUNT(*) FROM deletion_operations WHERE client_request_id LIKE 'manual-cross-season:%'",
      ).value<[number]>()?.[0]
    ),
    0,
  );
});

Deno.test('season replay ignores preview expiry and drift returns the rebuilt preview', async () => {
  reset();
  addManualSeasonEpisode('fingerprint-show', 'fingerprint-season', 'fingerprint-episode', 1, [
    601,
    602,
  ]);
  const preview = await seasonPreviewEvidence('fingerprint-season', ['fingerprint-episode']);
  const request = (clientRequestId: string, evidence: Record<string, unknown>) =>
    seasonCleanupRequest('fingerprint-season', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientRequestId,
        selections: [{
          episodeRatingKey: 'fingerprint-episode',
          mediaIds: [601],
        }],
        ...evidence,
      }),
    });
  const accepted = await request('season-exact-replay', preview);
  assertEquals(accepted.status, 202, await accepted.clone().text());
  const acceptedBody = await accepted.json();
  const originalNow = Date.now;
  Date.now = () => originalNow() + 10 * 60 * 1_000;
  try {
    exactMetadataFailureStatus = 503;
    const replayed = await request('season-exact-replay', {
      ...preview,
      previewFingerprint: 'b'.repeat(64),
    });
    assertEquals(replayed.status, 202, await replayed.clone().text());
    assertEquals(await replayed.json(), acceptedBody);
  } finally {
    Date.now = originalNow;
  }

  reset();
  addManualSeasonEpisode('fingerprint-show', 'fingerprint-season', 'fingerprint-episode', 1, [
    601,
    602,
  ]);
  const freshPreview = await seasonPreviewEvidence('fingerprint-season', ['fingerprint-episode']);

  withTransaction((client) =>
    client.prepare(
      'UPDATE episode_media_versions SET file_size = file_size + 1 WHERE episode_rating_key = ? AND media_id = ?',
    ).run('fingerprint-episode', 601)
  );
  const drifted = await request('season-drifted-preview', freshPreview);
  assertEquals(drifted.status, 409);
  const driftedBody = await drifted.json();
  assertEquals(driftedBody.code, 'PREVIEW_CHANGED');
  assertEquals(driftedBody.preview.seasonRatingKey, 'fingerprint-season');
  const retried = await app.request('/api/duplicates/seasons/fingerprint-season/cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-drifted-preview',
      previewFingerprint: driftedBody.preview.fingerprint,
      selections: [{ episodeRatingKey: 'fingerprint-episode', mediaIds: [601] }],
      coordinateSonarr: false,
      cleanupDownloads: false,
    }),
  });
  assertEquals(retried.status, 202, await retried.clone().text());
});

Deno.test('unselected season changes do not invalidate reviewed deletion intent', async () => {
  reset();
  addManualSeasonEpisode('scope-show', 'scope-season', 'scope-selected', 1, [601, 602]);
  const previewResponse = await app.request(
    '/api/duplicates/seasons/scope-season/deletion-preview',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        selections: [{ episodeRatingKey: 'scope-selected', mediaIds: [601] }],
        coordinateSonarr: false,
        cleanupDownloads: false,
      }),
    },
  );
  assertEquals(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json();

  addManualSeasonEpisode('scope-show', 'scope-season', 'scope-unselected', 2, [701, 702]);
  const response = await app.request('/api/duplicates/seasons/scope-season/cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-fingerprint-scope',
      previewFingerprint: preview.fingerprint,
      selections: [{ episodeRatingKey: 'scope-selected', mediaIds: [601] }],
      coordinateSonarr: false,
      cleanupDownloads: false,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
});

Deno.test('season preview discovers actionable Sonarr ownership before coordination is selected', async () => {
  reset();
  configureSonarr();
  addEpisode();
  sonarrManagedFileShared = true;
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/shared.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/better.mkv';
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];
  let response = await app.request('/api/duplicates/seasons/season-1/deletion-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      coordinateSonarr: false,
      cleanupDownloads: false,
    }),
  });
  assertEquals(response.status, 409);
  assertStringIncludes((await response.json()).error, 'shared');

  response = await app.request('/api/duplicates/seasons/season-1/deletion-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      coordinateSonarr: true,
      cleanupDownloads: false,
    }),
  });
  assertEquals(response.status, 409);
  assertStringIncludes((await response.json()).error, 'shared');

  sonarrManagedFileShared = false;
  live.get('episode-1')!.Media![0]!.Part!.push({
    file: '/tv/Show/Season 01/second-part.mkv',
    size: 1,
  });
  response = await app.request('/api/duplicates/seasons/season-1/deletion-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      coordinateSonarr: true,
      cleanupDownloads: false,
    }),
  });
  assertEquals(response.status, 409);
  assertStringIncludes((await response.json()).error, 'multipart');

  live.get('episode-1')!.Media![0]!.Part = [{ file: sonarrManagedPath, size: 40_000 }];
  sonarrManagedPath = '/different/namespace/managed.mkv';
  response = await app.request('/api/duplicates/seasons/season-1/deletion-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      coordinateSonarr: true,
      cleanupDownloads: false,
    }),
  });
  assertEquals(response.status, 409);
  assertStringIncludes((await response.json()).error, 'could not be aligned');

  sonarrManagedPath = '/tv/Show/Season 01/shared.mkv';
  live.get('episode-1')!.Media![0]!.Part = [{ file: sonarrManagedPath, size: 40_000 }];
  response = await app.request('/api/duplicates/seasons/season-1/deletion-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      coordinateSonarr: false,
      cleanupDownloads: false,
    }),
  });
  assertEquals(response.status, 200, await response.clone().text());
  const discovered = await response.json();
  assertEquals(discovered.sonarrAvailable, true);
  assertEquals(discovered.automaticAdoptionCount, 0);
  assertEquals(discovered.plexOnlyCount, 1);
  activePlaybackRatingKey = 'episode-1';
  response = await app.request('/api/duplicates/seasons/season-1/deletion-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      coordinateSonarr: false,
      cleanupDownloads: false,
    }),
  });
  assertEquals(response.status, 409);
  assertStringIncludes((await response.json()).error, 'active playback');
  activePlaybackRatingKey = null;

  response = await app.request('/api/duplicates/seasons/season-1/cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-inspected-plex-only',
      previewFingerprint: discovered.fingerprint,
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      coordinateSonarr: false,
      cleanupDownloads: false,
    }),
  });
  assertEquals(response.status, 202, await response.clone().text());
  const plexOnlyOperation = await response.json();
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        `SELECT
           json_type(snapshot, '$.arrReassignmentMappings'),
           json_type(snapshot, '$.arrOwnerships'),
           json_type(snapshot, '$.seasonCoordinationOutcome')
         FROM deletion_targets
         WHERE operation_id = ?`,
      ).value<[string | null, string | null, string | null]>(plexOnlyOperation.operationId)
    ),
    [null, null, null],
  );
  const inspectionGuard = withTransaction((client) =>
    client.prepare(
      "SELECT json_extract(snapshot, '$.seasonSonarrInspection') FROM deletion_targets WHERE operation_id = ?",
    ).value<[{
      mappings: Array<{ instanceId: number; instanceType: string }>;
      managedSelectedMediaIds: number[];
    }]>(plexOnlyOperation.operationId)?.[0]
  );
  assertEquals(inspectionGuard?.managedSelectedMediaIds, [21]);
  assertEquals(inspectionGuard?.mappings.length, 1);
  assertEquals(inspectionGuard?.mappings[0]?.instanceId, 2);
  assertEquals(inspectionGuard?.mappings[0]?.instanceType, 'sonarr');

  sonarrManagedMediaId = 22;
  sonarrManagedPath = sonarrRescanTargetPath;
  await settle();
  assertEquals(getDeletionOperation(plexOnlyOperation.operationId, 1)?.status, 'needs_attention');
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [21, 22]);
});

Deno.test('Plex-only season preview warns when exact Sonarr TVDB inspection is unavailable', async () => {
  reset();
  configureSonarr();
  addEpisode();
  withTransaction((client) => client.prepare('UPDATE items SET tvdb_id = NULL').run());

  const response = await app.request('/api/duplicates/seasons/season-1/deletion-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      coordinateSonarr: false,
      cleanupDownloads: false,
    }),
  });
  assertEquals(response.status, 200);
  const preview = await response.json();
  assertStringIncludes(preview.sonarrInspectionWarning, 'TVDB identity');
  assertEquals(preview.sonarrAvailable, false);
});

Deno.test('quick analysis enriches thin synced rows before classifying candidates', async () => {
  reset();
  addSmartCleanupMovie('smart-thin-sync', false);
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT SUM(stream_details_available) FROM item_media_versions WHERE item_rating_key = ?',
      ).value<[number]>('smart-thin-sync')?.[0]
    ),
    0,
  );

  const response = await app.request('/api/duplicates/smart-analysis', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ movies: true, tv: false }),
  });
  assertEquals(response.status, 200, await response.clone().text());
  const analysis = await response.json();
  assertEquals(analysis.analyzedGroups, 1);
  assertEquals(analysis.protectedGroups, 0);
  assertEquals(analysis.candidates[0].ratingKey, 'smart-thin-sync');
  assertEquals(analysis.candidates[0].keepMediaId, 12);
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT SUM(stream_details_available), MAX(updated_at) FROM item_media_versions WHERE item_rating_key = ?',
      ).value<[number, number]>('smart-thin-sync')
    ),
    [2, 1],
  );
});

Deno.test('quick cleanup replays an accepted batch after its targets complete', async () => {
  reset();
  addSmartCleanupMovie('smart-replay');
  const requestBody = {
    clientRequestId: 'smart-replay-request',
    selections: [{
      mediaType: 'movie',
      ratingKey: 'smart-replay',
      deleteMediaIds: [11],
    }],
    includeNearIdentical: false,
  };
  const firstResponse = await app.request('/api/duplicates/smart-cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  assertEquals(firstResponse.status, 202, await firstResponse.clone().text());
  const first = await firstResponse.json();

  await settle();
  assertEquals(getDeletionOperation(first.operationIds[0], 1)?.status, 'completed');

  const replayResponse = await app.request('/api/duplicates/smart-cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  assertEquals(replayResponse.status, 202, await replayResponse.clone().text());
  assertEquals(await replayResponse.json(), first);

  const changedResponse = await app.request('/api/duplicates/smart-cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...requestBody, includeNearIdentical: true }),
  });
  assertEquals(changedResponse.status, 409);
});

Deno.test('quick analysis excludes workflow-owned candidates before analysis', async () => {
  reset();
  addSmartCleanupMovie('smart-reserved');
  await enqueueVersion('smart-reserved', 11);

  const response = await app.request('/api/duplicates/smart-analysis', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ movies: true, tv: false }),
  });
  assertEquals(response.status, 200);
  const analysis = await response.json();
  assertEquals(analysis.analyzedGroups, 0);
  assertEquals(analysis.protectedGroups, 0);
  assertEquals(analysis.candidates, []);
});

Deno.test('quick cleanup request IDs reserve space for the operation suffix', async () => {
  reset();
  addSmartCleanupMovie('smart-request-id');
  const selection = [{
    mediaType: 'movie',
    ratingKey: 'smart-request-id',
    deleteMediaIds: [11],
  }];
  const valid = await app.request('/api/duplicates/smart-cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'a'.repeat(124),
      selections: selection,
      includeNearIdentical: false,
    }),
  });
  assertEquals(valid.status, 202, await valid.text());

  const tooLong = await app.request('/api/duplicates/smart-cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'b'.repeat(125),
      selections: selection,
      includeNearIdentical: false,
    }),
  });
  assertEquals(tooLong.status, 400);
});

Deno.test('multi-version batch replays sequentially while earlier selected versions are absent', async () => {
  reset();
  addMovie('version-batch', [11, 12, 13]);
  const selectedMediaIds = [11, 12];
  const result = await enqueueDeletionOperation({
    clientRequestId: crypto.randomUUID(),
    serverId: 1,
    libraryKey: 'movies',
    kind: 'movie_version',
    payload: { ratingKey: 'version-batch', mediaIds: selectedMediaIds },
    targets: selectedMediaIds.map((mediaId) => ({
      kind: 'movie_version' as const,
      key: `version-batch:${mediaId}`,
      title: 'Movie version-batch',
      logicalSize: 50,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey: 'movies',
        ratingKey: 'version-batch',
        mediaId,
        selectedMediaIds,
        title: 'Movie version-batch',
        type: 'movie',
        tmdbId: null,
        tvdbId: null,
        fileSize: 50,
        videoResolution: null,
        bitrate: null,
        videoCodec: null,
        container: null,
      },
      reservation: { mediaKind: 'movie' as const, mediaId, ratingKey: 'version-batch' },
    })),
  });
  await settle();
  const operation = getDeletionOperation(result.operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT media_id FROM item_media_versions WHERE item_rating_key = ? ORDER BY media_id',
      ).values('version-batch')
    ),
    [[13]],
  );
});

Deno.test('quick cleanup stops when the explicitly selected keeper disappears', async () => {
  reset();
  addMovie('keeper-changed', [11, 12, 13]);
  const operationId = await enqueueVersion('keeper-changed', 11, null, {
    operationMediaIds: [11],
    expectedRetainedVersion: {
      mediaId: 12,
      fileSize: 50,
      videoResolution: null,
      height: null,
      bitrate: null,
      videoCodec: null,
      container: null,
    },
  });
  live.get('keeper-changed')!.Media = live.get('keeper-changed')!.Media!.filter((media) =>
    media.id !== 12
  );

  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assertEquals(live.get('keeper-changed')?.Media?.map((media) => media.id), [11, 13]);
});

Deno.test('quick cleanup stops when live Plex version metadata changed after analysis', async () => {
  reset();
  addMovie('metadata-changed', [11, 12]);
  withTransaction((client) =>
    client.prepare(
      'UPDATE item_media_versions SET video_resolution = ?, height = ?, bitrate = ?, video_codec = ?, container = ? WHERE item_rating_key = ? AND media_id = ?',
    ).run('1080', 1080, 10_000, 'h264', 'mkv', 'metadata-changed', 11)
  );
  const source = live.get('metadata-changed')!.Media!.find((media) => media.id === 11)!;
  Object.assign(source, {
    videoResolution: '4k',
    height: 2160,
    bitrate: 20_000,
    videoCodec: 'hevc',
    container: 'mkv',
  });
  const operationId = await enqueueVersion('metadata-changed', 11, null, {
    videoResolution: '1080',
    height: 1080,
    bitrate: 10_000,
    videoCodec: 'h264',
    container: 'mkv',
    expectedRetainedVersion: {
      mediaId: 12,
      fileSize: 50,
      videoResolution: null,
      height: null,
      bitrate: null,
      videoCodec: null,
      container: null,
    },
  });

  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assertEquals(live.get('metadata-changed')?.Media?.map((media) => media.id), [11, 12]);
});

Deno.test('quick cleanup stops when the retained version changed after analysis', async () => {
  reset();
  addMovie('retained-metadata-changed', [11, 12]);
  const retained = live.get('retained-metadata-changed')!.Media!.find((media) => media.id === 12)!;
  Object.assign(retained, { videoResolution: '4k', height: 2160, bitrate: 20_000 });
  const operationId = await enqueueVersion('retained-metadata-changed', 11, null, {
    expectedRetainedVersion: {
      mediaId: 12,
      fileSize: 50,
      videoResolution: '1080',
      height: 1080,
      bitrate: 10_000,
      videoCodec: null,
      container: null,
    },
  });

  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assertEquals(live.get('retained-metadata-changed')?.Media?.map((media) => media.id), [11, 12]);
});

Deno.test('quick cleanup stops when a classification-critical technical detail changes', async () => {
  reset();
  addSmartCleanupMovie('stream-detail-changed');
  const cleanupResponse = await app.request('/api/duplicates/smart-cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'smart-stream-detail-change',
      selections: [{
        mediaType: 'movie',
        ratingKey: 'stream-detail-changed',
        deleteMediaIds: [11],
      }],
      includeNearIdentical: false,
    }),
  });
  assertEquals(cleanupResponse.status, 202, await cleanupResponse.clone().text());
  const cleanup = await cleanupResponse.json();
  const source = live.get('stream-detail-changed')!.Media!.find((media) => media.id === 11)!;
  source.duration = 7300000;

  await settle();

  const operation = getDeletionOperation(cleanup.operationIds[0], 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assertEquals(live.get('stream-detail-changed')?.Media?.map((media) => media.id), [11, 12]);
});

Deno.test('quick cleanup still converges after a lost destructive response', async () => {
  reset();
  addSmartCleanupMovie('smart-lost-response');
  loseDeleteResponse = true;
  const cleanupResponse = await app.request('/api/duplicates/smart-cleanup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'smart-lost-response-request',
      selections: [{
        mediaType: 'movie',
        ratingKey: 'smart-lost-response',
        deleteMediaIds: [11],
      }],
      includeNearIdentical: false,
    }),
  });
  assertEquals(cleanupResponse.status, 202, await cleanupResponse.clone().text());
  const cleanup = await cleanupResponse.json();

  await settle();
  assertEquals(
    getDeletionOperation(cleanup.operationIds[0], 1)?.status,
    'completed',
  );
  assertEquals(live.get('smart-lost-response')?.Media?.map((media) => media.id), [12]);
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT COUNT(*) FROM media_removals WHERE operation_id = ?').value<[number]>(
        cleanup.operationIds[0],
      )?.[0]
    ),
    0,
  );
});

Deno.test('legacy Arr intent cannot bypass media-version capacity validation', async () => {
  reset();
  configureRadarr();
  addMovie('mixed-version-batch', [11, 12], 10);
  coordinatedRatingKey = 'mixed-version-batch';
  arrPresent = true;
  live.get('mixed-version-batch')!.Media = [
    { id: 11, Part: [{ file: '/library/Unmanaged/movie.mkv', size: 50_000 }] },
    { id: 12, Part: [{ file: '/library/Coordinated/movie.mkv', size: 50_000 }] },
  ];

  await assertRejects(
    () =>
      enqueueDeletionOperation({
        clientRequestId: crypto.randomUUID(),
        serverId: 1,
        libraryKey: 'movies',
        kind: 'movie_version',
        payload: {
          ratingKey: 'mixed-version-batch',
          mediaIds: [11, 12],
          arrMediaIds: [12],
          cleanupMediaIds: [],
        },
        targets: [11, 12].map((mediaId) => ({
          kind: 'movie_version' as const,
          key: `mixed-version-batch:${mediaId}`,
          title: 'Movie mixed-version-batch',
          logicalSize: 50,
          snapshot: {
            machineIdentifier: 'machine-1',
            serverUrl: 'http://plex',
            libraryKey: 'movies',
            ratingKey: 'mixed-version-batch',
            mediaId,
            selectedMediaIds: [mediaId],
            title: 'Movie mixed-version-batch',
            type: 'movie',
            tmdbId: 10,
            tvdbId: null,
            fileSize: 50,
            videoResolution: null,
            bitrate: null,
            videoCodec: null,
            container: null,
            cleanupDownloads: false,
          },
          reservation: {
            mediaKind: 'movie' as const,
            mediaId,
            ratingKey: 'mixed-version-batch',
          },
        })),
      }),
    DeletionConflictError,
    'at least one version must remain',
  );
  assertEquals(arrDeleteCount, 0);
  assertEquals(live.get('mixed-version-batch')?.Media?.map((media) => media.id), [11, 12]);
});

Deno.test('Radarr reassignment keeps the movie and adopts the chosen retained version', async () => {
  reset();
  configureRadarr();
  addMovie('reassign-version', [12, 13], 10);
  coordinatedRatingKey = 'reassign-version';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/better.mkv';
  arrMonitored = false;
  live.get('reassign-version')!.Media = [
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];

  const result = await enqueueDeletionOperation({
    clientRequestId: crypto.randomUUID(),
    serverId: 1,
    libraryKey: 'movies',
    kind: 'movie_version',
    payload: {
      ratingKey: 'reassign-version',
      mediaIds: [12],
      cleanupMediaIds: [],
    },
    targets: [{
      kind: 'movie_version',
      key: 'reassign-version:12',
      title: 'Movie reassign-version',
      logicalSize: 50,
      snapshot: {
        machineIdentifier: 'machine-1',
        serverUrl: 'http://plex',
        libraryKey: 'movies',
        ratingKey: 'reassign-version',
        mediaId: 12,
        selectedMediaIds: [12],
        operationMediaIds: [12],
        title: 'Movie reassign-version',
        type: 'movie',
        tmdbId: 10,
        tvdbId: null,
        fileSize: 50,
        videoResolution: null,
        bitrate: null,
        videoCodec: null,
        container: null,
        cleanupDownloads: false,
      },
      reservation: {
        mediaKind: 'movie',
        mediaId: 12,
        ratingKey: 'reassign-version',
      },
    }],
  });

  await settle();

  const operation = getDeletionOperation(result.operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(arrPresent, true);
  assertEquals(arrDeleteCount, 0);
  assertEquals(arrMoviePath, '/library/Coordinated');
  assertEquals(arrManagedPath, '/library/Coordinated/better.mkv');
  assertEquals(arrMonitored, false);
  assertEquals(arrMonitorMutationCount, 0);
  const monitoringSnapshot = withTransaction((client) =>
    client.prepare('SELECT snapshot FROM deletion_targets WHERE operation_id = ?').value<[string]>(
      result.operationId,
    )?.[0]
  );
  assertEquals(JSON.parse(monitoringSnapshot!).arrReassignments[0].originalMonitored, false);
  assertEquals(live.get('reassign-version')?.Media?.map((media) => media.id), [13]);
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT media_id FROM item_media_versions WHERE item_rating_key = ? ORDER BY media_id',
      ).values('reassign-version')
    ),
    [[13]],
  );
});

Deno.test('Plex-only movie version deletion leaves a matched Radarr record unchanged', async () => {
  reset();
  configureRadarr();
  addMovie('plex-only-radarr-version', [11, 12], 10);
  coordinatedRatingKey = 'plex-only-radarr-version';
  arrPresent = true;
  arrManagedMediaId = 11;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/retained.mkv';
  live.get('plex-only-radarr-version')!.Media = [
    { id: 11, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 12, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];

  const response = await app.request(
    '/api/duplicates/movies/plex-only-radarr-version/media',
    {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientRequestId: 'plex-only-radarr-version-request',
        mediaIds: [11],
        cleanupMediaIds: [],
        radarrMode: 'none',
      }),
    },
  );
  assertEquals(response.status, 202, await response.clone().text());
  const result = await response.json();
  const durable = withTransaction((client) =>
    client.prepare(
      'SELECT snapshot FROM deletion_targets WHERE operation_id = ?',
    ).value<[string]>(result.operationId)
  );
  const snapshot = JSON.parse(durable![0]);
  assertEquals({
    type: snapshot.type,
    cleanupDownloads: snapshot.cleanupDownloads,
    skipArrCoordination: snapshot.skipArrCoordination,
    arrReassignmentMappings: snapshot.arrReassignmentMappings,
    arrOwnerships: snapshot.arrOwnerships,
    arrReassignments: snapshot.arrReassignments,
    radarrRemovalFallback: snapshot.radarrRemovalFallback,
    radarrRemovalDownloadCleanup: snapshot.radarrRemovalDownloadCleanup,
    seasonSonarrInspection: snapshot.seasonSonarrInspection,
    seasonCoordinationOutcome: snapshot.seasonCoordinationOutcome,
  }, {
    type: 'movie',
    cleanupDownloads: false,
    skipArrCoordination: true,
    arrReassignmentMappings: undefined,
    arrOwnerships: undefined,
    arrReassignments: undefined,
    radarrRemovalFallback: undefined,
    radarrRemovalDownloadCleanup: undefined,
    seasonSonarrInspection: undefined,
    seasonCoordinationOutcome: undefined,
  });

  await settle();

  const operation = getDeletionOperation(result.operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(arrPresent, true);
  assertEquals(arrManagedMediaId, 11);
  assertEquals(arrDeleteCount, 0);
  assertEquals(arrMonitorMutationCount, 0);
  assertEquals(live.get('plex-only-radarr-version')?.Media?.map((media) => media.id), [12]);
});

Deno.test('Radarr removal fallback protects replacement before exact Plex deletion', async () => {
  reset();
  configureRadarr();
  addMovie('radarr-removal-fallback', [11, 12], 10);
  coordinatedRatingKey = 'radarr-removal-fallback';
  arrPresent = true;
  arrManagedMediaId = 11;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrManagedFileSize = 50_000;
  live.get('radarr-removal-fallback')!.Media = [
    { id: 11, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 12, Part: [{ file: '/downloads/retained/movie.mkv', size: 50_000 }] },
  ];

  const operationId = await enqueueRadarrRemovalFallback('radarr-removal-fallback');
  await settle();

  assertEquals(getDeletionOperation(operationId, 1)?.status, 'completed');
  assertEquals(versionDeleteOrder, ['radarr', 'plex']);
  assertEquals(arrDeleteCount, 1);
  assertEquals(arrPresent, false);
  assertEquals(radarrExclusion?.tmdbId, 10);
  assertEquals(arrMonitorMutationCount, 1);
  assertEquals(qbitRequestCount, 0);
  assertEquals(live.get('radarr-removal-fallback')?.Media?.map((media) => media.id), [12]);
});

Deno.test('Radarr removal fallback converges after a lost Radarr DELETE response', async () => {
  reset();
  configureRadarr();
  addMovie('radarr-removal-lost-response', [11, 12], 10);
  coordinatedRatingKey = 'radarr-removal-lost-response';
  arrPresent = true;
  arrManagedMediaId = 11;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrManagedFileSize = 50_000;
  loseArrRemovalResponse = true;
  live.get('radarr-removal-lost-response')!.Media = [
    { id: 11, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 12, Part: [{ file: '/downloads/retained/movie.mkv', size: 50_000 }] },
  ];

  const operationId = await enqueueRadarrRemovalFallback('radarr-removal-lost-response');
  await settle();

  assertEquals(getDeletionOperation(operationId, 1)?.status, 'completed');
  assertEquals(versionDeleteOrder, ['radarr', 'plex']);
  assertEquals(arrDeleteCount, 1);
  assertEquals(live.get('radarr-removal-lost-response')?.Media?.map((media) => media.id), [12]);
});

Deno.test('Radarr reassignment reconciles lost monitoring responses at both boundaries', async () => {
  for (const mutation of [1, 2]) {
    reset();
    configureRadarr();
    addMovie(`radarr-monitor-response-${mutation}`, [12, 13], 10);
    coordinatedRatingKey = `radarr-monitor-response-${mutation}`;
    arrPresent = true;
    arrManagedMediaId = 12;
    arrManagedPath = '/library/Coordinated/movie.mkv';
    arrRescanTargetPath = '/library/Coordinated/better.mkv';
    live.get(coordinatedRatingKey)!.Media = [
      { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
      { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
    ];
    loseMonitorResponseAtMutation = mutation;

    const operationId = await enqueueMovieReassignment(coordinatedRatingKey, 12);
    await settle();

    const operation = getDeletionOperation(operationId, 1);
    assertEquals(operation?.status, 'completed', JSON.stringify(operation));
    assertEquals(arrMonitored, true);
    assertEquals(arrMonitorMutationCount, 2);
    assertEquals(live.get(coordinatedRatingKey)?.Media?.map((media) => media.id), [13]);
  }
});

Deno.test('Radarr reassignment retries a definite monitoring restoration rejection', async () => {
  reset();
  configureRadarr();
  addMovie('radarr-restore-rejected', [12, 13], 10);
  coordinatedRatingKey = 'radarr-restore-rejected';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/better.mkv';
  rejectMonitorAtMutation = 2;
  live.get(coordinatedRatingKey)!.Media = [
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];

  const operationId = await enqueueMovieReassignment(coordinatedRatingKey, 12);
  await settle();

  let operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'waiting_retry', JSON.stringify(operation));
  assertEquals(arrManagedPath, '/library/Coordinated/better.mkv');
  assertEquals(arrMonitored, false);
  assertEquals(arrMonitorMutationCount, 1);
  assertEquals(live.get(coordinatedRatingKey)?.Media?.map((media) => media.id), [13]);

  rejectMonitorAtMutation = null;
  makeRetryReady(operationId);
  await settle();

  operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(arrMonitored, true);
  assertEquals(arrMonitorMutationCount, 2);
  assertEquals(plexMediaDeleteCount, 1);
});

Deno.test('Radarr reassignment re-establishes protection after post-delete drift', async () => {
  reset();
  configureRadarr();
  addMovie('radarr-monitor-drift', [12, 13], 10);
  coordinatedRatingKey = 'radarr-monitor-drift';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/better.mkv';
  monitorDriftAfterSelectedDelete = true;
  live.get(coordinatedRatingKey)!.Media = [
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];

  const operationId = await enqueueMovieReassignment(coordinatedRatingKey, 12);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(arrMonitored, true);
  assertEquals(arrMonitorMutationCount, 3);
  assertEquals(live.get(coordinatedRatingKey)?.Media?.map((media) => media.id), [13]);
});

Deno.test('Radarr reassignment repairs monitoring drift before final Plex reconciliation', async () => {
  reset();
  configureRadarr();
  addMovie('radarr-final-monitor-drift', [12, 13], 10);
  coordinatedRatingKey = 'radarr-final-monitor-drift';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/better.mkv';
  monitorDriftAfterRestorationReads = 3;
  live.get(coordinatedRatingKey)!.Media = [
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];

  const operationId = await enqueueMovieReassignment(coordinatedRatingKey, 12);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(arrMonitored, true);
  assertEquals(arrMonitorMutationCount, 3);
  assertEquals(plexMediaDeleteCount, 1);
});

Deno.test('persistent final Radarr monitoring failure exhausts into attention', async () => {
  reset();
  configureRadarr();
  addMovie('radarr-final-monitor-failure', [12, 13], 10);
  coordinatedRatingKey = 'radarr-final-monitor-failure';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/better.mkv';
  monitorDriftAfterRestorationReads = 3;
  rejectMonitorAtMutation = 3;
  live.get(coordinatedRatingKey)!.Media = [
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];

  const operationId = await enqueueMovieReassignment(coordinatedRatingKey, 12);
  await settle();
  for (let retry = 0; retry < 3; retry++) {
    const operation = getDeletionOperation(operationId, 1);
    assertEquals(operation?.status, 'waiting_retry', JSON.stringify(operation));
    makeRetryReady(operationId);
    await settle();
  }

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assertEquals(arrMonitored, false);
  assertEquals(arrMonitorMutationCount, 2);
  assertEquals(plexMediaDeleteCount, 1);
});

Deno.test('originally unmonitored Radarr reassignment repairs post-delete drift', async () => {
  reset();
  configureRadarr();
  addMovie('radarr-unmonitored-drift', [12, 13], 10);
  coordinatedRatingKey = 'radarr-unmonitored-drift';
  arrPresent = true;
  arrMonitored = false;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/better.mkv';
  monitorDriftAfterSelectedDelete = true;
  live.get(coordinatedRatingKey)!.Media = [
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];

  const operationId = await enqueueMovieReassignment(coordinatedRatingKey, 12);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(arrMonitored, false);
  assertEquals(arrMonitorMutationCount, 1);
  assertEquals(live.get(coordinatedRatingKey)?.Media?.map((media) => media.id), [13]);
});

Deno.test('originally unmonitored Radarr reassignment stops on pre-delete drift', async () => {
  reset();
  configureRadarr();
  addMovie('radarr-unmonitored-pre-delete-drift', [12, 13], 10);
  coordinatedRatingKey = 'radarr-unmonitored-pre-delete-drift';
  arrPresent = true;
  arrMonitored = false;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/better.mkv';
  monitorDriftAfterUnmonitoredEvidence = true;
  live.get(coordinatedRatingKey)!.Media = [
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];

  const operationId = await enqueueMovieReassignment(coordinatedRatingKey, 12);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assertStringIncludes(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error),
    'monitoring changed before file deletion',
  );
  assertEquals(arrMonitorMutationCount, 0);
  assertEquals(plexMediaDeleteCount, 0);
  assertEquals(arrManagedFilePresent, true);
});

Deno.test('Radarr reassignment does not delete when protection cannot be confirmed', async () => {
  reset();
  configureRadarr();
  addMovie('radarr-monitor-rejected', [12, 13], 10);
  coordinatedRatingKey = 'radarr-monitor-rejected';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/better.mkv';
  rejectMonitoringWrites = true;
  live.get(coordinatedRatingKey)!.Media = [
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];

  const operationId = await enqueueMovieReassignment(coordinatedRatingKey, 12);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'waiting_retry', JSON.stringify(operation));
  assertStringIncludes(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error),
    'returned 503',
  );
  assertEquals(arrMonitored, true);
  assertEquals(arrMonitorMutationCount, 0);
  assertEquals(plexMediaDeleteCount, 0);
  assertEquals(arrManagedFilePresent, true);
  assertEquals(live.get(coordinatedRatingKey)?.Media?.map((media) => media.id), [12, 13]);
});

Deno.test('guided Radarr relocation supersedes only the untouched target and is exactly idempotent', async () => {
  reset();
  const { operationId, targetId, guidanceId } = await prepareGuidedMovieRelocation();
  const guided = getDeletionOperation(operationId, 1)!;
  const target = (guided.targets as Array<Record<string, unknown>>)[0]!;
  assert(target.relocationGuidance, String(target.error));
  assertEquals(guided.status, 'needs_attention');
  assertEquals(guided.libraryRecoveryTargetCount, 1);
  assertEquals(target.phase, 'validating');
  assertEquals(target.plexAttemptCount, 0);
  assertEquals(plexMediaDeleteCount, 0);
  assertEquals(retryDeletionOperation(operationId, 1), false);
  await assertRejects(
    () => enqueueMovieReassignment('guided-relocation', 11),
    DeletionConflictError,
    'active retained-version relocation guidance',
  );
  assertThrows(
    () => finishRelocation(operationId, targetId, 1, guidanceId, false),
    Error,
    'exact destination Part path',
  );
  assertThrows(
    () => finishRelocation(operationId, targetId, 1, crypto.randomUUID(), true),
    Error,
    'no longer matches',
  );
  assertThrows(
    () => finishRelocation(operationId, 0, 1, guidanceId, true),
    Error,
    'not found',
  );

  const finished = finishRelocation(operationId, targetId, 1, guidanceId, true);
  withTransaction((client) => {
    // The incomplete barrier retains the library row and blocks new cleanup, but it
    // must not suppress the targeted projection prune needed to complete itself.
    assertEquals(deletionRecoveryNeedsProjection(client, 1, 'movies'), false);
    assert(deletionRecoveryLibraryKeys(client, 1).includes('movies'));
  });
  const active = await resolveActiveServer();
  const targetedSync = await runLibrarySync(active.client, active.serverId, 'movies');
  assertEquals(targetedSync.pruneCompleted, true);
  assertEquals(finished.repeated, false);
  await assertRejects(
    () => enqueueMovieReassignment('guided-relocation', 11),
    DeletionConflictError,
    'targeted library sync is required',
  );
  const repeated = finishRelocation(operationId, targetId, 1, guidanceId, true);
  assertEquals(repeated.repeated, true);
  assertEquals(repeated.barrier, finished.barrier);
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT COUNT(*) FROM media_version_reservations WHERE target_id = ?')
        .value<[number]>(targetId)?.[0]
    ),
    0,
  );

  withTransaction((client) => {
    assertEquals(
      completeRelocationBarriers(
        client,
        1,
        'movies',
        998,
        finished.barrier.supersededAt,
        finished.barrier.supersededAt + 1,
      ),
      0,
    );
    assertEquals(
      completeRelocationBarriers(
        client,
        1,
        'movies',
        999,
        finished.barrier.supersededAt + 1,
        finished.barrier.supersededAt + 2,
      ),
      1,
    );
  });
  const afterBarrier = finishRelocation(
    operationId,
    targetId,
    1,
    guidanceId,
    true,
  );
  assertEquals(afterBarrier.repeated, true);
  assertEquals(afterBarrier.barrier.syncId, 999);
  assertEquals(plexMediaDeleteCount, 0);

  withTransaction((client) => {
    client.prepare('UPDATE deletion_targets SET plex_attempt_count = 1 WHERE id = ?').run(
      target.id as number,
    );
  });
  assertThrows(
    () => finishRelocation(operationId, targetId, 1, guidanceId, true),
    Error,
    'no longer untouched',
  );
});

Deno.test('relocation endpoints reject missing identity and invalid targets without mutation', async () => {
  reset();
  const { operationId, targetId, guidanceId } = await prepareGuidedMovieRelocation();
  const snapshotBefore = withTransaction((client) =>
    client.prepare('SELECT snapshot FROM deletion_targets WHERE id = ?').value<[string]>(
      targetId,
    )![0]
  );
  const requests = [
    {
      path: `/api/deletion-operations/${operationId}/targets/${targetId}/finish-relocation`,
      body: {},
      status: 400,
      error: 'guidanceId is required',
    },
    {
      path: `/api/deletion-operations/${operationId}/targets/${targetId}/finish-relocation`,
      body: { guidanceId: crypto.randomUUID(), destinationPlaybackConfirmed: true },
      status: 409,
      error: 'Relocation guidance no longer matches this request',
    },
    {
      path: `/api/deletion-operations/${operationId}/targets/not-a-target/finish-relocation`,
      body: { guidanceId, destinationPlaybackConfirmed: true },
      status: 404,
      error: 'Relocation target not found',
    },
    {
      path: `/api/deletion-operations/${operationId}/targets/not-a-target/relocation-sync`,
      body: {},
      status: 404,
      error: 'incomplete relocation barrier not found',
    },
  ];
  for (const request of requests) {
    const response = await app.request(request.path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
    });
    assertEquals(response.status, request.status);
    assertEquals(await response.json(), { error: request.error });
  }
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT snapshot FROM deletion_targets WHERE id = ?').value<[string]>(
        targetId,
      )![0]
    ),
    snapshotBefore,
  );
  assertEquals(plexMediaDeleteCount, 0);
});

Deno.test('later ownership revalidation cannot promote a relocation candidate into guidance', async () => {
  reset();
  configureRadarr();
  addMovie('late-relocation-candidate', [11, 12], 10);
  coordinatedRatingKey = 'late-relocation-candidate';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/retained.mkv';
  arrManagedFileSize = 50_000;
  live.get('late-relocation-candidate')!.Media = [
    { id: 11, Part: [{ file: '/library/Coordinated/selected.mkv', size: 50_000 }] },
    { id: 12, Part: [{ file: '/library/retained.mkv', size: 50_000 }] },
  ];
  changeArrOwnershipOnManagedFileRead = {
    read: 3,
    mediaId: 11,
    path: '/library/Coordinated/selected.mkv',
  };

  const operationId = await enqueueMovieReassignment('late-relocation-candidate', 11);
  await settle();

  const operation = getDeletionOperation(operationId, 1)!;
  const target = (operation.targets as Array<Record<string, unknown>>)[0]!;
  assertEquals(operation.status, 'needs_attention', JSON.stringify(operation));
  assertEquals(target.relocationGuidanceState, 'none');
  assertEquals(target.relocationGuidance, undefined);
  assertStringIncludes(String(target.error), 'changed its managed ownership');
  assertEquals(plexMediaDeleteCount, 0);
});

Deno.test('completed relocation permits the required fresh cleanup operation', async () => {
  reset();
  const { operationId, targetId, guidanceId } = await prepareGuidedMovieRelocation();
  const finished = finishRelocation(operationId, targetId, 1, guidanceId, true);
  withTransaction((client) => {
    assertEquals(
      completeRelocationBarriers(
        client,
        1,
        'movies',
        999,
        finished.barrier.supersededAt + 1,
        finished.barrier.supersededAt + 2,
      ),
      1,
    );
  });

  const freshOperationId = await enqueueMovieReassignment('guided-relocation', 11);
  assert(getDeletionOperation(freshOperationId, 1));
});

Deno.test('invalid guidance blocks matching previews and retains its durable library evidence', async () => {
  reset();
  const { operationId, targetId } = await prepareGuidedMovieRelocation();
  withTransaction((client) => {
    const raw = client.prepare('SELECT snapshot FROM deletion_targets WHERE id = ?').value<
      [string]
    >(targetId)![0];
    const snapshot = JSON.parse(raw);
    snapshot.relocationGuidance = null;
    client.prepare(
      "UPDATE deletion_targets SET snapshot = ?, status = 'cancelled' WHERE id = ?",
    ).run(JSON.stringify(snapshot), targetId);
    client.prepare(
      "UPDATE deletion_operations SET status = 'cancelled' WHERE id = ?",
    ).run(operationId);
    assert(deletionRecoveryNeedsProjection(client, 1, 'movies'));
    assert(deletionRecoveryLibraryKeys(client, 1).includes('movies'));
  });
  assertThrows(
    () => assertRelocationWorkflowClear(1, 'movies', ['guided-relocation']),
    Error,
    'relocation guidance must be resolved',
  );
});

Deno.test('barrier completion skips only barriers that do not predate the sync', async () => {
  reset();
  const { operationId, targetId, guidanceId } = await prepareGuidedMovieRelocation();
  const finished = finishRelocation(operationId, targetId, 1, guidanceId, true);
  const startedAt = finished.barrier.supersededAt + 1;

  const newerTargetId = withTransaction((client) => {
    const raw = client.prepare('SELECT snapshot FROM deletion_targets WHERE id = ?').value<
      [string]
    >(targetId)![0];
    const snapshot = JSON.parse(raw);
    snapshot.relocationSyncBarrier.supersededAt = startedAt;
    return client.prepare(
      `INSERT INTO deletion_targets
         (operation_id, ordinal, target_kind, target_key, title, snapshot, status, phase,
          plex_attempt_count, attempt_count, error, created_at, updated_at)
       SELECT operation_id, 1, target_kind, target_key, title, ?, 'cancelled', 'validating',
              0, attempt_count, error, created_at, updated_at
       FROM deletion_targets WHERE id = ? RETURNING id`,
    ).value<[number]>(JSON.stringify(snapshot), targetId)![0];
  });

  withTransaction((client) => {
    assertEquals(
      completeRelocationBarriers(
        client,
        1,
        'movies',
        1000,
        startedAt,
        startedAt + 1,
      ),
      1,
    );
    assertEquals(
      client.prepare(
        "SELECT json_extract(snapshot, '$.relocationSyncBarrier.syncId') FROM deletion_targets WHERE id = ?",
      ).value<[number | null]>(targetId)?.[0],
      1000,
    );
    assertEquals(
      client.prepare(
        "SELECT json_extract(snapshot, '$.relocationSyncBarrier.syncId') FROM deletion_targets WHERE id = ?",
      ).value<[number | null]>(newerTargetId)?.[0],
      null,
    );
  });
});

Deno.test('every present malformed relocation JSON type stays fail-closed and curated', async () => {
  for (const malformed of [null, {}, [], 'invalid', 1, true] as const) {
    reset();
    const guidanceWork = await prepareGuidedMovieRelocation();
    withTransaction((client) => {
      const raw = client.prepare('SELECT snapshot FROM deletion_targets WHERE id = ?').value<
        [string]
      >(guidanceWork.targetId)![0];
      const snapshot = JSON.parse(raw);
      snapshot.relocationGuidance = malformed;
      client.prepare('UPDATE deletion_targets SET snapshot = ? WHERE id = ?').run(
        JSON.stringify(snapshot),
        guidanceWork.targetId,
      );
    });
    const guidanceOperation = getDeletionOperation(guidanceWork.operationId, 1)!;
    const guidanceTarget = (guidanceOperation.targets as Array<Record<string, unknown>>)[0]!;
    assertEquals(guidanceTarget.relocationGuidanceState, 'invalid');
    assertEquals(guidanceTarget.relocationGuidance, undefined);
    assertEquals(retryDeletionOperation(guidanceWork.operationId, 1), false);

    reset();
    const barrierWork = await prepareGuidedMovieRelocation();
    finishRelocation(
      barrierWork.operationId,
      barrierWork.targetId,
      1,
      barrierWork.guidanceId,
      true,
    );
    withTransaction((client) => {
      const raw = client.prepare('SELECT snapshot FROM deletion_targets WHERE id = ?').value<
        [string]
      >(barrierWork.targetId)![0];
      const snapshot = JSON.parse(raw);
      snapshot.relocationSyncBarrier = malformed;
      client.prepare('UPDATE deletion_targets SET snapshot = ? WHERE id = ?').run(
        JSON.stringify(snapshot),
        barrierWork.targetId,
      );
      assertEquals(
        completeRelocationBarriers(client, 1, 'movies', 2000, 2_000_000_000, 2_000_000_001),
        0,
      );
    });
    const barrierOperation = getDeletionOperation(barrierWork.operationId, 1)!;
    const barrierTarget = (barrierOperation.targets as Array<Record<string, unknown>>)[0]!;
    assertEquals(barrierOperation.supersededCount, 1);
    assertEquals(
      barrierTarget.supersededReason,
      'Superseded after guided retained-version relocation; no deletion was attempted for this target',
    );
    assertEquals(barrierTarget.relocationSyncBarrierState, 'invalid');
    assertEquals(barrierTarget.relocationSyncBarrier, undefined);
    assertEquals(retryDeletionOperation(barrierWork.operationId, 1), false);
  }
});

Deno.test('full sync retains a library and operation that own an invalid barrier', async () => {
  reset();
  const { operationId, targetId, guidanceId } = await prepareGuidedMovieRelocation();
  finishRelocation(operationId, targetId, 1, guidanceId, true);
  const invalidSnapshot = withTransaction((client) => {
    const raw = client.prepare('SELECT snapshot FROM deletion_targets WHERE id = ?').value<
      [string]
    >(targetId)![0];
    const snapshot = JSON.parse(raw);
    snapshot.relocationSyncBarrier = {};
    const invalid = JSON.stringify(snapshot);
    client.prepare('UPDATE deletion_targets SET snapshot = ? WHERE id = ?').run(invalid, targetId);
    return invalid;
  });

  // Plex reports a non-empty, different library set. The ordinary full-sync prune
  // would remove Movies unless the invalid barrier participates in durable retention.
  reportedPlexLibraries = [{ key: 'shows', title: 'Shows', type: 'show' }];
  const active = await resolveActiveServer();
  await runSync(active.client, active.serverId);

  withTransaction((client) => {
    assertEquals(
      client.prepare("SELECT key FROM libraries WHERE server_id = 1 AND key = 'movies'")
        .value<[string]>()?.[0],
      'movies',
    );
    assertEquals(
      client.prepare('SELECT snapshot FROM deletion_targets WHERE id = ?').value<[string]>(
        targetId,
      )?.[0],
      invalidSnapshot,
    );
  });
  const operation = getDeletionOperation(operationId, 1)!;
  const target = (operation.targets as Array<Record<string, unknown>>)[0]!;
  assertEquals(target.relocationSyncBarrierState, 'invalid');
  assertEquals(target.relocationSyncBarrier, undefined);
});

Deno.test('targeted sync completes a coherent barrier while preserving an invalid peer', async () => {
  reset();
  const { operationId, targetId, guidanceId } = await prepareGuidedMovieRelocation();
  const finished = finishRelocation(operationId, targetId, 1, guidanceId, true);
  const { validTargetId, invalidSnapshot } = withTransaction((client) => {
    const raw = client.prepare('SELECT snapshot FROM deletion_targets WHERE id = ?').value<
      [string]
    >(targetId)![0];
    const validTargetId = client.prepare(
      `INSERT INTO deletion_targets
         (operation_id, ordinal, target_kind, target_key, title, snapshot, status, phase,
          plex_attempt_count, attempt_count, error, created_at, updated_at)
       SELECT operation_id, 1, target_kind, target_key, title, snapshot, status, phase,
              plex_attempt_count, attempt_count, error, created_at, updated_at
       FROM deletion_targets WHERE id = ? RETURNING id`,
    ).value<[number]>(targetId)![0];
    const snapshot = JSON.parse(raw);
    snapshot.relocationSyncBarrier = { unsupported: true };
    const invalidSnapshot = JSON.stringify(snapshot);
    client.prepare('UPDATE deletion_targets SET snapshot = ? WHERE id = ?').run(
      invalidSnapshot,
      targetId,
    );
    client.prepare('UPDATE deletion_operations SET target_count = 2 WHERE id = ?').run(
      operationId,
    );
    return { validTargetId, invalidSnapshot };
  });
  const startedAt = finished.barrier.supersededAt + 1;
  const syncId = withTransaction((client) =>
    client.prepare(
      "INSERT INTO sync_log (server_id, library_key, started_at, status, items_processed) VALUES (1, 'movies', ?, 'pending', 0) RETURNING id",
    ).value<[number]>(startedAt)![0]
  );

  await finalizeSyncLog(syncId, 1, 'movies', {
    ok: true,
    itemsProcessed: 1,
    generation: startedAt,
    pruneCompleted: true,
  });

  withTransaction((client) => {
    assertEquals(
      client.prepare('SELECT status FROM sync_log WHERE id = ?').value<[string]>(syncId)?.[0],
      'success',
    );
    assertEquals(
      client.prepare('SELECT snapshot FROM deletion_targets WHERE id = ?').value<[string]>(
        targetId,
      )?.[0],
      invalidSnapshot,
    );
    assertEquals(
      client.prepare(
        "SELECT json_extract(snapshot, '$.relocationSyncBarrier.syncId') FROM deletion_targets WHERE id = ?",
      ).value<[number]>(validTargetId)?.[0],
      syncId,
    );
  });
  const operation = getDeletionOperation(operationId, 1)!;
  const targets = operation.targets as Array<Record<string, unknown>>;
  assertEquals(
    targets.find((target) => target.id === targetId)?.relocationSyncBarrierState,
    'invalid',
  );
  assertEquals(
    targets.find((target) => target.id === validTargetId)?.relocationSyncBarrierState,
    'completed',
  );
  assertThrows(
    () => assertRelocationWorkflowClear(1, 'movies', ['guided-relocation']),
    Error,
    'targeted library sync is required',
  );
});

Deno.test('show sync requires both item and episode projection prunes', async () => {
  reset();
  live.set('show-prune', {
    ratingKey: 'show-prune',
    title: 'Show prune receipt',
    type: 'show',
    librarySectionID: 'shows',
  });
  const active = await resolveActiveServer();

  const incomplete = await runLibrarySync(active.client, active.serverId, 'shows');
  assertEquals(incomplete.itemsProcessed, 1);
  assertEquals(incomplete.pruneCompleted, false);

  live.set('show-prune-episode', {
    ratingKey: 'show-prune-episode',
    title: 'Pilot',
    type: 'episode',
    librarySectionID: 'shows',
    grandparentRatingKey: 'show-prune',
    parentRatingKey: 'show-prune-season-1',
    parentIndex: 1,
    index: 1,
    Media: [{ id: 9001, Part: [{ file: '/tv/Show/Season 01/Pilot.mkv', size: 50_000 }] }],
  });
  const complete = await runLibrarySync(active.client, active.serverId, 'shows');
  assertEquals(complete.itemsProcessed, 1);
  assertEquals(complete.pruneCompleted, true);
});

Deno.test('non-qualifying sync publication leaves relocation barriers incomplete', async () => {
  for (const qualifyingShape of ['same-second', 'prune-skipped', 'full-sync'] as const) {
    reset();
    const { operationId, targetId, guidanceId } = await prepareGuidedMovieRelocation();
    const finished = finishRelocation(operationId, targetId, 1, guidanceId, true);
    const targeted = qualifyingShape !== 'full-sync';
    const startedAt = qualifyingShape === 'same-second'
      ? finished.barrier.supersededAt
      : finished.barrier.supersededAt + 1;
    const syncId = withTransaction((client) =>
      client.prepare(
        `INSERT INTO sync_log (server_id, library_key, started_at, status, items_processed)
         VALUES (1, ?, ?, 'pending', 0) RETURNING id`,
      ).value<[number]>(targeted ? 'movies' : null, startedAt)![0]
    );

    await finalizeSyncLog(syncId, 1, targeted ? 'movies' : null, {
      ok: true,
      itemsProcessed: qualifyingShape === 'prune-skipped' ? 0 : 1,
      ...(targeted
        ? {
          generation: startedAt,
          pruneCompleted: qualifyingShape !== 'prune-skipped',
        }
        : {}),
    });

    const operation = getDeletionOperation(operationId, 1)!;
    const target = (operation.targets as Array<Record<string, unknown>>).find((entry) =>
      entry.id === targetId
    )!;
    assertEquals(
      (target.relocationSyncBarrier as { finishedAt?: number }).finishedAt,
      undefined,
      qualifyingShape,
    );
    assertEquals(
      withTransaction((client) =>
        client.prepare('SELECT status FROM sync_log WHERE id = ?').value<[string]>(syncId)?.[0]
      ),
      'success',
      qualifyingShape,
    );
  }
});

Deno.test('barrier completion skips target milestone drift and leaves the barrier incomplete', async () => {
  reset();
  const { operationId, targetId, guidanceId } = await prepareGuidedMovieRelocation();
  const finished = finishRelocation(operationId, targetId, 1, guidanceId, true);
  withTransaction((client) => {
    client.prepare(
      "UPDATE deletion_targets SET phase = 'arr_coordination' WHERE id = ?",
    ).run(targetId);
    assertEquals(
      completeRelocationBarriers(
        client,
        1,
        'movies',
        1001,
        finished.barrier.supersededAt + 1,
        finished.barrier.supersededAt + 2,
      ),
      0,
    );
  });
  const operation = getDeletionOperation(operationId, 1)!;
  const target = (operation.targets as Array<Record<string, unknown>>)[0]!;
  assertEquals(target.relocationSyncBarrierState, 'invalid');
  assertEquals(target.relocationSyncBarrier, undefined);
  const persistedBarrier = withTransaction((client) =>
    JSON.parse(
      client.prepare('SELECT snapshot FROM deletion_targets WHERE id = ?').value<[string]>(
        targetId,
      )![0],
    ).relocationSyncBarrier
  );
  assertEquals(persistedBarrier, finished.barrier);
});

Deno.test('targeted sync publication atomically completes only a guarded relocation barrier', async () => {
  reset();
  const { operationId, targetId, guidanceId } = await prepareGuidedMovieRelocation();
  const finished = finishRelocation(operationId, targetId, 1, guidanceId, true);
  const startedAt = finished.barrier.supersededAt + 1;
  const syncId = withTransaction((client) =>
    client.prepare(
      "INSERT INTO sync_log (server_id, library_key, started_at, status, items_processed) VALUES (1, 'movies', ?, 'pending', 0) RETURNING id",
    ).value<[number]>(startedAt)![0]
  );

  await finalizeSyncLog(syncId, 1, 'movies', {
    ok: true,
    itemsProcessed: 1,
    generation: startedAt,
    pruneCompleted: true,
  });

  withTransaction((client) => {
    assertEquals(
      client.prepare('SELECT status FROM sync_log WHERE id = ?').value<[string]>(syncId)?.[0],
      'success',
    );
  });
  const operation = getDeletionOperation(operationId, 1)!;
  const target = (operation.targets as Array<Record<string, unknown>>)[0]!;
  assertEquals(
    (target.relocationSyncBarrier as { syncId?: number }).syncId,
    syncId,
  );
});

Deno.test('targeted sync publication skips a relocation target that is no longer untouched', async () => {
  reset();
  const { operationId, targetId, guidanceId } = await prepareGuidedMovieRelocation();
  const finished = finishRelocation(operationId, targetId, 1, guidanceId, true);
  const startedAt = finished.barrier.supersededAt + 1;
  const syncId = withTransaction((client) => {
    client.prepare('UPDATE deletion_targets SET plex_attempt_count = 1 WHERE id = ?').run(targetId);
    return client.prepare(
      "INSERT INTO sync_log (server_id, library_key, started_at, status, items_processed) VALUES (1, 'movies', ?, 'pending', 0) RETURNING id",
    ).value<[number]>(startedAt)![0];
  });

  await finalizeSyncLog(syncId, 1, 'movies', {
    ok: true,
    itemsProcessed: 1,
    generation: startedAt,
    pruneCompleted: true,
  });

  withTransaction((client) => {
    assertEquals(
      client.prepare('SELECT status FROM sync_log WHERE id = ?').value<[string]>(syncId)?.[0],
      'success',
    );
  });
  const operation = getDeletionOperation(operationId, 1)!;
  const target = (operation.targets as Array<Record<string, unknown>>)[0]!;
  assertEquals(target.relocationSyncBarrierState, 'invalid');
  assertEquals(target.relocationSyncBarrier, undefined);
  const persistedBarrier = withTransaction((client) =>
    JSON.parse(
      client.prepare('SELECT snapshot FROM deletion_targets WHERE id = ?').value<[string]>(
        targetId,
      )![0],
    ).relocationSyncBarrier
  );
  assertEquals(persistedBarrier, finished.barrier);
});

Deno.test('Radarr linked extras block Plex deletion and rescan', async () => {
  reset();
  configureRadarr();
  addMovie('reassign-linked-extra', [12, 13], 10);
  coordinatedRatingKey = 'reassign-linked-extra';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/better.mkv';
  arrExtraMovieFileId = arrManagedFileId;
  live.get('reassign-linked-extra')!.Media = [
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];

  const operationId = await enqueueMovieReassignment('reassign-linked-extra', 12);
  await settle();

  assertEquals(getDeletionOperation(operationId, 1)?.status, 'needs_attention');
  assertEquals(live.get('reassign-linked-extra')?.Media?.map((media) => media.id), [12, 13]);
  assertEquals(arrManagedPath, '/library/Coordinated/movie.mkv');
});

Deno.test('Radarr reassignment rejects adopted file metadata that does not match Plex', async () => {
  reset();
  configureRadarr();
  addMovie('reassign-metadata', [12, 13], 10);
  coordinatedRatingKey = 'reassign-metadata';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/better.mkv';
  arrRescanFileSize = 49_000;
  live.get('reassign-metadata')!.Media = [
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];

  const operationId = await enqueueMovieReassignment('reassign-metadata', 12);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assert(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error).includes(
      'unexpected metadata',
    ),
  );
  assertEquals(live.get('reassign-metadata')?.Media?.map((media) => media.id), [13]);

  // A later full sync may prune the selected projection. Recovery remains bound
  // to the persisted attempt and exact live Plex/Radarr postconditions.
  withTransaction((client) =>
    client.prepare(
      'DELETE FROM item_media_versions WHERE item_rating_key = ? AND media_id = ?',
    ).run('reassign-metadata', 12)
  );
  arrManagedFileSize = 50_000;
  assertEquals(retryDeletionOperation(operationId, 1), true);
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'completed');
});

Deno.test('Radarr reassignment rejects a selected file restored during rescan', async () => {
  reset();
  configureRadarr();
  addMovie('reassign-restored-selected', [12, 13], 10);
  coordinatedRatingKey = 'reassign-restored-selected';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/better.mkv';
  restoreArrPathOnRescan = arrManagedPath;
  live.get('reassign-restored-selected')!.Media = [
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];

  const operationId = await enqueueMovieReassignment('reassign-restored-selected', 12);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assert(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error).includes(
      'unexpected live file state',
    ),
  );
  assertEquals(live.get('reassign-restored-selected')?.Media?.map((media) => media.id), [13]);
});

Deno.test('Plex reconciliation rechecks exact Radarr adoption metadata', async () => {
  reset();
  configureRadarr();
  addMovie('reassign-final-postcondition', [12, 13], 10);
  coordinatedRatingKey = 'reassign-final-postcondition';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/better.mkv';
  arrRescanFileSize = 49_000;
  live.get('reassign-final-postcondition')!.Media = [
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];

  const operationId = await enqueueMovieReassignment('reassign-final-postcondition', 12);
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'needs_attention');

  withTransaction((client) =>
    client.prepare(
      "UPDATE deletion_targets SET phase = 'plex_reconciliation' WHERE operation_id = ?",
    ).run(operationId)
  );
  assertEquals(retryDeletionOperation(operationId, 1), true);
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT plex_attempt_count FROM deletion_targets WHERE operation_id = ?',
      ).value<[number]>(operationId)?.[0]
    ),
    1,
  );
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assert(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error).includes(
      'exact retained-file adoption',
    ),
  );
});

Deno.test('legacy Radarr external repair finalizes without mutation or lifetime attribution', async () => {
  reset();
  configureRadarr();
  addMovie('legacy-radarr-repair', [12, 13], 10);
  coordinatedRatingKey = 'legacy-radarr-repair';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/better.mkv';
  arrRescanFileSize = 49_000;
  live.get('legacy-radarr-repair')!.Media = [
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];
  const operationId = await enqueueMovieReassignment('legacy-radarr-repair', 12);
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'needs_attention');

  arrManagedFileSize = 50_000;
  withTransaction((client) => {
    const row = client.prepare(
      'SELECT id FROM deletion_targets WHERE operation_id = ?',
    ).value<[number]>(operationId)!;
    client.prepare(
      'UPDATE deletion_targets SET plex_attempt_count = 0, removal_confirmed_at = NULL WHERE id = ?',
    ).run(row[0]);
    client.prepare('DELETE FROM media_removals WHERE operation_id = ?').run(operationId);
    client.prepare(
      'DELETE FROM item_media_versions WHERE item_rating_key = ? AND media_id = ?',
    ).run('legacy-radarr-repair', 12);
  });
  assertEquals(retryDeletionOperation(operationId, 1), true);
  await settle();

  const operation = getDeletionOperation(operationId, 1)!;
  const target = (operation.targets as Array<Record<string, unknown>>)[0]!;
  assertEquals(operation.status, 'completed_with_warning', JSON.stringify(operation));
  assertEquals(target.plexAttemptCount, 0);
  assertEquals(arrMonitored, true);
  assertEquals(arrMonitorMutationCount, 2);
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT COUNT(*) FROM media_removals WHERE operation_id = ?').value<[number]>(
        operationId,
      )?.[0]
    ),
    0,
  );
});

Deno.test('legacy Radarr repair without monitoring evidence stays protected and blocked', async () => {
  reset();
  configureRadarr();
  addMovie('legacy-radarr-ambiguous', [12, 13], 10);
  coordinatedRatingKey = 'legacy-radarr-ambiguous';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/better.mkv';
  arrRescanFileSize = 49_000;
  live.get('legacy-radarr-ambiguous')!.Media = [
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];
  const operationId = await enqueueMovieReassignment('legacy-radarr-ambiguous', 12);
  await settle();
  arrManagedFileSize = 50_000;
  withTransaction((client) => {
    const row = client.prepare(
      'SELECT id, snapshot FROM deletion_targets WHERE operation_id = ?',
    ).value<[number, string]>(operationId)!;
    const snapshot = JSON.parse(row[1]);
    delete snapshot.arrReassignments[0].originalMonitored;
    client.prepare(
      'UPDATE deletion_targets SET plex_attempt_count = 0, snapshot = ? WHERE id = ?',
    ).run(JSON.stringify(snapshot), row[0]);
    client.prepare(
      'DELETE FROM item_media_versions WHERE item_rating_key = ? AND media_id = ?',
    ).run('legacy-radarr-ambiguous', 12);
  });
  assertEquals(retryDeletionOperation(operationId, 1), true);
  await settle();

  const operation = getDeletionOperation(operationId, 1)!;
  const target = (operation.targets as Array<Record<string, unknown>>)[0]!;
  assertEquals(operation.status, 'needs_attention', JSON.stringify(operation));
  assertEquals(target.plexAttemptCount, 0);
  assertEquals(target.removalConfirmedAt !== null, true);
  assertStringIncludes(
    String(target.error),
    'cannot recover the original monitoring state',
  );
  assertEquals(arrMonitored, false);
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT COUNT(*) FROM media_removals WHERE operation_id = ?').value<[number]>(
        operationId,
      )?.[0]
    ),
    1,
  );
});

Deno.test('worker fails closed when the Plex source disappears before ownership planning', async () => {
  reset();
  configureRadarr();
  addMovie('reassign-source-disappeared', [12, 13], 10);
  coordinatedRatingKey = 'reassign-source-disappeared';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/better.mkv';
  live.get('reassign-source-disappeared')!.Media = [
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];

  const operationId = await enqueueMovieReassignment('reassign-source-disappeared', 12);
  live.get('reassign-source-disappeared')!.Media = [
    { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assert(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error).includes(
      'before Arr ownership was persisted',
    ),
  );
  assertEquals(arrManagedFilePresent, true);
  assertEquals(arrDeleteCount, 0);
});

Deno.test('direct Plex deletion adopts reassignment when Arr ownership changed after preview', async () => {
  reset();
  configureRadarr();
  addMovie('reassign-after-preview', [12, 13], 10);
  coordinatedRatingKey = 'reassign-after-preview';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/better.mkv';
  live.get('reassign-after-preview')!.Media = [
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];

  const operationId = await enqueueVersion('reassign-after-preview', 12, 10);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(arrPresent, true);
  assertEquals(arrDeleteCount, 0);
  assertEquals(arrMoviePath, '/library/Coordinated');
  assertEquals(arrManagedPath, '/library/Coordinated/better.mkv');
  assertEquals(live.get('reassign-after-preview')?.Media?.map((media) => media.id), [13]);
});

Deno.test('Radarr reassignment converges after a lost rescan response', async () => {
  reset();
  configureRadarr();
  addMovie('reassign-retry', [12, 13], 10);
  coordinatedRatingKey = 'reassign-retry';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/better.mkv';
  loseArrRescanResponse = true;
  live.get('reassign-retry')!.Media = [
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];

  const operationId = await enqueueMovieReassignment('reassign-retry', 12);
  await settle();

  assertEquals(getDeletionOperation(operationId, 1)?.status, 'completed');
  assertEquals(live.get('reassign-retry')?.Media?.map((media) => media.id), [13]);
  assertEquals(arrMonitored, true);
  assertEquals(arrMonitorMutationCount, 2);
  const storedSnapshot = withTransaction((client) =>
    client.prepare(
      'SELECT snapshot FROM deletion_targets WHERE operation_id = ?',
    ).value<[string]>(operationId)?.[0]
  );
  assertEquals(
    JSON.parse(storedSnapshot!).arrReassignments.map(
      (entry: { instanceId: number }) => entry.instanceId,
    ),
    [1],
  );

  assertEquals(arrMoviePath, '/library/Coordinated');
  assertEquals(arrManagedPath, '/library/Coordinated/better.mkv');
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT media_id FROM item_media_versions WHERE item_rating_key = ? ORDER BY media_id',
      ).values('reassign-retry')
    ),
    [[13]],
  );
});

Deno.test('Radarr reassignment preserves a definite rescan rejection', async () => {
  reset();
  configureRadarr();
  addMovie('reassign-rejected-rescan', [12, 13], 10);
  coordinatedRatingKey = 'reassign-rejected-rescan';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/better.mkv';
  rejectArrRescanStatus = 403;
  live.get('reassign-rejected-rescan')!.Media = [
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];

  const operationId = await enqueueMovieReassignment('reassign-rejected-rescan', 12);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  const error = String((operation?.targets as Array<{ error?: string }>)[0]?.error);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assertStringIncludes(error, 'Radarr returned 403: rescan disabled');
  assertEquals(arrManagedPath, '/library/Coordinated/movie.mkv');
  assertEquals(live.get('reassign-rejected-rescan')?.Media?.map((media) => media.id), [13]);
});

Deno.test('reassignment retry rejects changed Arr configuration and protects its retained copy', async () => {
  reset();
  configureRadarr();
  addMovie('reassign-config-change', [12, 13, 14], 10);
  coordinatedRatingKey = 'reassign-config-change';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/better.mkv';
  arrRescanFileSize = 49_000;
  live.get('reassign-config-change')!.Media = [
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
    { id: 14, Part: [{ file: '/library/Other/other.mkv', size: 40_000 }] },
  ];

  const operationId = await enqueueMovieReassignment('reassign-config-change', 12);
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'needs_attention');

  withTransaction((client) =>
    client.prepare(
      "UPDATE arr_instances SET url = 'http://radarr-replacement', updated_at = 2 WHERE id = 1",
    ).run()
  );
  assertEquals(retryDeletionOperation(operationId, 1), true);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assert(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error).includes(
      'changed',
    ),
  );
  await assertRejects(
    () => enqueueVersion('reassign-config-change', 13, 10),
    DeletionConflictError,
    'needs attention',
  );
});

Deno.test('direct Plex retry rejects removal of the last persisted Arr mapping', async () => {
  reset();
  configureRadarr();
  addMovie('direct-mapping-removed', [11, 12], 10);
  live.get('direct-mapping-removed')!.Media = [
    { id: 11, Part: [{ file: '/library/Unmanaged/movie.mkv', size: 50_000 }] },
    { id: 12, Part: [{ file: '/library/Retained/movie.mkv', size: 50_000 }] },
  ];
  failDeleteBeforeMutation = true;

  const operationId = await enqueueVersion('direct-mapping-removed', 11, 10);
  await settle();

  assertEquals(getDeletionOperation(operationId, 1)?.status, 'waiting_retry');
  assertEquals(live.get('direct-mapping-removed')?.Media?.map((media) => media.id), [11, 12]);

  withTransaction((client) => {
    client.prepare(
      "DELETE FROM arr_library_mappings WHERE server_id = 1 AND library_key = 'movies'",
    ).run();
    client.prepare(
      "UPDATE deletion_targets SET next_retry_at = 0 WHERE operation_id = ? AND status = 'waiting_retry'",
    ).run(operationId);
  });
  failDeleteBeforeMutation = false;
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assert(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error).includes(
      'mapped Arr instance set changed',
    ),
  );
  assertEquals(live.get('direct-mapping-removed')?.Media?.map((media) => media.id), [11, 12]);
});

Deno.test('initial execution rejects removal of the accepted Arr mapping', async () => {
  reset();
  configureRadarr();
  addMovie('initial-mapping-removed', [11, 12], 10);
  coordinatedRatingKey = 'initial-mapping-removed';
  arrPresent = true;
  arrManagedMediaId = 11;
  arrManagedPath = '/library/Managed/managed.mkv';
  arrRescanTargetPath = '/library/Retained/retained.mkv';
  live.get('initial-mapping-removed')!.Media = [
    { id: 11, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 12, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];

  const operationId = await enqueueVersion('initial-mapping-removed', 11, 10);
  withTransaction((client) =>
    client.prepare(
      "DELETE FROM arr_library_mappings WHERE server_id = 1 AND library_key = 'movies'",
    ).run()
  );
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assert(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error).includes(
      'mapped Arr instance set changed',
    ),
  );
  assertEquals(arrManagedFilePresent, true);
  assertEquals(
    live.get('initial-mapping-removed')?.Media?.map((media) => media.id),
    [11, 12],
  );
});

Deno.test('Radarr reassignment recovers lost Plex-delete and rescan responses', async () => {
  const boundaries = ['plex-delete', 'rescan'] as const;
  for (const boundary of boundaries) {
    reset();
    configureRadarr();
    const ratingKey = `reassign-lost-${boundary}`;
    addMovie(ratingKey, [12, 13], 10);
    coordinatedRatingKey = ratingKey;
    arrPresent = true;
    arrManagedMediaId = 12;
    arrManagedPath = '/library/Coordinated/movie.mkv';
    arrRescanTargetPath = '/library/Coordinated/better.mkv';
    live.get(ratingKey)!.Media = [
      { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
      { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
    ];
    loseDeleteResponse = boundary === 'plex-delete';
    loseArrRescanResponse = boundary === 'rescan';

    const operationId = await enqueueMovieReassignment(ratingKey, 12);
    await settle();
    const operation = getDeletionOperation(operationId, 1);
    assertEquals(operation?.status, 'completed', `${boundary}: ${JSON.stringify(operation)}`);
    assertEquals(arrPresent, true);
    assertEquals(arrMoviePath, '/library/Coordinated');
    assertEquals(arrManagedPath, '/library/Coordinated/better.mkv');
    assertEquals(live.get(ratingKey)?.Media?.map((media) => media.id), [13]);
    assertEquals(
      withTransaction((client) =>
        client.prepare(
          'SELECT COUNT(*) FROM media_removals WHERE operation_id = ?',
        ).value<[number]>(operationId)?.[0]
      ),
      boundary === 'plex-delete' ? 0 : 1,
      `${boundary}: lifetime attribution`,
    );
  }
});

Deno.test(
  'Radarr recovery after an unsent persisted Plex attempt is not attributable',
  async () => {
    reset();
    configureRadarr();
    const ratingKey = 'reassign-unsent-attempt';
    addMovie(ratingKey, [12, 13], 10);
    coordinatedRatingKey = ratingKey;
    arrPresent = true;
    arrManagedMediaId = 12;
    arrManagedPath = '/library/Coordinated/movie.mkv';
    arrRescanTargetPath = '/library/Coordinated/better.mkv';
    live.get(ratingKey)!.Media = [
      { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
      { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
    ];
    activatePlaybackOnManagedFileRead = 3;

    const operationId = await enqueueMovieReassignment(ratingKey, 12);
    await settle();
    assertEquals(getDeletionOperation(operationId, 1)?.status, 'needs_attention');

    activePlaybackRatingKey = null;
    activatePlaybackOnManagedFileRead = null;
    const externallyChanged = live.get(ratingKey)!;
    externallyChanged.Media = externallyChanged.Media!.filter((media) => media.id !== 12);
    withTransaction((client) => {
      client.prepare(
        'UPDATE deletion_targets SET plex_attempt_count = 1 WHERE operation_id = ?',
      ).run(operationId);
      client.prepare(
        'DELETE FROM item_media_versions WHERE item_rating_key = ? AND media_id = ?',
      ).run(ratingKey, 12);
    });

    assertEquals(retryDeletionOperation(operationId, 1), true);
    await settle();

    const operation = getDeletionOperation(operationId, 1);
    assertEquals(operation?.status, 'completed', JSON.stringify(operation));
    assertEquals(plexMediaDeleteCount, 0);
    assertEquals(arrManagedPath, '/library/Coordinated/better.mkv');
    assertEquals(
      withTransaction((client) =>
        client.prepare(
          'SELECT COUNT(*) FROM media_removals WHERE operation_id = ?',
        ).value<[number]>(operationId)?.[0]
      ),
      0,
    );
  },
);

Deno.test('Radarr reassignment rejects multiple retained competitors in the movie folder', async () => {
  reset();
  configureRadarr();
  addMovie('reassign-quality', [12, 13, 14], 10);
  withTransaction((client) => {
    client.prepare(
      'UPDATE item_media_versions SET height = 2160, video_resolution = ? WHERE media_id = 13',
    ).run('4k');
    client.prepare(
      'UPDATE item_media_versions SET height = 1080, video_resolution = ? WHERE media_id = 14',
    ).run('1080');
  });
  coordinatedRatingKey = 'reassign-quality';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/best.mkv';
  live.get('reassign-quality')!.Media = [
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
    {
      id: 13,
      videoResolution: '1080',
      height: 1080,
      bitrate: 20_000,
      Part: [{ file: '/library/Coordinated/good.mkv', size: 50_000 }],
    },
    {
      id: 14,
      videoResolution: '4k',
      height: 2160,
      bitrate: 10_000,
      Part: [{ file: '/library/Coordinated/best.mkv', size: 50_000 }],
    },
  ];

  const operationId = await enqueueMovieReassignment('reassign-quality', 12);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assertEquals(arrMoviePath, '/library/Coordinated');
  assertEquals(arrManagedPath, '/library/Coordinated/movie.mkv');
  assertEquals(
    live.get('reassign-quality')?.Media?.map((media) => media.id),
    [12, 13, 14],
  );
});

Deno.test('Radarr reassignment rechecks active playback immediately before file deletion', async () => {
  reset();
  configureRadarr();
  addMovie('reassign-playback', [12, 13], 10);
  coordinatedRatingKey = 'reassign-playback';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Coordinated/movie.mkv';
  arrRescanTargetPath = '/library/Coordinated/better.mkv';
  live.get('reassign-playback')!.Media = [
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
    { id: 13, Part: [{ file: arrRescanTargetPath, size: 50_000 }] },
  ];
  // The initial plan reads the file list twice. Playback appears during the
  // boundary revalidation that follows durable plan persistence.
  activatePlaybackOnManagedFileRead = 3;

  const operationId = await enqueueMovieReassignment('reassign-playback', 12);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assertEquals(arrManagedFilePresent, true);
  assertEquals(
    live.get('reassign-playback')?.Media?.map((media) => media.id),
    [12, 13],
  );
});

Deno.test('direct Plex deletion rechecks playback after Arr ownership discovery', async () => {
  reset();
  configureRadarr();
  addMovie('direct-playback', [11, 12], 10);
  coordinatedRatingKey = 'direct-playback';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Managed/managed.mkv';
  live.get('direct-playback')!.Media = [
    { id: 11, Part: [{ file: '/library/Selected/selected.mkv', size: 50_000 }] },
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
  ];
  activatePlaybackOnManagedFileRead = 1;

  const operationId = await enqueueVersion('direct-playback', 11, 10);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assert(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error).includes(
      'active playback',
    ),
  );
  assertEquals(
    live.get('direct-playback')?.Media?.map((media) => media.id),
    [11, 12],
  );
});

Deno.test('direct Plex deletion rechecks playback after final Arr verification', async () => {
  reset();
  configureRadarr();
  addMovie('direct-late-playback', [11, 12], 10);
  coordinatedRatingKey = 'direct-late-playback';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Managed/managed.mkv';
  live.get('direct-late-playback')!.Media = [
    { id: 11, Part: [{ file: '/library/Selected/selected.mkv', size: 50_000 }] },
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
  ];
  activatePlaybackOnManagedFileRead = 2;

  const operationId = await enqueueVersion('direct-late-playback', 11, 10);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assert(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error).includes(
      'active playback',
    ),
  );
  assertEquals(
    live.get('direct-late-playback')?.Media?.map((media) => media.id),
    [11, 12],
  );
});

Deno.test('direct Plex deletion fails closed when the retained version disappears during final Arr verification', async () => {
  reset();
  configureRadarr();
  addMovie('direct-retained-disappeared', [11, 12], 10);
  coordinatedRatingKey = 'direct-retained-disappeared';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Managed/managed.mkv';
  live.get('direct-retained-disappeared')!.Media = [
    { id: 11, Part: [{ file: '/library/Selected/selected.mkv', size: 50_000 }] },
    { id: 12, Part: [{ file: arrManagedPath, size: 50_000 }] },
  ];
  removePlexMediaOnManagedFileRead = {
    read: 2,
    ratingKey: 'direct-retained-disappeared',
    mediaId: 12,
  };

  const operationId = await enqueueVersion('direct-retained-disappeared', 11, 10);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assert(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error).includes(
      'changed its managed ownership',
    ),
    JSON.stringify(operation),
  );
  assertEquals(
    live.get('direct-retained-disappeared')?.Media?.map((media) => media.id),
    [11],
  );
});

Deno.test('direct Plex deletion promotes newly adopted Arr ownership to reassignment', async () => {
  reset();
  configureRadarr();
  addMovie('direct-late-ownership', [11, 12], 10);
  coordinatedRatingKey = 'direct-late-ownership';
  arrPresent = true;
  arrManagedMediaId = 12;
  arrManagedPath = '/library/Retained/retained.mkv';
  arrMoviePath = '/library/Retained';
  arrRescanTargetPath = '/library/Retained/retained.mkv';
  changeArrOwnershipOnManagedFileRead = {
    read: 2,
    mediaId: 11,
    path: '/library/Selected/selected.mkv',
  };
  live.get('direct-late-ownership')!.Media = [
    { id: 11, Part: [{ file: '/library/Selected/selected.mkv', size: 50_000 }] },
    { id: 12, Part: [{ file: '/library/Retained/retained.mkv', size: 50_000 }] },
  ];

  const operationId = await enqueueVersion('direct-late-ownership', 11, 10);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(arrDeleteCount, 0);
  assertEquals(arrPresent, true);
  assertEquals(arrManagedPath, '/library/Retained/retained.mkv');
  assertEquals(live.get('direct-late-ownership')?.Media?.map((media) => media.id), [12]);
  const storedSnapshot = withTransaction((client) =>
    client.prepare(
      'SELECT snapshot FROM deletion_targets WHERE operation_id = ?',
    ).value<[string]>(operationId)?.[0]
  );
  assertEquals(JSON.parse(storedSnapshot!).arrReassignments[0].retainedMediaId, 12);
});

Deno.test('direct Plex deletion fails closed when Radarr managed-path ownership is unresolved', async () => {
  reset();
  configureRadarr();
  addMovie('direct-unresolved-radarr', [11, 12], 10);
  coordinatedRatingKey = 'direct-unresolved-radarr';
  arrPresent = true;
  arrManagedMediaId = 11;
  arrManagedPath = 'selected.mkv';
  live.get('direct-unresolved-radarr')!.Media = [
    { id: 11, Part: [{ file: '/library/Selected/selected.mkv', size: 50_000 }] },
    { id: 12, Part: [{ file: '/library/Retained/retained.mkv', size: 50_000 }] },
  ];

  const operationId = await enqueueVersion('direct-unresolved-radarr', 11, 10);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assert(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error).includes(
      'ownership could not be resolved safely',
    ),
    JSON.stringify(operation),
  );
  assertEquals(arrManagedFilePresent, true);
  assertEquals(
    live.get('direct-unresolved-radarr')?.Media?.map((media) => media.id),
    [11, 12],
  );
});

Deno.test('Sonarr reassignment keeps the episode monitored and adopts the retained version', async () => {
  reset();
  configureSonarr();
  addEpisode();
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/better.mkv';
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];

  const operationId = await enqueueEpisodeReassignment(21);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(sonarrManagedPath, '/tv/Show/Season 01/better.mkv');
  assertEquals(sonarrMonitorMutationCount, 2);
  assertEquals(sonarrMonitored, true);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [22]);
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT media_id FROM episode_media_versions WHERE episode_rating_key = ? ORDER BY media_id',
      ).values('episode-1')
    ),
    [[22]],
  );
});

Deno.test('Sonarr reassignment stops when the detached old path is still present', async () => {
  reset();
  configureSonarr();
  addEpisode();
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/better.mkv';
  sonarrOldPathLingersAfterDelete = true;
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];
  const operationId = await enqueueEpisodeReassignment(21);

  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'waiting_retry', JSON.stringify(operation));
  assertStringIncludes(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error),
    'path is still present',
  );
  assertEquals(sonarrRescanCount, 0);
  assertEquals(sonarrMonitored, false);
});

Deno.test('failed Sonarr adoption can accept the exact removed-and-unmonitored state', async () => {
  reset();
  configureSonarr();
  addEpisode();
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/better.mkv';
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];
  const preview = await seasonPreviewEvidence('season-1', ['episode-1'], {
    sonarrMode: 'adopt_retained',
    cleanupDownloads: false,
  });
  const enqueue = await seasonCleanupRequest('season-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-accept-removed-unmonitored',
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      ...preview,
    }),
  });
  assertEquals(enqueue.status, 202, await enqueue.clone().text());
  const { operationId } = await enqueue.json();
  const targetId = withTransaction((client) => {
    const row = client.prepare(
      'SELECT id, snapshot FROM deletion_targets WHERE operation_id = ?',
    ).value<[number, string]>(operationId)!;
    const snapshot = JSON.parse(row[1]);
    snapshot.arrReassignments = [{
      ...snapshot.arrReassignmentMappings[0],
      recordId: 8,
      recordPath: '/tv/Show',
      episodeId: 9,
      managedFileId: 10,
      managedPath: sonarrManagedPath,
      managedFileSize: 40_000,
      retainedMediaId: 22,
      retainedPath: sonarrRescanTargetPath,
      retainedRecordPath: '/tv/Show',
      retainedFileSize: 40_000,
      originalMonitored: true,
      sonarrTransition: {
        candidateAllowlist: [{ mediaId: 22, path: sonarrRescanTargetPath, size: 40_000 }],
        preDeletionPreflight: snapshot.seasonPreDeletionPreflight,
        oldFileRemovalConfirmedAt: 2,
      },
    }];
    client.prepare(
      "UPDATE deletion_targets SET snapshot = ?, status = 'needs_attention', phase = 'arr_coordination', error = 'adoption did not converge' WHERE id = ?",
    ).run(JSON.stringify(snapshot), row[0]);
    refreshDeletionOperation(client, operationId);
    return row[0];
  });
  sonarrManagedFilePresent = false;
  sonarrMonitored = false;
  assertEquals(
    (getDeletionOperation(operationId, 1)?.targets as Array<{
      seasonRemovedUnmonitoredAvailable?: boolean;
    }>)[0]?.seasonRemovedUnmonitoredAvailable,
    true,
  );

  const accepted = await app.request(
    `/api/deletion-operations/${operationId}/targets/${targetId}/accept-removed-unmonitored`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ acknowledge: true }),
    },
  );
  assertEquals(accepted.status, 200, await accepted.clone().text());
  assertEquals((await accepted.json()).status, 'queued');
  await settle();

  const completed = getDeletionOperation(operationId, 1);
  assertEquals(completed?.status, 'completed', JSON.stringify(completed));
  assertEquals(sonarrMonitored, false);
  assertEquals(sonarrManagedFilePresent, false);
  assertEquals(sonarrRescanCount, 0);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [22]);
});

Deno.test('failed Sonarr adoption can authorize one fresh reassignment attempt', async () => {
  reset();
  configureSonarr();
  addEpisode();
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/better.mkv';
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];
  const preview = await seasonPreviewEvidence('season-1', ['episode-1'], {
    sonarrMode: 'adopt_retained',
    cleanupDownloads: false,
  });
  const enqueue = await seasonCleanupRequest('season-1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRequestId: 'season-retry-reassignment',
      selections: [{ episodeRatingKey: 'episode-1', mediaIds: [21] }],
      ...preview,
    }),
  });
  assertEquals(enqueue.status, 202, await enqueue.clone().text());
  const { operationId } = await enqueue.json();
  const targetId = withTransaction((client) => {
    const row = client.prepare(
      'SELECT id, snapshot FROM deletion_targets WHERE operation_id = ?',
    ).value<[number, string]>(operationId)!;
    const snapshot = JSON.parse(row[1]);
    snapshot.arrReassignments = [{
      ...snapshot.arrReassignmentMappings[0],
      recordId: 8,
      recordPath: '/tv/Show',
      episodeId: 9,
      managedFileId: 10,
      managedPath: sonarrManagedPath,
      managedFileSize: 40_000,
      retainedMediaId: 22,
      retainedPath: sonarrRescanTargetPath,
      retainedRecordPath: '/tv/Show',
      retainedFileSize: 40_000,
      originalMonitored: true,
      sonarrTransition: {
        candidateAllowlist: [{ mediaId: 22, path: sonarrRescanTargetPath, size: 40_000 }],
        preDeletionPreflight: snapshot.seasonPreDeletionPreflight,
        oldFileRemovalConfirmedAt: 2,
        postDeletionPreflight: snapshot.seasonPreDeletionPreflight,
        manualImportAttemptedAt: 3,
        manualImportCommandId: 81,
        rescanAuthorizedAt: 4,
        rescanPreSnapshot: {
          episodes: [{
            id: 9,
            seriesId: 8,
            seasonNumber: 1,
            episodeNumber: 1,
            episodeFileId: 0,
            monitored: false,
          }],
          files: [],
        },
        rescanInventory: [],
        rescanAttemptedAt: 5,
      },
    }];
    client.prepare(
      "UPDATE deletion_targets SET snapshot = ?, status = 'needs_attention', phase = 'arr_coordination', error = 'adoption did not converge' WHERE id = ?",
    ).run(JSON.stringify(snapshot), row[0]);
    refreshDeletionOperation(client, operationId);
    return row[0];
  });
  sonarrManagedFilePresent = false;
  sonarrMonitored = false;
  const before = getDeletionOperation(operationId, 1);
  assertEquals(
    (before?.targets as Array<{ seasonReassignmentRetryAvailable?: boolean }>)[0]
      ?.seasonReassignmentRetryAvailable,
    true,
  );

  const retry = await app.request(
    `/api/deletion-operations/${operationId}/targets/${targetId}/retry-sonarr-reassignment`,
    { method: 'POST' },
  );
  assertEquals(retry.status, 200, await retry.clone().text());
  assertEquals((await retry.json()).status, 'queued');
  await settle();

  const completed = getDeletionOperation(operationId, 1);
  assertEquals(completed?.status, 'completed', JSON.stringify(completed));
  assertEquals(sonarrManagedPath, sonarrRescanTargetPath);
  assertEquals(sonarrMonitored, true);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [22]);
});

Deno.test('Sonarr reassignment preserves an originally unmonitored episode without a PUT', async () => {
  reset();
  configureSonarr();
  addEpisode();
  sonarrMonitored = false;
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/better.mkv';
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];

  const operationId = await enqueueEpisodeReassignment(21);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(sonarrMonitored, false);
  assertEquals(sonarrMonitorMutationCount, 0);
  const storedSnapshot = withTransaction((client) =>
    client.prepare('SELECT snapshot FROM deletion_targets WHERE operation_id = ?').value<[string]>(
      operationId,
    )?.[0]
  );
  assertEquals(JSON.parse(storedSnapshot!).arrReassignments[0].originalMonitored, false);
});

Deno.test('Sonarr reassignment reconciles lost monitoring responses at both boundaries', async () => {
  for (const mutation of [1, 2]) {
    reset();
    configureSonarr();
    addEpisode();
    sonarrManagedMediaId = 21;
    sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
    sonarrRescanTargetPath = '/tv/Show/Season 01/better.mkv';
    live.get('episode-1')!.Media = [
      { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
      { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
    ];
    loseMonitorResponseAtMutation = mutation;

    const operationId = await enqueueEpisodeReassignment(21);
    await settle();

    const operation = getDeletionOperation(operationId, 1);
    assertEquals(operation?.status, 'completed', JSON.stringify(operation));
    assertEquals(sonarrMonitored, true);
    assertEquals(sonarrMonitorMutationCount, 2);
    assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [22]);
  }
});

Deno.test('Sonarr reassignment retries a definite monitoring restoration rejection', async () => {
  reset();
  configureSonarr();
  addEpisode();
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/better.mkv';
  rejectMonitorAtMutation = 2;
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];

  const operationId = await enqueueEpisodeReassignment(21);
  await settle();

  let operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'waiting_retry', JSON.stringify(operation));
  assertEquals(sonarrManagedPath, '/tv/Show/Season 01/better.mkv');
  assertEquals(sonarrMonitored, false);
  assertEquals(sonarrMonitorMutationCount, 1);
  assertEquals(sonarrRescanCount, 1);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [22]);

  rejectMonitorAtMutation = null;
  makeRetryReady(operationId);
  await settle();

  operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(sonarrMonitored, true);
  assertEquals(sonarrMonitorMutationCount, 2);
  assertEquals(sonarrRescanCount, 1);
});

Deno.test('Sonarr reassignment re-establishes protection after post-delete drift', async () => {
  reset();
  configureSonarr();
  addEpisode();
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/better.mkv';
  monitorDriftAfterSelectedDelete = true;
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];

  const operationId = await enqueueEpisodeReassignment(21);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(sonarrMonitored, true);
  assertEquals(sonarrMonitorMutationCount, 3);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [22]);
});

Deno.test('Sonarr reassignment repairs monitoring drift before final Plex reconciliation', async () => {
  reset();
  configureSonarr();
  addEpisode();
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/better.mkv';
  monitorDriftAfterRestorationReads = 2;
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];

  const operationId = await enqueueEpisodeReassignment(21);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(sonarrMonitored, true);
  assertEquals(sonarrMonitorMutationCount, 3);
  assertEquals(sonarrRescanCount, 1);
});

Deno.test('persistent final Sonarr monitoring failure exhausts into attention', async () => {
  reset();
  configureSonarr();
  addEpisode();
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/better.mkv';
  monitorDriftAfterRestorationReads = 2;
  rejectMonitorAtMutation = 3;
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];

  const operationId = await enqueueEpisodeReassignment(21);
  await settle();
  for (let retry = 0; retry < 3; retry++) {
    const operation = getDeletionOperation(operationId, 1);
    assertEquals(operation?.status, 'waiting_retry', JSON.stringify(operation));
    makeRetryReady(operationId);
    await settle();
  }

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assertEquals(sonarrMonitored, false);
  assertEquals(sonarrMonitorMutationCount, 2);
  assertEquals(sonarrRescanCount, 1);
});

Deno.test('originally unmonitored Sonarr reassignment repairs post-delete drift', async () => {
  reset();
  configureSonarr();
  addEpisode();
  sonarrMonitored = false;
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/better.mkv';
  monitorDriftAfterSelectedDelete = true;
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];

  const operationId = await enqueueEpisodeReassignment(21);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(sonarrMonitored, false);
  assertEquals(sonarrMonitorMutationCount, 1);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [22]);
});

Deno.test('originally unmonitored Sonarr reassignment stops on pre-delete drift', async () => {
  reset();
  configureSonarr();
  addEpisode();
  sonarrMonitored = false;
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/better.mkv';
  monitorDriftAfterUnmonitoredEvidence = true;
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];

  const operationId = await enqueueEpisodeReassignment(21);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assertStringIncludes(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error),
    'monitoring changed before file deletion',
  );
  assertEquals(sonarrMonitorMutationCount, 0);
  assertEquals(sonarrManagedFilePresent, true);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [21, 22]);
});

Deno.test('Sonarr reassignment does not delete when protection cannot be confirmed', async () => {
  reset();
  configureSonarr();
  addEpisode();
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/better.mkv';
  rejectMonitoringWrites = true;
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];

  const operationId = await enqueueEpisodeReassignment(21);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'waiting_retry', JSON.stringify(operation));
  assertStringIncludes(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error),
    'returned 503',
  );
  assertEquals(sonarrMonitored, true);
  assertEquals(sonarrMonitorMutationCount, 0);
  assertEquals(sonarrManagedFilePresent, true);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [21, 22]);
});

Deno.test('direct Plex deletion fails closed when Sonarr managed-path ownership is unresolved', async () => {
  reset();
  configureSonarr();
  addEpisode();
  sonarrManagedMediaId = 21;
  sonarrManagedPath = 'old.mkv';
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: '/tv/Show/Season 01/old.mkv', size: 40_000 }] },
    { id: 22, Part: [{ file: '/tv/Show/Season 01/retained.mkv', size: 40_000 }] },
  ];

  const operationId = await enqueueEpisodeReassignment(21);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assert(
    String((operation?.targets as Array<{ error?: string }>)[0]?.error).includes(
      'ownership could not be resolved safely',
    ),
    JSON.stringify(operation),
  );
  assertEquals(sonarrManagedFilePresent, true);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [21, 22]);
});

Deno.test('Sonarr reassignment rejects a file shared by another episode', async () => {
  reset();
  configureSonarr();
  addEpisode();
  sonarrManagedFileShared = true;
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/shared.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/better.mkv';
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];

  const operationId = await enqueueEpisodeReassignment(21);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'needs_attention', JSON.stringify(operation));
  assertEquals(sonarrManagedFilePresent, true);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [21, 22]);
});

Deno.test('Sonarr reassignment recovers lost file-delete and rescan responses', async () => {
  for (const boundary of ['managed-delete', 'rescan'] as const) {
    reset();
    configureSonarr();
    addEpisode();
    sonarrManagedMediaId = 21;
    sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
    sonarrRescanTargetPath = '/tv/Show/Season 01/better.mkv';
    live.get('episode-1')!.Media = [
      { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
      { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
    ];
    loseArrManagedDeleteResponse = boundary === 'managed-delete';
    loseArrRescanResponse = boundary === 'rescan';

    const operationId = await enqueueEpisodeReassignment(21);
    await settle();
    const operation = getDeletionOperation(operationId, 1);
    assertEquals(operation?.status, 'completed', `${boundary}: ${JSON.stringify(operation)}`);
    assertEquals(sonarrManagedPath, '/tv/Show/Season 01/better.mkv');
    assertEquals(sonarrMonitorMutationCount, 2);
    assertEquals(sonarrMonitored, true);
    assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [22]);
  }
});

Deno.test('Sonarr reassignment falls back to guarded rescan after definite manual import rejection', async () => {
  reset();
  configureSonarr();
  addEpisode();
  sonarrManagedMediaId = 21;
  sonarrManagedPath = '/tv/Show/Season 01/old.mkv';
  sonarrRescanTargetPath = '/tv/Show/Season 01/better.mkv';
  rejectSonarrManualImportStatus = 400;
  live.get('episode-1')!.Media = [
    { id: 21, Part: [{ file: sonarrManagedPath, size: 40_000 }] },
    { id: 22, Part: [{ file: sonarrRescanTargetPath, size: 40_000 }] },
  ];

  const operationId = await enqueueEpisodeReassignment(21);
  await settle();

  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(sonarrRescanCount, 2);
  assertEquals(sonarrManagedPath, sonarrRescanTargetPath);
  assertEquals(sonarrMonitored, true);
  assertEquals(live.get('episode-1')?.Media?.map((media) => media.id), [22]);
});

Deno.test('lost destructive response finalizes from the same-attempt exact postcondition', async () => {
  reset();
  addMovie('movie-replay');
  loseDeleteResponse = true;
  const operationId = await enqueueVersion('movie-replay');
  await settle();
  const operation = getDeletionOperation(operationId, 1);
  assertEquals(operation?.status, 'completed', JSON.stringify(operation));
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM item_media_versions WHERE server_id = 1 AND media_id = 11',
      ).value<[number]>()?.[0]
    ),
    0,
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM media_version_reservations WHERE operation_id = ?',
      ).value<[number]>(operationId)?.[0]
    ),
    0,
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM media_removals WHERE operation_id = ?',
      ).value<[number]>(operationId)?.[0]
    ),
    0,
  );
});

Deno.test('terminal validation failure stays visible and retains the version reservation', async () => {
  reset();
  addMovie('movie-drift');
  live.get('movie-drift')!.title = 'Different movie';
  const operationId = await enqueueVersion('movie-drift');
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'needs_attention');
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM media_version_reservations WHERE operation_id = ?',
      ).value<[number]>(operationId)?.[0]
    ),
    1,
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT COUNT(*) FROM events WHERE type = 'deletion.completed' AND payload LIKE ?",
      ).value<[number]>(`%${operationId}%`)?.[0]
    ),
    1,
  );
});

Deno.test('Plex-phase recovery revalidates durable identity before deleting', async () => {
  reset();
  addMovie('plex-phase-drift');
  const operationId = await enqueueVersion('plex-phase-drift');
  withTransaction((client) => {
    client.prepare(
      "UPDATE deletion_targets SET phase = 'plex_reconciliation' WHERE operation_id = ?",
    ).run(operationId);
  });
  live.get('plex-phase-drift')!.title = 'Reused rating key';

  await settle();

  const operation = getDeletionOperation(operationId, 1)!;
  const target = (operation.targets as Array<Record<string, unknown>>)[0];
  assertEquals(operation.status, 'needs_attention', JSON.stringify(operation));
  assertEquals(target.phase, 'plex_reconciliation');
  assertEquals(target.plexAttemptCount, 0);
  assertEquals(live.get('plex-phase-drift')?.Media?.map((media) => media.id), [11, 12]);
});

Deno.test('completed sync prunes a previously stored pathless movie version', async () => {
  reset();
  addMovie('sync-pathless');
  live.get('sync-pathless')!.Media![0]!.Part = [{
    file: '/movies/sync-pathless-11.mkv',
    size: 50_000,
  }];
  live.get('sync-pathless')!.Media![1]!.Part = [{ size: 50_000 }];

  const active = await resolveActiveServer();
  const result = await runLibrarySync(active.client, active.serverId, 'movies');

  assertEquals(result.pruneCompleted, true);
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT media_id FROM item_media_versions WHERE server_id = 1 AND item_rating_key = 'sync-pathless' ORDER BY media_id",
      ).values<[number]>().map(([mediaId]) => mediaId)
    ),
    [11],
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT file_size FROM items WHERE server_id = 1 AND rating_key = 'sync-pathless'",
      ).value<[number]>()?.[0]
    ),
    50,
  );
});

Deno.test('completed sync prunes a version retained only by Plex bulk metadata', async () => {
  reset();
  addMovie('sync-bulk-ghost');
  bulkMetadataOverrides.set('sync-bulk-ghost', structuredClone(live.get('sync-bulk-ghost')!));
  live.get('sync-bulk-ghost')!.Media = [live.get('sync-bulk-ghost')!.Media![0]!];

  const active = await resolveActiveServer();
  const result = await runLibrarySync(active.client, active.serverId, 'movies');

  assertEquals(result.pruneCompleted, true);
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT media_id FROM item_media_versions WHERE server_id = 1 AND item_rating_key = 'sync-bulk-ghost' ORDER BY media_id",
      ).values<[number]>().map(([mediaId]) => mediaId)
    ),
    [11],
  );
});

Deno.test('exact-metadata failure aborts sync without pruning stored versions', async () => {
  reset();
  addMovie('sync-exact-failure');
  const active = await resolveActiveServer();
  await runLibrarySync(active.client, active.serverId, 'movies');

  live.get('sync-exact-failure')!.Media = [live.get('sync-exact-failure')!.Media![0]!];
  bulkMetadataOverrides.set('sync-exact-failure', {
    ...structuredClone(live.get('sync-exact-failure')!),
    Media: [
      live.get('sync-exact-failure')!.Media![0]!,
      {
        id: 12,
        Part: [{ file: '/movies/sync-exact-failure-12.mkv', size: 50_000 }],
      },
    ],
  });
  exactMetadataFailureStatus = 400;

  await assertRejects(
    () => runLibrarySync(active.client, active.serverId, 'movies'),
    Error,
    'Plex 400 reading metadata sync-exact-failure',
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT media_id FROM item_media_versions WHERE server_id = 1 AND item_rating_key = 'sync-exact-failure' ORDER BY media_id",
      ).values<[number]>().map(([mediaId]) => mediaId)
    ),
    [11, 12],
  );
});

Deno.test('sync preserves a needs-attention version projection until manual retry finalizes it', async () => {
  reset();
  addMovie('sync-recovery');
  addMovie('sync-survivor', [31, 32]);
  failDeleteBeforeMutation = true;
  const operationId = await enqueueVersion('sync-recovery');
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'waiting_retry');

  // Model transient retry exhaustion while Plex still exposes the version.
  withTransaction((client) => {
    client.prepare(
      "UPDATE deletion_targets SET status = 'needs_attention', next_retry_at = NULL WHERE operation_id = ?",
    ).run(operationId);
    client.prepare(
      "UPDATE deletion_operations SET status = 'needs_attention', next_retry_at = NULL WHERE id = ?",
    ).run(operationId);
  });
  failDeleteBeforeMutation = false;
  bulkMetadataOverrides.set('sync-survivor', structuredClone(live.get('sync-survivor')!));
  live.get('sync-survivor')!.Media = [live.get('sync-survivor')!.Media![0]!];

  assertEquals(
    withTransaction((client) => deletionRecoveryProjectionRoots(client, 1, 'movies')),
    ['sync-recovery'],
  );

  const active = await resolveActiveServer();
  const result = await runLibrarySync(active.client, active.serverId, 'movies');
  assertEquals(result.pruneCompleted, false);
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM item_media_versions WHERE server_id = 1 AND media_id = 11',
      ).value<[number]>()?.[0]
    ),
    1,
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT media_id FROM item_media_versions WHERE server_id = 1 AND item_rating_key = 'sync-survivor' ORDER BY media_id",
      ).values<[number]>().map(([mediaId]) => mediaId)
    ),
    [31],
  );

  assertEquals(retryDeletionOperation(operationId, 1), true);
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'completed');
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM media_version_reservations WHERE operation_id = ?',
      ).value<[number]>(operationId)?.[0]
    ),
    0,
  );
});

Deno.test('library-only sync preserves the server-wide identity generation', async () => {
  reset();
  addMovie('targeted-sync');
  withTransaction((client) => {
    client.prepare('UPDATE servers SET users_synced_at = 123 WHERE id = 1').run();
    client.prepare(
      'UPDATE libraries SET history_synced_at = 123 WHERE server_id = 1',
    ).run();
  });

  const active = await resolveActiveServer();
  await runLibrarySync(active.client, active.serverId, 'movies');

  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT users_synced_at FROM servers WHERE id = 1')
        .value<[number]>()?.[0]
    ),
    123,
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT history_synced_at FROM libraries WHERE server_id = 1 AND key = 'shows'",
      ).value<[number]>()?.[0]
    ),
    123,
  );
});

Deno.test('malformed history leaves library coverage incomplete', async () => {
  reset();
  addMovie('history-item');
  historyAccountId = 'not-an-id';
  withTransaction((client) => {
    client.prepare(
      "UPDATE libraries SET history_synced_at = 123 WHERE server_id = 1 AND key = 'movies'",
    ).run();
  });

  const active = await resolveActiveServer();
  await assertRejects(
    () => runLibrarySync(active.client, active.serverId, 'movies'),
    Error,
    'history contained an invalid account id',
  );
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        "SELECT history_synced_at FROM libraries WHERE server_id = 1 AND key = 'movies'",
      ).value<[number | null]>()?.[0]
    ),
    null,
  );
});

Deno.test('sync preserves a needs-attention whole-item projection until manual retry', async () => {
  reset();
  addMovie('whole-sync-recovery');
  addMovie('whole-sync-survivor', [31, 32]);
  const operationId = await enqueueWhole('whole-sync-recovery');
  live.delete('whole-sync-recovery');
  withTransaction((client) => {
    client.prepare(
      "UPDATE deletion_targets SET status = 'needs_attention' WHERE operation_id = ?",
    ).run(operationId);
    client.prepare(
      "UPDATE deletion_operations SET status = 'needs_attention' WHERE id = ?",
    ).run(operationId);
  });

  const active = await resolveActiveServer();
  await runLibrarySync(active.client, active.serverId, 'movies');
  assertEquals(
    withTransaction((client) =>
      client.prepare('SELECT COUNT(*) FROM items WHERE server_id = 1 AND rating_key = ?')
        .value<[number]>('whole-sync-recovery')?.[0]
    ),
    1,
  );

  assertEquals(retryDeletionOperation(operationId, 1), true);
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'completed_with_warning');
});

Deno.test('manual retry cannot create two active operations for one library', async () => {
  reset();
  addMovie('old-failure');
  live.get('old-failure')!.title = 'Different movie';
  const oldOperationId = await enqueueVersion('old-failure');
  await settle();
  assertEquals(getDeletionOperation(oldOperationId, 1)?.status, 'needs_attention');

  addMovie('new-work', [31, 32]);
  const newOperationId = await enqueueVersion('new-work', 31);
  assertEquals(getDeletionOperation(newOperationId, 1)?.status, 'queued');
  assertEquals(retryDeletionOperation(oldOperationId, 1), false);
});

Deno.test('new whole-item deletion cannot overlap a version target needing attention', async () => {
  reset();
  addMovie('recovery-overlap');
  live.get('recovery-overlap')!.title = 'Different movie';
  const operationId = await enqueueVersion('recovery-overlap');
  await settle();
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'needs_attention');

  await assertRejects(
    () => enqueueWhole('recovery-overlap'),
    DeletionConflictError,
    'retry it from Activity first',
  );
});

Deno.test('startup recovery requeues a running target from the beginning', async () => {
  reset();
  addMovie('movie-recover');
  const operationId = await enqueueVersion('movie-recover');
  withTransaction((client) => {
    client.prepare("UPDATE deletion_targets SET status = 'running' WHERE operation_id = ?").run(
      operationId,
    );
    client.prepare("UPDATE deletion_operations SET status = 'running' WHERE id = ?").run(
      operationId,
    );
    recoverInterruptedDeletionWork(client, 123);
    assertEquals(
      client.prepare('SELECT status FROM deletion_targets WHERE operation_id = ?').value(
        operationId,
      ),
      ['queued'],
    );
  });
});

Deno.test('cancellation releases only reservations for targets that never started', async () => {
  reset();
  addMovie('movie-cancel');
  const operationId = await enqueueVersion('movie-cancel');
  withTransaction((client) => {
    client.prepare("UPDATE deletion_targets SET status = 'queued' WHERE operation_id = ?").run(
      operationId,
    );
  });
  assert(cancelDeletionOperation(operationId, 1));
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'cancelled');
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM media_version_reservations WHERE operation_id = ?',
      ).value<[number]>(operationId)?.[0]
    ),
    0,
  );
});

Deno.test('cancellation preserves a recovered Sonarr target that already started', async () => {
  reset();
  configureSonarr();
  addEpisode();
  const operationId = await enqueueEpisodeReassignment(21);
  withTransaction((client) => {
    client.prepare(
      `UPDATE deletion_targets
       SET status = 'queued', phase = 'arr_coordination', attempt_count = 1
       WHERE operation_id = ?`,
    ).run(operationId);
  });

  assertEquals(cancelDeletionOperation(operationId, 1), false);
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'queued');
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM media_version_reservations WHERE operation_id = ?',
      ).value<[number]>(operationId)?.[0]
    ),
    1,
  );
});

Deno.test('restart cancellation cannot release a transitioned Radarr path target', async () => {
  reset();
  addMovie('movie-transitioned-cancel');
  const operationId = await enqueueVersion('movie-transitioned-cancel');
  withTransaction((client) => {
    client.prepare(
      `UPDATE deletion_targets
       SET status = 'queued', snapshot = json_set(
         snapshot,
         '$.arrReassignments[0].radarrPathPlan.mode', 'adopt_safe_path',
         '$.arrReassignments[0].radarrPathPlan.transition.monitoringProtectionAttemptedAt', 100
       )
       WHERE operation_id = ?`,
    ).run(operationId);
  });

  assertEquals(cancelDeletionOperation(operationId, 1), false);
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'queued');
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM media_version_reservations WHERE operation_id = ?',
      ).value<[number]>(operationId)?.[0]
    ),
    1,
  );
});

Deno.test('restart cancellation cannot release a transitioned Radarr removal target', async () => {
  reset();
  addMovie('movie-removal-transitioned-cancel');
  const operationId = await enqueueVersion('movie-removal-transitioned-cancel');
  withTransaction((client) => {
    client.prepare(
      `UPDATE deletion_targets
       SET status = 'queued', snapshot = json_set(
         snapshot,
         '$.radarrRemovalFallback.mode', 'remove_from_radarr',
         '$.radarrRemovalFallback.transition.monitoringProtectionAttemptedAt', 100
       )
       WHERE operation_id = ?`,
    ).run(operationId);
  });

  assertEquals(cancelDeletionOperation(operationId, 1), false);
  assertEquals(getDeletionOperation(operationId, 1)?.status, 'queued');
  assertEquals(
    withTransaction((client) =>
      client.prepare(
        'SELECT COUNT(*) FROM media_version_reservations WHERE operation_id = ?',
      ).value<[number]>(operationId)?.[0]
    ),
    1,
  );
});

Deno.test('unresolved Radarr removal protects its retained Plex version', async () => {
  reset();
  addMovie('movie-removal-retained-overlap');
  const operationId = await enqueueVersion('movie-removal-retained-overlap', 11);
  withTransaction((client) => {
    client.prepare(
      `UPDATE deletion_targets
       SET status = 'needs_attention',
           snapshot = json_set(snapshot, '$.radarrRemovalFallback.retainedMediaId', 12)
       WHERE operation_id = ?`,
    ).run(operationId);
    refreshDeletionOperation(client, operationId);
  });

  await assertRejects(
    () => enqueueVersion('movie-removal-retained-overlap', 12),
    DeletionConflictError,
    'retry it from Activity first',
  );
});
