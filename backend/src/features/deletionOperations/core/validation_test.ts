import { assertThrows } from '@std/assert';
import {
  DeletionValidationError,
  type DurableTargetSnapshot,
  validateArrMonitoringEvidence,
} from './validation.ts';

function removalSnapshot(mappingIdentity: string): DurableTargetSnapshot {
  return {
    machineIdentifier: 'plex-machine',
    serverUrl: 'http://plex:32400',
    libraryKey: 'movies',
    ratingKey: '100',
    title: 'Movie',
    type: 'movie',
    tmdbId: 550,
    tvdbId: null,
    mediaId: 11,
    arrReassignmentMappings: [{
      instanceId: 7,
      instanceType: 'radarr',
      instanceUrl: 'http://radarr:7878',
      configurationUpdatedAt: 100,
      mappingIdentity,
    }],
    radarrRemovalFallback: {
      mode: 'remove_from_radarr',
      arrInstanceId: 7,
      arrConfigurationUpdatedAt: 100,
      arrMappingIdentity: 'accepted-mapping',
      movieId: 42,
      tmdbId: 550,
      movieTitle: 'Movie',
      movieYear: 1999,
      selectedMediaId: 11,
      retainedMediaId: 12,
      selectedPlexPath: '/movies/Movie/old.mkv',
      managedPath: '/movies/Movie/old.mkv',
      retainedPlexPath: '/downloads/Movie/new.mkv',
      retainedFileSize: 100,
      originalMoviePath: '/movies/Movie',
      originalMonitored: true,
      createImportExclusion: true,
      deleteFiles: false,
      addImportExclusion: true,
      userAuthorizedRadarrRemoval: true,
      planFingerprint: 'fingerprint',
    },
  };
}

Deno.test('Radarr removal consent remains bound to the accepted mapping identity', () => {
  validateArrMonitoringEvidence(removalSnapshot('accepted-mapping'));
  assertThrows(
    () => validateArrMonitoringEvidence(removalSnapshot('changed-mapping')),
    DeletionValidationError,
    'mapping identity is inconsistent',
  );
});

function consentPathSnapshot(authorized: boolean): DurableTargetSnapshot {
  return {
    machineIdentifier: 'plex-machine',
    serverUrl: 'http://plex:32400',
    libraryKey: 'movies',
    ratingKey: '100',
    title: 'Movie',
    type: 'movie',
    tmdbId: 550,
    tvdbId: null,
    mediaId: 11,
    arrReassignments: [{
      instanceId: 7,
      instanceType: 'radarr',
      instanceUrl: 'http://radarr:7878',
      configurationUpdatedAt: 100,
      mappingIdentity: 'mapping',
      recordId: 42,
      recordPath: '/movies/Movie',
      episodeId: null,
      managedFileId: 5,
      managedPath: '/movies/Movie/old.mkv',
      retainedMediaId: 12,
      retainedPath: '/downloads/Movie/new.mkv',
      originalMonitored: true,
      radarrPathPlan: {
        mode: 'adopt_path_with_consent',
        arrInstanceId: 7,
        movieId: 42,
        retainedMediaId: 12,
        originalMoviePath: '/movies/Movie',
        targetMoviePath: '/downloads/Movie',
        retainedPath: '/downloads/Movie/new.mkv',
        originalMonitored: true,
        originalMovieFile: {
          id: 5,
          path: '/movies/Movie/old.mkv',
          relativePath: 'old.mkv',
          size: 100,
        },
        pathOwnership: 'explicit_user_managed_location',
        userAuthorizedPathManagement: authorized,
        planFingerprint: 'fingerprint',
        radarrBehaviorFingerprint: 'behavior',
        radarrVersion: '6.3.0.10514',
        behaviorSummary: {
          deleteEmptyFolders: false,
          fileDate: 'none',
          metadataConsumerCount: 0,
          notificationConsumerCount: 0,
        },
        namespaceEvidence: {
          selected: {
            plexMappingId: 1,
            plexMappingRevision: 1,
            plexPath: '/plex/Movie/old.mkv',
            localPath: '/media/Movie/old.mkv',
            arrPath: '/movies/Movie/old.mkv',
            arrMappingKind: 'library',
            arrMappingRoot: '/movies',
            arrLocalRoot: '/media',
          },
          retained: {
            plexMappingId: 2,
            plexMappingRevision: 1,
            plexPath: '/plex-downloads/Movie/new.mkv',
            localPath: '/downloads/Movie/new.mkv',
            arrPath: '/downloads/Movie/new.mkv',
            arrMappingKind: 'download',
            arrMappingRoot: '/downloads',
            arrLocalRoot: '/downloads',
          },
          libraryLocations: [],
        },
        physicalIdentityEvidence: {
          selectedLocalPath: '/media/Movie/old.mkv',
          retainedLocalPath: '/downloads/Movie/new.mkv',
          selectedSize: 100,
          retainedSize: 100,
          selectedDevice: '1',
          selectedInode: '10',
          retainedDevice: '1',
          retainedInode: '20',
          selectedParentDevice: '1',
          selectedParentInode: '11',
          retainedParentDevice: '1',
          retainedParentInode: '21',
          selectedCanonicalPath: '/media/Movie/old.mkv',
          retainedCanonicalPath: '/downloads/Movie/new.mkv',
        },
      },
    }],
  };
}

Deno.test('break-glass Radarr path adoption requires durable explicit authorization', () => {
  assertThrows(
    () => validateArrMonitoringEvidence(consentPathSnapshot(false)),
    DeletionValidationError,
    'consent is missing',
  );
  validateArrMonitoringEvidence(consentPathSnapshot(true));
});

function sonarrAdoptionSnapshot(preflightPath: string): DurableTargetSnapshot {
  const candidate = {
    path: preflightPath,
    size: 200,
    seriesId: 42,
    seasonNumber: 1,
    episodeIds: [9],
    quality: {
      quality: { id: 1, name: 'HDTV-1080p', source: 'television', resolution: 1080 },
      revision: { version: 1, real: 0, isRepack: false },
    },
    languages: [{ id: 1, name: 'English' }],
    releaseGroup: '',
    indexerFlags: 0,
    releaseType: 'singleEpisode',
    rejectionReasons: [],
  };
  return {
    machineIdentifier: 'plex-machine',
    serverUrl: 'http://plex:32400',
    libraryKey: 'shows',
    ratingKey: 'episode-1',
    title: 'Pilot',
    type: 'episode',
    tmdbId: null,
    tvdbId: 100,
    mediaId: 11,
    seasonCleanup: true,
    seasonCoordinationOutcome: 'automatic_adoption',
    seasonSonarrVersion: '4.0.19.2979',
    seasonIndex: 1,
    episodeIndex: 1,
    seasonSelectedCandidateMediaId: 12,
    seasonSafeCandidateMediaIds: [12],
    seasonPreDeletionPreflight: candidate,
    arrReassignmentMappings: [],
    arrOwnerships: [],
    arrReassignments: [{
      instanceId: 7,
      instanceType: 'sonarr',
      instanceUrl: 'http://sonarr:8989',
      configurationUpdatedAt: 100,
      mappingIdentity: 'mapping',
      recordId: 42,
      recordPath: '/tv/Show',
      episodeId: 9,
      managedFileId: 5,
      managedPath: '/tv/Show/Season 01/old.mkv',
      managedFileSize: 100,
      retainedMediaId: 12,
      retainedPath: '/tv/Show/Season 01/retained.mkv',
      retainedRecordPath: '/tv/Show',
      retainedFileSize: 200,
      originalMonitored: true,
      sonarrTransition: {
        candidateAllowlist: [{
          mediaId: 12,
          path: '/tv/Show/Season 01/retained.mkv',
          size: 200,
        }],
        preDeletionPreflight: candidate,
      },
    }],
  };
}

Deno.test('Sonarr pre-deletion evidence is bound to the selected allowlist candidate', () => {
  validateArrMonitoringEvidence(sonarrAdoptionSnapshot('/tv/Show/Season 01/retained.mkv'));
  assertThrows(
    () => validateArrMonitoringEvidence(sonarrAdoptionSnapshot('/tv/Show/Season 01/other.mkv')),
    DeletionValidationError,
    'transition evidence is malformed',
  );
});
