/// <reference lib="deno.ns" />

import { assertEquals, assertNotEquals } from 'jsr:@std/assert@^1.0.19';
import type { DuplicateEpisodeGroup, MediaStreamSummary, MediaVersion } from './types.ts';
import {
  analyzeSeasonVersionProfiles,
  type SeasonEpisodeLiveEvidence,
  seasonFilenameFamilyKey,
  seasonPathEvidence,
  seasonVersionFingerprint,
  seasonVersionSourceHint,
} from './seasonVersionProfiles.ts';

const english: MediaStreamSummary = {
  codec: 'eac3',
  language: 'eng',
  channels: 2,
  channelLayout: 'stereo',
  title: 'English Dub',
  forced: false,
  default: true,
};

function version(mediaId: number, overrides: Partial<MediaVersion> = {}): MediaVersion {
  return {
    mediaId,
    videoResolution: '1080',
    width: 1920,
    height: 1080,
    duration: 1_400_000,
    bitrate: 5_000,
    videoCodec: 'h264',
    videoProfile: 'high',
    videoBitDepth: 8,
    videoDynamicRange: null,
    videoFrameRate: '24p',
    videoScanType: 'progressive',
    container: 'mkv',
    audioCodec: 'eac3',
    audioChannels: 2,
    audioProfile: null,
    audioStreams: [english],
    subtitleStreams: [],
    streamDetailsAvailable: true,
    fileSize: 300,
    ...overrides,
  };
}

function episode(key: string, versions: MediaVersion[]): DuplicateEpisodeGroup {
  return {
    mediaType: 'episode',
    libraryKey: 'shows',
    episodeRatingKey: key,
    showRatingKey: 'show',
    seasonRatingKey: 'season',
    showTitle: 'Show',
    showThumb: null,
    seasonIndex: 1,
    episodeIndex: Number(key.replace(/\D/g, '')),
    episodeTitle: key,
    combinedFileSize: 600,
    versions,
  };
}

function completeEvidence(
  episodes: readonly DuplicateEpisodeGroup[],
  paths: ReadonlyMap<string, string | null>,
): Map<string, SeasonEpisodeLiveEvidence> {
  return new Map(episodes.map((item) => [
    item.episodeRatingKey,
    {
      status: 'complete' as const,
      versions: new Map(item.versions.map((media) => [
        media.mediaId,
        { filePath: paths.get(`${item.episodeRatingKey}:${media.mediaId}`) ?? null },
      ])),
    },
  ]));
}

function profileMembers(result: ReturnType<typeof analyzeSeasonVersionProfiles>): string[] {
  return result.profiles.map((profile) =>
    profile.members.map((member) => `${member.episodeRatingKey}:${member.mediaId}`).sort().join('|')
  ).sort();
}

Deno.test('season profile identity ignores sizes, runtime, and stream ordering', () => {
  const subtitle: MediaStreamSummary = {
    ...english,
    codec: 'srt',
    channels: null,
    language: 'jpn',
  };
  const spanish = { ...english, language: 'spa', title: 'Spanish Dub', default: false };
  const first = version(1, { audioStreams: [english, spanish], subtitleStreams: [subtitle] });
  const second = version(99, {
    bitrate: 9_000,
    duration: 1_500_000,
    fileSize: 900,
    audioStreams: [spanish, english],
    subtitleStreams: [subtitle],
  });
  assertEquals(seasonVersionFingerprint(first), seasonVersionFingerprint(second));
});

Deno.test('season profile identity ignores display-only stream titles and defaults', () => {
  const baseline = version(1);
  assertEquals(
    seasonVersionFingerprint(baseline),
    seasonVersionFingerprint(version(2, {
      audioStreams: [{ ...english, title: 'Commentary' }],
    })),
  );
  assertEquals(
    seasonVersionFingerprint(baseline),
    seasonVersionFingerprint(version(3, {
      audioStreams: [{ ...english, default: false }],
    })),
  );
});

Deno.test('season profile identity preserves stable stream semantics and multiplicity', () => {
  const baseline = version(1);
  assertNotEquals(
    seasonVersionFingerprint(baseline),
    seasonVersionFingerprint(version(4, { audioStreams: [english, english] })),
  );
  const subtitle = { ...english, codec: 'srt', channels: null };
  assertNotEquals(
    seasonVersionFingerprint(version(5, { subtitleStreams: [subtitle] })),
    seasonVersionFingerprint(version(6, {
      subtitleStreams: [{ ...subtitle, codec: 'ass' }],
    })),
  );
});

Deno.test('season profile identity separates language, resolution, codec, and HDR', () => {
  const baseline = version(1);
  assertNotEquals(
    seasonVersionFingerprint(baseline),
    seasonVersionFingerprint(version(2, { audioStreams: [{ ...english, language: 'jpn' }] })),
  );
  assertNotEquals(
    seasonVersionFingerprint(baseline),
    seasonVersionFingerprint(version(3, { height: 2160 })),
  );
  assertNotEquals(
    seasonVersionFingerprint(baseline),
    seasonVersionFingerprint(version(4, { videoCodec: 'hevc' })),
  );
  assertNotEquals(
    seasonVersionFingerprint(baseline),
    seasonVersionFingerprint(version(5, { videoDynamicRange: 'HDR10' })),
  );
});

Deno.test('season lanes assign at most one version per episode', () => {
  const dub = (id: number) => version(id);
  const japanese = (id: number) => version(id, { audioStreams: [{ ...english, language: 'jpn' }] });
  const result = analyzeSeasonVersionProfiles([
    episode('episode-1', [dub(1), japanese(2)]),
    episode('episode-2', [dub(3), japanese(4)]),
    episode('episode-3', [dub(5), dub(6), japanese(7)]),
    episode('episode-4', [version(8, { videoCodec: 'hevc' }), japanese(9)]),
  ]);
  assertEquals(result.profiles.length, 2);
  assertEquals(result.profiles.map((profile) => profile.coverageCount), [3, 3]);
  for (const profile of result.profiles) {
    assertEquals(
      new Set(profile.members.map((member) => member.episodeRatingKey)).size,
      profile.members.length,
    );
  }
  assertEquals(result.recommendedProfileId, null);
  assertEquals(result.uncertainEpisodeRatingKeys, ['episode-3']);
});

Deno.test('indistinguishable same-family copies quarantine later ties', () => {
  const low = (id: number) => version(id, { bitrate: 3_500, fileSize: 200 });
  const high = (id: number) => version(id, { bitrate: 8_000, fileSize: 500 });
  const result = analyzeSeasonVersionProfiles([
    episode('episode-1', [high(1), high(2)]),
    episode('episode-2', [high(3), low(4)]),
    episode('episode-3', [high(5), low(6)]),
  ]);

  assertEquals(result.profiles, []);
  assertEquals(result.uncertainEpisodeRatingKeys, ['episode-1', 'episode-2', 'episode-3']);
});

Deno.test('a one-episode third version becomes a standalone lane', () => {
  const low = (id: number) => version(id, { height: 720, bitrate: 2_000 });
  const high = (id: number) => version(id, { height: 1080, bitrate: 6_000 });
  const extra = (id: number) => version(id, { height: 2160, videoCodec: 'hevc', bitrate: 18_000 });
  const result = analyzeSeasonVersionProfiles([
    episode('episode-1', [low(1), high(2), extra(3)]),
    episode('episode-2', [low(4), high(5)]),
    episode('episode-3', [low(6), high(7)]),
  ]);

  assertEquals(result.profiles.map((profile) => profile.coverageCount), [3, 3, 1]);
  assertEquals(result.profiles.find((profile) => profile.coverageCount === 1)?.members, [{
    episodeRatingKey: 'episode-1',
    mediaId: 3,
    filePath: null,
  }]);
});

Deno.test('path and filename hints align otherwise identical release families', () => {
  const release = (id: number) => version(id, { bitrate: 5_000 });
  const episodes = [
    episode('episode-1', [release(1), release(2)]),
    episode('episode-2', [release(3), release(4)]),
  ];
  const result = analyzeSeasonVersionProfiles(
    episodes,
    completeEvidence(
      episodes,
      new Map([
        ['episode-1:1', '/tv/Show/alpha/Show.S01E01.alpha.mkv'],
        ['episode-1:2', '/tv/Show/beta/Show.S01E01.beta.mkv'],
        ['episode-2:3', '/tv/Show/beta/Show.S01E02.beta.mkv'],
        ['episode-2:4', '/tv/Show/alpha/Show.S01E02.alpha.mkv'],
      ]),
    ),
  );

  assertEquals(result.profiles.length, 2);
  assertEquals(
    result.profiles.map((profile) =>
      profile.members.map((member) => member.mediaId).sort().join(',')
    ).sort(),
    ['1,4', '2,3'],
  );
  assertEquals(result.profiles.map((profile) => profile.sourceHints).sort(), [['alpha'], ['beta']]);
  assertEquals(
    result.profiles.flatMap((profile) => profile.members).every((member) => member.filePath),
    true,
  );
});

Deno.test('season source hints prefer the release folder above a season directory', () => {
  assertEquals(
    seasonVersionSourceHint('/data/Anime/Rurouni Kenshin (2023)/Season 1/s01e01.mkv'),
    'Rurouni Kenshin (2023)',
  );
  assertEquals(seasonVersionSourceHint('D:\\TV\\Show\\Specials\\special.mkv'), 'Show');
});

Deno.test('season path evidence is platform-aware and keeps relative paths soft', () => {
  assertEquals(
    seasonPathEvidence('/TV/Release/Season 01//episode.mkv').releaseRootKey,
    '/TV/Release',
  );
  assertEquals(
    seasonPathEvidence('/TV/release/Season 01/episode.mkv').releaseRootKey,
    '/TV/release',
  );
  assertEquals(
    seasonPathEvidence('D:\\TV\\Release\\Season 00\\episode.mkv').releaseRootKey,
    'd:/tv/release',
  );
  assertEquals(
    seasonPathEvidence('d:/tv/release/Specials/episode.mkv').releaseRootKey,
    'd:/tv/release',
  );
  assertEquals(
    seasonPathEvidence('\\\\SERVER\\Share\\Release\\Season 1\\episode.mkv').releaseRootKey,
    '//server/share/release',
  );
  assertEquals(seasonPathEvidence('Release/Season 01/episode.mkv').releaseRootKey, null);
  assertEquals(seasonPathEvidence('episode.mkv').containingDirectoryKey, null);
  assertEquals(
    seasonPathEvidence('  /TV/Release/Season 01/episode.mkv  ').originalPath,
    '  /TV/Release/Season 01/episode.mkv  ',
  );
});

Deno.test('filename families retain recurring identity and remove title and technical vocabulary', () => {
  const item = {
    ...episode('episode-1', [version(1), version(2)]),
    showTitle: 'Example Show',
    episodeTitle: 'Pilot',
  };
  assertEquals(
    seasonFilenameFamilyKey(
      '/tv/Example Show/Season 01/Example.Show.S01E01.Pilot.1080p.WEB-DL.H264-Alpha.mkv',
      item,
    ),
    'alpha',
  );
  assertEquals(
    seasonFilenameFamilyKey('/tv/Example Show/Season 01/Example.Show.S01E01.Pilot.mkv', item),
    null,
  );
});

Deno.test('season lanes condense hidden profile differences across episodes', () => {
  const result = analyzeSeasonVersionProfiles([
    episode('episode-1', [version(1, { videoProfile: 'main' }), version(2, { height: 720 })]),
    episode('episode-2', [
      version(3, { videoProfile: 'high', videoFrameRate: '23.976p' }),
      version(4, { height: 720 }),
    ]),
  ]);
  const lane = result.profiles.find((profile) => profile.videoSummary.includes('1080p'))!;
  assertEquals(lane.coverageCount, 2);
  assertEquals(lane.technicalVariantCount, 2);
  assertEquals(lane.members.map((member) => member.mediaId), [1, 3]);
});

Deno.test('season lanes summarize variable bitrate without splitting identity', () => {
  const result = analyzeSeasonVersionProfiles([
    episode('episode-1', [version(1, { bitrate: 4_800 }), version(2, { videoCodec: 'hevc' })]),
    episode('episode-2', [version(3, { bitrate: 5_600 }), version(4, { videoCodec: 'hevc' })]),
  ]);
  const h264 = result.profiles.find((profile) => profile.videoSummary.includes('H264'))!;
  assertEquals(h264.bitrateSummary, '4.8\u20135.6 Mbps');
  assertEquals(h264.label.startsWith('4.8\u20135.6 Mbps'), true);
  assertEquals(h264.totalFileSize, 600);
});

Deno.test('incomplete stream detail protects the entire episode from profile application', () => {
  const result = analyzeSeasonVersionProfiles([
    episode('episode-1', [version(1), version(2, { streamDetailsAvailable: false })]),
    episode('episode-2', [version(3), version(4, { videoCodec: 'hevc' })]),
  ]);
  assertEquals(result.uncertainEpisodeRatingKeys, ['episode-1']);
  assertEquals(result.profiles.map((profile) => profile.coverageCount), [1, 1]);
});

Deno.test('season profiles never infer a preferred destructive policy', () => {
  const low = (id: number) => version(id, { height: 1080, videoResolution: '1080p' });
  const high = (id: number) =>
    version(id, { height: 2160, videoResolution: '4k', videoCodec: 'hevc' });
  const fallback = (id: number) => version(id, { height: 720, videoResolution: '720p' });
  const result = analyzeSeasonVersionProfiles([
    ...Array.from(
      { length: 9 },
      (_, index) => episode(`episode-${index + 1}`, [low(index * 2 + 1), high(index * 2 + 2)]),
    ),
    episode('episode-10', [low(19), fallback(20)]),
  ]);

  assertEquals(result.profiles.some((profile) => profile.videoSummary.includes('2160p')), true);
  assertEquals(result.recommendedProfileId, null);
});

Deno.test('mismatched and failed live evidence remain visible only as uncertain episodes', () => {
  const episodes = [
    episode('episode-1', [version(1), version(2, { videoCodec: 'hevc' })]),
    episode('episode-2', [version(3), version(4, { videoCodec: 'hevc' })]),
    episode('episode-3', [version(5), version(6, { videoCodec: 'hevc' })]),
  ];
  const evidence = completeEvidence(episodes, new Map());
  evidence.set('episode-1', {
    status: 'mismatch',
    versions: new Map([[1, { filePath: null }], [7, { filePath: null }]]),
    missingExpectedMediaIds: [2],
    unexpectedLiveMediaIds: [7],
  });
  evidence.set('episode-2', { status: 'failed', versions: new Map<number, never>() });
  const result = analyzeSeasonVersionProfiles(episodes, evidence);
  assertEquals(result.uncertainEpisodeRatingKeys, ['episode-1', 'episode-2']);
  assertEquals(result.profiles.map((profile) => profile.coverageCount), [1, 1]);
});

Deno.test('recurring release roots survive resolution, codec, audio, and subtitle transitions', () => {
  const japanese = { ...english, language: 'jpn', title: 'Japanese' };
  const episodes = [
    episode('episode-1', [
      version(1, { height: 480, bitrate: 1_500 }),
      version(2, { height: 720, videoCodec: 'hevc', bitrate: 3_000 }),
    ]),
    episode('episode-2', [
      version(3, { height: 720, videoCodec: 'hevc', audioStreams: [japanese] }),
      version(4, { height: 480, subtitleStreams: [{ ...japanese, codec: 'ass' }] }),
    ]),
    episode('episode-3', [
      version(5, { height: 1080, videoCodec: 'av1' }),
      version(6, { height: 1080, videoCodec: 'av1' }),
    ]),
  ];
  const paths = new Map<string, string | null>();
  for (const item of episodes) {
    paths.set(
      `${item.episodeRatingKey}:${item.versions[0]!.mediaId}`,
      `/anime/Release A/Season 01/${item.episodeRatingKey}.mkv`,
    );
    paths.set(
      `${item.episodeRatingKey}:${item.versions[1]!.mediaId}`,
      `/anime/Release B/Season 01/${item.episodeRatingKey}.mkv`,
    );
  }
  const result = analyzeSeasonVersionProfiles(episodes, completeEvidence(episodes, paths));
  assertEquals(result.uncertainEpisodeRatingKeys, []);
  assertEquals(result.profiles.map((profile) => profile.coverageCount), [3, 3]);
  assertEquals(result.profiles.map((profile) => profile.matchBasis), [
    'release-root',
    'release-root',
  ]);
  assertEquals(
    result.profiles.map((profile) => profile.sourceHints[0]).sort(),
    ['Release A', 'Release B'],
  );
});

Deno.test('multiple recurring roots form deterministic partial lanes without full overlap', () => {
  const episodes = [
    episode('episode-1', [version(1), version(2)]),
    episode('episode-2', [version(3), version(4)]),
    episode('episode-3', [version(5), version(6)]),
  ];
  const roots = [
    ['A', 'B'],
    ['A', 'C'],
    ['B', 'C'],
  ];
  const paths = new Map<string, string | null>();
  episodes.forEach((item, episodeIndex) =>
    item.versions.forEach((media, versionIndex) => {
      paths.set(
        `${item.episodeRatingKey}:${media.mediaId}`,
        `/anime/${roots[episodeIndex]![versionIndex]!}/Season 01/${item.episodeRatingKey}.mkv`,
      );
    })
  );
  const result = analyzeSeasonVersionProfiles(episodes, completeEvidence(episodes, paths));
  assertEquals(result.profiles.length, 3);
  assertEquals(result.profiles.map((profile) => profile.coverageCount), [2, 2, 2]);
  assertEquals(result.uncertainEpisodeRatingKeys, []);
});

Deno.test('technical proximity without a technical lead is quarantined as weak', () => {
  const episodes = [
    episode('episode-1', [
      version(1, { bitrate: 2_000, fileSize: 100 }),
      version(2, { bitrate: 8_000, fileSize: 500 }),
    ]),
    episode('episode-2', [
      version(3, { bitrate: 2_100, fileSize: 110 }),
      version(4, { bitrate: 7_900, fileSize: 490 }),
    ]),
  ];
  const result = analyzeSeasonVersionProfiles(episodes);
  assertEquals(result.profiles, []);
  assertEquals(result.uncertainEpisodeRatingKeys, ['episode-1', 'episode-2']);
});

Deno.test('a shared release root stays soft and falls back to fixed technical matching', () => {
  const episodes = [
    episode('episode-1', [version(1), version(2, { videoCodec: 'hevc' })]),
    episode('episode-2', [version(3, { videoCodec: 'hevc' }), version(4)]),
    episode('episode-3', [version(5), version(6, { videoCodec: 'hevc' })]),
  ];
  const paths = new Map<string, string | null>();
  episodes.forEach((item) =>
    item.versions.forEach((media) => {
      paths.set(
        `${item.episodeRatingKey}:${media.mediaId}`,
        `/tv/Show/Season 01/${item.episodeRatingKey}.${media.mediaId}.mkv`,
      );
    })
  );
  const result = analyzeSeasonVersionProfiles(episodes, completeEvidence(episodes, paths));
  assertEquals(result.uncertainEpisodeRatingKeys, []);
  assertEquals(result.profiles.map((profile) => profile.coverageCount), [3, 3]);
  assertEquals(result.profiles.map((profile) => profile.matchBasis), [
    'technical-only',
    'technical-only',
  ]);
});

Deno.test('recurring filename families separate technically identical shared-folder releases', () => {
  const episodes = [
    episode('episode-1', [version(1), version(2)]),
    episode('episode-2', [version(3), version(4)]),
    episode('episode-3', [version(5), version(6)]),
  ];
  const paths = new Map<string, string | null>();
  for (const item of episodes) {
    paths.set(
      `${item.episodeRatingKey}:${item.versions[0]!.mediaId}`,
      `/tv/Show/Season 01/Show.S01E${item.episodeIndex}.1080p-Alpha.mkv`,
    );
    paths.set(
      `${item.episodeRatingKey}:${item.versions[1]!.mediaId}`,
      `/tv/Show/Season 01/Show.S01E${item.episodeIndex}.1080p-Beta.mkv`,
    );
  }
  const result = analyzeSeasonVersionProfiles(episodes, completeEvidence(episodes, paths));
  assertEquals(result.uncertainEpisodeRatingKeys, []);
  assertEquals(result.profiles.map((profile) => profile.coverageCount), [3, 3]);
  assertEquals(result.profiles.map((profile) => profile.matchBasis), [
    'filename-family',
    'filename-family',
  ]);
  assertEquals(result.profiles.map((profile) => profile.sourceHints[0]).sort(), ['alpha', 'beta']);
});

Deno.test('widest unanchored seed matches root lanes while initializing remaining capacity', () => {
  const rootEpisodes = [
    episode('episode-1', [
      version(1, { height: 480, videoCodec: 'h264' }),
      version(2, { height: 720, videoCodec: 'hevc' }),
    ]),
    episode('episode-2', [
      version(3, { height: 480, videoCodec: 'h264' }),
      version(4, { height: 720, videoCodec: 'hevc' }),
    ]),
  ];
  const unanchoredEpisodes = [
    episode('episode-3', [
      version(5, { height: 480, videoCodec: 'h264' }),
      version(6, { height: 720, videoCodec: 'hevc' }),
      version(7, { height: 1080, videoCodec: 'av1' }),
    ]),
    episode('episode-4', [
      version(8, { height: 1080, videoCodec: 'av1' }),
      version(9, { height: 480, videoCodec: 'h264' }),
      version(10, { height: 720, videoCodec: 'hevc' }),
    ]),
  ];
  const episodes = [...rootEpisodes, ...unanchoredEpisodes];
  const paths = new Map<string, string | null>([
    ['episode-1:1', '/anime/A/Season 01/e1.mkv'],
    ['episode-1:2', '/anime/B/Season 01/e1.mkv'],
    ['episode-2:3', '/anime/A/Season 01/e2.mkv'],
    ['episode-2:4', '/anime/B/Season 01/e2.mkv'],
  ]);
  const result = analyzeSeasonVersionProfiles(episodes, completeEvidence(episodes, paths));
  assertEquals(result.uncertainEpisodeRatingKeys, []);
  assertEquals(result.profiles.map((profile) => profile.coverageCount), [4, 4, 2]);
});

Deno.test('partial anchored lanes use qualified members before assigning unanchored capacity', () => {
  const technical = [
    { videoCodec: 'h264', height: 480 },
    { videoCodec: 'hevc', height: 720 },
    { videoCodec: 'av1', height: 1080 },
  ] as const;
  const anchoredLaneByEpisode = [0, 0, 1, 1, 2, 2];
  const episodes = anchoredLaneByEpisode.map((anchoredLane, episodeIndex) => {
    const remaining = [0, 1, 2].filter((lane) => lane !== anchoredLane);
    return episode(
      `episode-${episodeIndex + 1}`,
      [anchoredLane, ...remaining].map((lane, index) =>
        version(episodeIndex * 3 + index + 1, technical[lane])
      ),
    );
  });
  const paths = new Map<string, string | null>();
  episodes.forEach((item, episodeIndex) => {
    const anchoredLane = anchoredLaneByEpisode[episodeIndex]!;
    paths.set(
      `${item.episodeRatingKey}:${item.versions[0]!.mediaId}`,
      `/anime/Release ${
        String.fromCharCode(65 + anchoredLane)
      }/Season 01/${item.episodeRatingKey}.mkv`,
    );
  });

  const result = analyzeSeasonVersionProfiles(episodes, completeEvidence(episodes, paths));
  assertEquals(result.uncertainEpisodeRatingKeys, []);
  assertEquals(result.profiles.map((profile) => profile.coverageCount), [6, 6, 6]);
  assertEquals(
    result.profiles.map((profile) =>
      new Set(profile.members.map((member) => {
        const item = episodes.find((episode) =>
          episode.episodeRatingKey === member.episodeRatingKey
        )!;
        return item.versions.find((media) => media.mediaId === member.mediaId)!.videoCodec;
      })).size
    ),
    [1, 1, 1],
  );
});

Deno.test('season lane results are invariant to episode and media row permutations', () => {
  const episodes = [
    episode('episode-1', [version(1, { height: 480 }), version(2, { height: 1080 })]),
    episode('episode-2', [version(3, { height: 720 }), version(4, { height: 480 })]),
    episode('episode-3', [version(5, { height: 1080 }), version(6, { height: 720 })]),
  ];
  const paths = new Map<string, string | null>([
    ['episode-1:1', '/anime/A/Season 01/e1.mkv'],
    ['episode-1:2', '/anime/B/Season 01/e1.mkv'],
    ['episode-2:3', '/anime/A/Season 01/e2.mkv'],
    ['episode-2:4', '/anime/B/Season 01/e2.mkv'],
    ['episode-3:5', '/anime/A/Season 01/e3.mkv'],
    ['episode-3:6', '/anime/B/Season 01/e3.mkv'],
  ]);
  const baseline = analyzeSeasonVersionProfiles(episodes, completeEvidence(episodes, paths));
  const permuted = episodes.toReversed().map((item) => ({
    ...item,
    versions: item.versions.toReversed(),
  }));
  const reordered = analyzeSeasonVersionProfiles(permuted, completeEvidence(permuted, paths));
  assertEquals(profileMembers(reordered), profileMembers(baseline));
  assertEquals(reordered.uncertainEpisodeRatingKeys, baseline.uncertainEpisodeRatingKeys);
});

Deno.test('fixed technical representatives make unanchored matching permutation-invariant', () => {
  const episodes = [
    episode('episode-1', [
      version(1, { height: 480, videoCodec: 'h264' }),
      version(2, { height: 720, videoCodec: 'hevc' }),
      version(3, { height: 1080, videoCodec: 'av1' }),
    ]),
    episode('episode-2', [
      version(4, { height: 1080, videoCodec: 'av1' }),
      version(5, { height: 480, videoCodec: 'h264' }),
      version(6, { height: 720, videoCodec: 'hevc' }),
    ]),
    episode('episode-3', [
      version(7, { height: 720, videoCodec: 'hevc' }),
      version(8, { height: 1080, videoCodec: 'av1' }),
      version(9, { height: 480, videoCodec: 'h264' }),
    ]),
  ];
  const baseline = analyzeSeasonVersionProfiles(episodes);
  const permuted = analyzeSeasonVersionProfiles(
    episodes.toReversed().map((item) => ({ ...item, versions: item.versions.toReversed() })),
  );
  assertEquals(profileMembers(permuted), profileMembers(baseline));
  assertEquals(baseline.profiles.map((profile) => profile.coverageCount), [3, 3, 3]);
});

Deno.test('an uncertain episode cannot change other technical assignments', () => {
  const certain = [
    episode('episode-1', [version(1), version(2, { videoCodec: 'hevc' })]),
    episode('episode-2', [version(3), version(4, { videoCodec: 'hevc' })]),
  ];
  const baseline = analyzeSeasonVersionProfiles(certain);
  const withTie = analyzeSeasonVersionProfiles([
    ...certain,
    episode('episode-99', [version(99), version(100)]),
  ]);
  assertEquals(
    profileMembers(withTie).map((members) =>
      members.split('|').filter((member) => !member.startsWith('episode-99:')).join('|')
    ),
    profileMembers(baseline),
  );
  assertEquals(withTie.uncertainEpisodeRatingKeys, ['episode-99']);
});

Deno.test('supported 500 episode by 11 lane root fixture stays within the latency budget', () => {
  const episodes = Array.from({ length: 500 }, (_, episodeIndex) =>
    episode(
      `episode-${episodeIndex + 1}`,
      Array.from({ length: 11 }, (_, laneIndex) =>
        version(episodeIndex * 11 + laneIndex + 1, {
          height: 480 + ((episodeIndex + laneIndex) % 4) * 240,
          videoCodec: (episodeIndex + laneIndex) % 2 === 0 ? 'h264' : 'hevc',
        })),
    ));
  const paths = new Map<string, string | null>();
  episodes.forEach((item) =>
    item.versions.forEach((media, laneIndex) => {
      paths.set(
        `${item.episodeRatingKey}:${media.mediaId}`,
        `/anime/Release ${laneIndex + 1}/Season 01/${item.episodeRatingKey}.mkv`,
      );
    })
  );
  const started = performance.now();
  const result = analyzeSeasonVersionProfiles(episodes, completeEvidence(episodes, paths));
  const elapsed = performance.now() - started;
  assertEquals(result.profiles.length, 11);
  assertEquals(result.profiles.every((profile) => profile.coverageCount === 500), true);
  assertEquals(elapsed < 10_000, true, `matcher took ${elapsed.toFixed(0)}ms`);
});

Deno.test('supported 500 episode by 11 lane technical fixture stays within the latency budget', () => {
  const episodes = Array.from({ length: 500 }, (_, episodeIndex) => {
    const versions = Array.from({ length: 11 }, (_, laneIndex) => {
      const semanticLane = (laneIndex + episodeIndex) % 11;
      return version(episodeIndex * 11 + laneIndex + 1, {
        width: 640 + semanticLane * 160,
        height: 360 + semanticLane * 90,
        bitrate: 1_000 + semanticLane * 1_000,
        fileSize: 100 + semanticLane * 50,
      });
    });
    return episode(`episode-${episodeIndex + 1}`, versions);
  });
  const started = performance.now();
  const result = analyzeSeasonVersionProfiles(episodes);
  const elapsed = performance.now() - started;
  assertEquals(result.profiles.length, 11);
  assertEquals(result.profiles.every((profile) => profile.coverageCount === 500), true);
  assertEquals(result.uncertainEpisodeRatingKeys, []);
  assertEquals(elapsed < 10_000, true, `matcher took ${elapsed.toFixed(0)}ms`);
});
