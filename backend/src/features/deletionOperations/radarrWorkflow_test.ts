import { assertThrows } from '@std/assert';
import {
  assertRadarrRemovalActivityIsQuiet,
  assertRadarrRemovalPlexVersions,
  assertRecoverableRadarrRemovalMonitoringState,
} from './radarrWorkflow.ts';

Deno.test('Radarr removal blocks cleanup when movie activity appears after removal', () => {
  assertRadarrRemovalActivityIsQuiet({ quiet: true }, 'after_removal');
  assertThrows(
    () => assertRadarrRemovalActivityIsQuiet({ quiet: false }, 'after_removal'),
    Error,
    'conflicting movie activity after removal',
  );
});

Deno.test('Radarr removal monitoring protection converges across its crash boundary', () => {
  assertRecoverableRadarrRemovalMonitoringState(true, true, false);
  assertRecoverableRadarrRemovalMonitoringState(true, true, true);
  assertRecoverableRadarrRemovalMonitoringState(true, false, true);
  assertRecoverableRadarrRemovalMonitoringState(false, false, false);
  assertRecoverableRadarrRemovalMonitoringState(false, false, true);

  assertThrows(
    () => assertRecoverableRadarrRemovalMonitoringState(true, false, false),
    Error,
    'preview the deletion again',
  );
  assertThrows(
    () => assertRecoverableRadarrRemovalMonitoringState(false, true, true),
    Error,
    'changed after protection was attempted',
  );
});

Deno.test('Radarr removal stops when the retained Plex version changes during protection', () => {
  const plan = {
    mode: 'remove_from_radarr' as const,
    selectedMediaId: 1,
    retainedMediaId: 2,
    selectedPlexPath: '/movies/selected.mkv',
    retainedPlexPath: '/movies/retained.mkv',
    retainedFileSize: 1,
  } as Parameters<typeof assertRadarrRemovalPlexVersions>[1];

  assertThrows(
    () =>
      assertRadarrRemovalPlexVersions(
        [
          { mediaId: 1, paths: ['/movies/selected.mkv'], truncated: false },
          { mediaId: 2, paths: ['/movies/replaced.mkv'], truncated: false, fileSize: 1 },
        ],
        plan,
      ),
    Error,
    'retained Plex version changed',
  );
});

Deno.test('Radarr removal binds the retained Plex version size', () => {
  const plan = {
    mode: 'remove_from_radarr' as const,
    selectedMediaId: 1,
    retainedMediaId: 2,
    selectedPlexPath: '/movies/selected.mkv',
    retainedPlexPath: '/movies/retained.mkv',
    retainedFileSize: 100,
  } as Parameters<typeof assertRadarrRemovalPlexVersions>[1];

  assertThrows(
    () =>
      assertRadarrRemovalPlexVersions(
        [
          { mediaId: 1, paths: ['/movies/selected.mkv'], truncated: false },
          { mediaId: 2, paths: ['/movies/retained.mkv'], truncated: false, fileSize: 101 },
        ],
        plan,
      ),
    Error,
    'retained Plex version changed',
  );
});

Deno.test('Radarr removal recovery allows only the selected Plex version to be absent', () => {
  const plan = {
    mode: 'remove_from_radarr' as const,
    selectedMediaId: 1,
    retainedMediaId: 2,
    selectedPlexPath: '/movies/selected.mkv',
    retainedPlexPath: '/movies/retained.mkv',
    retainedFileSize: 100,
  } as Parameters<typeof assertRadarrRemovalPlexVersions>[1];

  assertRadarrRemovalPlexVersions(
    [{ mediaId: 2, paths: ['/movies/retained.mkv'], truncated: false, fileSize: 100 }],
    plan,
    { allowSelectedAbsent: true },
  );
  assertThrows(
    () => assertRadarrRemovalPlexVersions([], plan, { allowSelectedAbsent: true }),
    Error,
    'retained Plex version changed',
  );
});
