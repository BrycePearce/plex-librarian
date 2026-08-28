import { assertEquals } from '@std/assert';
import {
  decodeEpisodeGapProjection,
  decodeSeasonGapProjection,
  type EpisodeGapProjectionRow,
  type SeasonGapProjectionRow,
} from './projection.ts';

const base: EpisodeGapProjectionRow = {
  libraryKey: 'tv',
  libraryTitle: 'TV',
  showRatingKey: 'show',
  showTitle: 'Show',
  showThumb: null,
  seasonRatingKey: 'season',
  seasonIndex: 1,
  seasonTitle: 'Season 1',
  firstEpisodeIndex: 1,
  lastEpisodeIndex: 5,
  presentCount: 4,
  missingCount: 1,
  missingRangesJson: '[{"start":3,"end":3}]',
  status: 'gaps',
  reason: null,
  episodeAuditSyncedAt: 100,
};

Deno.test('episode gap projection decoder validates ranges and scalar agreement', () => {
  assertEquals(decodeEpisodeGapProjection(base).missingRanges, [{ start: 3, end: 3 }]);
  assertEquals(decodeEpisodeGapProjection({ ...base, missingCount: 2 }).status, 'irregular');
  assertEquals(
    decodeEpisodeGapProjection({ ...base, missingRangesJson: 'broken' }).reason,
    'invalid_projection',
  );
  assertEquals(
    decodeEpisodeGapProjection({
      ...base,
      missingRangesJson: '[{"start":3,"end":4},{"start":4,"end":4}]',
      missingCount: 3,
      presentCount: 2,
    }).status,
    'irregular',
  );
});

Deno.test('season gap projection decoder validates ranges and scalar agreement', () => {
  const season: SeasonGapProjectionRow = {
    libraryKey: 'tv',
    libraryTitle: 'TV',
    showRatingKey: 'show',
    showTitle: 'Show',
    showThumb: null,
    firstSeasonIndex: 1,
    lastSeasonIndex: 4,
    presentCount: 3,
    missingCount: 1,
    missingRangesJson: '[{"start":3,"end":3}]',
    status: 'gaps',
    reason: null,
    episodeAuditSyncedAt: 100,
  };
  assertEquals(decodeSeasonGapProjection(season).missingRanges, [{ start: 3, end: 3 }]);
  assertEquals(decodeSeasonGapProjection({ ...season, missingCount: 2 }).status, 'irregular');
  assertEquals(
    decodeSeasonGapProjection({ ...season, missingRangesJson: 'broken' }).reason,
    'invalid_projection',
  );
});
