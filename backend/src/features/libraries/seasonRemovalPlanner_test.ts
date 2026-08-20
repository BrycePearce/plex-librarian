import { assertEquals, assertThrows } from '@std/assert';
import { resolve } from '@std/path';
import type { PlexSeasonDeletionEpisode } from '../../integrations/plex/types.ts';

const testDirectory = await Deno.makeTempDir();
Deno.env.set('DB_PATH', resolve(testDirectory, 'season-removal-planner.db'));
const {
  canonicalSeasonEpisodeEvidence,
  canonicalSeasonMembershipEvidence,
  seasonPlexPathEvidence,
  seasonEpisodeEvidenceOnlyDisappeared,
  sonarrSeasonCoverageContainsPlex,
} = await import('./seasonRemovalPlanner.ts');

function episode(
  ratingKey: string,
  episodeIndex: number,
  path: string,
  byteSize = 100,
): PlexSeasonDeletionEpisode {
  return {
    ratingKey,
    title: `Episode ${episodeIndex}`,
    showRatingKey: 'show-1',
    seasonRatingKey: 'season-1',
    seasonIndex: 1,
    episodeIndex,
    media: [{ mediaId: episodeIndex, paths: [{ path, byteSize }] }],
  };
}

Deno.test('whole-season evidence deduplicates a shared multi-episode file', () => {
  const paths = seasonPlexPathEvidence([
    episode('episode-1', 1, '/shows/Example/Season 01/S01E01-E02.mkv'),
    episode('episode-2', 2, '/shows/Example/Season 01/S01E01-E02.mkv'),
  ]);
  assertEquals([...paths.values()], [{
    path: '/shows/Example/Season 01/S01E01-E02.mkv',
    byteSize: 100,
  }]);
});

Deno.test('whole-season evidence rejects conflicting aliases for one path', () => {
  assertThrows(
    () =>
      seasonPlexPathEvidence([
        episode('episode-1', 1, 'C:\\Shows\\Example\\S01E01-E02.mkv'),
        episode('episode-2', 2, 'c:\\shows\\example\\s01e01-e02.mkv'),
      ]),
    Error,
    'conflicting evidence',
  );
});

Deno.test('whole-season evidence is canonical across Plex response ordering', () => {
  const first = episode('episode-1', 1, '/shows/Example/Season 01/S01E01.mkv');
  first.media.push({ mediaId: 10, paths: [{ path: '/shows/Example/alt.mkv', byteSize: 80 }] });
  const second = episode('episode-2', 2, '/shows/Example/Season 01/S01E02.mkv');
  const reordered = structuredClone(first);
  reordered.media.reverse();
  assertEquals(
    canonicalSeasonEpisodeEvidence([first, second]),
    canonicalSeasonEpisodeEvidence([second, reordered]),
  );
});

Deno.test('whole-season evidence ignores title edits but retains exact media identity', () => {
  const accepted = episode('episode-1', 1, '/shows/Example/Season 01/S01E01.mkv');
  const renamed = structuredClone(accepted);
  renamed.title = 'Corrected episode title';
  assertEquals(
    canonicalSeasonEpisodeEvidence([accepted]),
    canonicalSeasonEpisodeEvidence([renamed]),
  );

  const replaced = structuredClone(accepted);
  replaced.media[0]!.paths[0]!.path = '/shows/Example/Season 01/S01E01-replaced.mkv';
  assertEquals(
    canonicalSeasonEpisodeEvidence([accepted]) === canonicalSeasonEpisodeEvidence([replaced]),
    false,
  );
});

Deno.test('whole-season membership ignores file loss but not episode drift', () => {
  const accepted = episode('episode-1', 1, '/shows/Example/Season 01/S01E01.mkv');
  const missingFile = structuredClone(accepted);
  missingFile.media = [];
  missingFile.title = 'Renamed episode';
  assertEquals(
    canonicalSeasonMembershipEvidence([accepted]),
    canonicalSeasonMembershipEvidence([missingFile]),
  );
  assertEquals(
    canonicalSeasonMembershipEvidence([accepted]) ===
      canonicalSeasonMembershipEvidence([episode('episode-2', 2, '/shows/Example/S01E02.mkv')]),
    false,
  );
});

Deno.test('post-mutation evidence allows loss but rejects replacement media', () => {
  const accepted = episode('episode-1', 1, '/shows/Example/Season 01/S01E01.mkv');
  const missing = structuredClone(accepted);
  missing.media = [];
  assertEquals(seasonEpisodeEvidenceOnlyDisappeared([accepted], [missing]), true);

  const replaced = structuredClone(accepted);
  replaced.media[0]!.paths[0]!.path = '/shows/Example/Season 01/S01E01-replaced.mkv';
  assertEquals(seasonEpisodeEvidenceOnlyDisappeared([accepted], [replaced]), false);

  const additional = structuredClone(accepted);
  additional.media.push({
    mediaId: 2,
    paths: [{ path: '/shows/Example/Season 01/S01E01-4k.mkv', byteSize: 200 }],
  });
  assertEquals(seasonEpisodeEvidenceOnlyDisappeared([accepted], [additional]), false);
});

Deno.test('Sonarr coordination accepts a unique superset of Plex episodes', () => {
  const plex = [
    episode('episode-1', 1, '/shows/Example/Season 01/S01E01.mkv'),
    episode('episode-2', 2, '/shows/Example/Season 01/S01E02.mkv'),
  ];
  assertEquals(
    sonarrSeasonCoverageContainsPlex(plex, [
      { episodeNumber: 3 },
      { episodeNumber: 2 },
      { episodeNumber: 1 },
    ]),
    true,
  );
  assertEquals(sonarrSeasonCoverageContainsPlex(plex, [{ episodeNumber: 1 }]), false);
  assertEquals(
    sonarrSeasonCoverageContainsPlex(plex, [
      { episodeNumber: 1 },
      { episodeNumber: 1 },
      { episodeNumber: 2 },
    ]),
    false,
  );
});
