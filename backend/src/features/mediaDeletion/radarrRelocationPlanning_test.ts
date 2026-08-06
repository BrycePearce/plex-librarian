import { assertEquals } from '@std/assert';
import { planRadarrMovieRelocation } from './radarrRelocationPlanning.ts';

const base = {
  selectedMediaId: 11,
  selectedPlexPath: '/movies/Movie/selected.mkv',
  selectedArrPath: '/movies/Movie/selected.mkv',
  retainedMediaId: 12,
  retainedPlexPath: '/movies/retained.mkv',
  retainedArrPath: '/movies/retained.mkv',
  retainedFileSize: 50_000,
  managedDirectoryPath: '/movies/Movie',
  occupiedArrPaths: ['/movies/Movie/selected.mkv', '/movies/retained.mkv'],
  arrInstanceId: 1,
  arrInstanceName: 'Radarr',
  arrRecordId: 7,
  arrManagedFileId: 8,
  mappingIdentity: '{"addImportExclusion":true,"pathMappings":[]}',
  destinationVisibility: (_path: string) => Promise.resolve('folder' as const),
};

Deno.test('Radarr relocation planner owns exact movie-folder destination construction', async () => {
  const candidate = await planRadarrMovieRelocation(base);
  assertEquals(candidate?.destinationArrPath, '/movies/Movie/retained.mkv');
  assertEquals(candidate?.destinationPlexPath, '/movies/Movie/retained.mkv');
  assertEquals(candidate?.sourceArrPath, '/movies/retained.mkv');
});

Deno.test('Radarr relocation planner rejects wrong selected folder and destination collision', async () => {
  assertEquals(
    await planRadarrMovieRelocation({
      ...base,
      selectedArrPath: '/movies/Other/selected.mkv',
    }),
    null,
  );
  assertEquals(
    await planRadarrMovieRelocation({
      ...base,
      occupiedArrPaths: [...base.occupiedArrPaths, '/movies/Movie/retained.mkv'],
    }),
    null,
  );
});

Deno.test('Radarr relocation planner derives Plex destination through selected mapping', async () => {
  const mappingIdentity = JSON.stringify({
    addImportExclusion: true,
    pathMappings: [
      { kind: 'library', arrPath: '/movies', localPath: '/plex-movies' },
      { kind: 'library', arrPath: '/archive', localPath: '/plex-archive' },
    ],
  });
  const candidate = await planRadarrMovieRelocation({
    ...base,
    selectedPlexPath: '/plex-movies/Movie/selected.mkv',
    retainedPlexPath: '/plex-archive/retained.mkv',
    retainedArrPath: '/archive/retained.mkv',
    occupiedArrPaths: ['/movies/Movie/selected.mkv', '/archive/retained.mkv'],
    mappingIdentity,
  });
  assertEquals(candidate?.destinationPlexPath, '/plex-movies/Movie/retained.mkv');
});
