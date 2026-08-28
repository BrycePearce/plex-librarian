import type {
  EpisodeGapsEpisodeResponse,
  EpisodeGapsSeasonResponse,
  SeasonGapShow,
} from "@shared/types";

export const episodeGapFixture: EpisodeGapsEpisodeResponse = {
  scope: "episode",
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

export const cleanEpisodeGapFixture: EpisodeGapsEpisodeResponse = {
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

export const largeEpisodeGapFixture: EpisodeGapsEpisodeResponse = {
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

const seasonRows: SeasonGapShow[] = [
  {
    libraryKey: "tv",
    libraryTitle: "TV Shows",
    showRatingKey: "station-eleven",
    showTitle: "Station Eleven",
    showThumb: null,
    firstSeasonIndex: 1,
    lastSeasonIndex: 5,
    presentCount: 4,
    missingCount: 1,
    missingRanges: [{ start: 3, end: 3 }],
    status: "gaps",
    reason: null,
    episodeAuditSyncedAt: 1_786_850_800,
  },
  {
    libraryKey: "archive",
    libraryTitle: "Television Archive",
    showRatingKey: "irregular-seasons",
    showTitle: "Archive Mysteries",
    showThumb: null,
    firstSeasonIndex: null,
    lastSeasonIndex: null,
    presentCount: 0,
    missingCount: 0,
    missingRanges: [],
    status: "irregular",
    reason: "invalid_season_index",
    episodeAuditSyncedAt: null,
  },
];

export const seasonGapFixture: EpisodeGapsSeasonResponse = {
  scope: "season",
  summary: {
    gapShowCount: 1,
    missingSeasonCount: 1,
    checkedLibraryCount: 2,
    irregularShowCount: 1,
  },
  total: seasonRows.length,
  limit: 50,
  offset: 0,
  libraryAudits: episodeGapFixture.libraryAudits,
  rows: seasonRows,
};

export const cleanSeasonGapFixture: EpisodeGapsSeasonResponse = {
  ...seasonGapFixture,
  summary: {
    gapShowCount: 0,
    missingSeasonCount: 0,
    checkedLibraryCount: 3,
    irregularShowCount: 0,
  },
  total: 0,
  rows: [],
};
