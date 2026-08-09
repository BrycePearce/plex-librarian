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
