import { assertEquals } from '@std/assert';
import { resolve } from '@std/path';
import type { PlexSeasonDeletionEpisode } from '../../integrations/plex/types.ts';

const testDirectory = await Deno.makeTempDir();
Deno.env.set('DB_PATH', resolve(testDirectory, 'season-removal-planner.db'));
const {
  canonicalSeasonMembershipEvidence,
  seasonEpisodeEvidenceOnlyDisappeared,
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
