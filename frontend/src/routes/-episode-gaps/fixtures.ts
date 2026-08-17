import type { EpisodeGapsResponse } from "@shared/types";

export const episodeGapFixture: EpisodeGapsResponse = {
  summary: {
    gapSeasonCount: 12,
    missingEpisodeCount: 31,
    checkedLibraryCount: 3,
    irregularSeasonCount: 2,
  },
  total: 12,
  limit: 50,
  offset: 0,
  libraryAudits: [
    { libraryKey: "tv", libraryTitle: "TV Shows", episodeAuditSyncedAt: 1_786_850_800 },
    { libraryKey: "anime", libraryTitle: "Anime", episodeAuditSyncedAt: 1_786_850_800 },
    { libraryKey: "archive", libraryTitle: "Television Archive", episodeAuditSyncedAt: null },
  ],
  rows: [
    row("station-eleven", "Station Eleven", 1, 1, 10, 8, [{ start: 4, end: 4 }, {
      start: 7,
      end: 7,
    }]),
    row(
      "long-title",
      "The Completely Remarkable Adventures of a Very Long Television Title",
      3,
      1,
      24,
      20,
      [{ start: 8, end: 10 }, { start: 19, end: 19 }],
    ),
    row(
      "anime-show",
      "Orbit Children",
      2,
      1,
      96,
      88,
      [{ start: 13, end: 14 }, { start: 42, end: 46 }, { start: 81, end: 81 }],
      "anime",
      "Anime",
    ),
    {
      ...row("irregular", "Archive Mysteries", 7, 1, 1, 0, []),
      status: "irregular",
      reason: "invalid_episode_index",
      firstEpisodeIndex: null,
      lastEpisodeIndex: null,
      presentCount: 0,
      missingCount: 0,
    },
  ],
};

function row(
  id: string,
  title: string,
  seasonIndex: number,
  first: number,
  last: number,
  present: number,
  missingRanges: Array<{ start: number; end: number }>,
  libraryKey = "tv",
  libraryTitle = "TV Shows",
) {
  return {
    libraryKey,
    libraryTitle,
    showRatingKey: id,
    showTitle: title,
    showThumb: null,
    seasonRatingKey: `${id}-s${seasonIndex}`,
    seasonIndex,
    seasonTitle: `Season ${seasonIndex}`,
    firstEpisodeIndex: first,
    lastEpisodeIndex: last,
    presentCount: present,
    missingCount: missingRanges.reduce((sum, range) => sum + range.end - range.start + 1, 0),
    missingRanges,
    status: "gaps" as const,
    reason: null,
    episodeAuditSyncedAt: 1_786_850_800,
  };
}

export const cleanEpisodeGapFixture: EpisodeGapsResponse = {
  ...episodeGapFixture,
  summary: {
    ...episodeGapFixture.summary,
    gapSeasonCount: 0,
    missingEpisodeCount: 0,
    irregularSeasonCount: 0,
  },
  total: 0,
  rows: [],
};

export const largeEpisodeGapFixture: EpisodeGapsResponse = {
  ...episodeGapFixture,
  total: 50,
  rows: Array.from({ length: 50 }, (_, index) => {
    const template = episodeGapFixture.rows[index % episodeGapFixture.rows.length]!;
    const ordinal = index + 1;
    return {
      ...template,
      showRatingKey: `${template.showRatingKey}-${ordinal}`,
      showTitle: `${template.showTitle} ${ordinal}`,
      seasonRatingKey: `${template.seasonRatingKey}-${ordinal}`,
    };
  }),
};
