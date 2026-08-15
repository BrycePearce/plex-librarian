/// <reference lib="deno.ns" />

import { assertEquals, assertNotEquals } from 'jsr:@std/assert@^1.0.19';
import type { DuplicateEpisodeGroup, MediaStreamSummary, MediaVersion } from './types.ts';
import {
  analyzeSeasonVersionProfiles,
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
  assertEquals(result.profiles.length, 3);
  assertEquals(result.profiles.map((profile) => profile.coverageCount), [4, 4, 1]);
  for (const profile of result.profiles) {
    assertEquals(
      new Set(profile.members.map((member) => member.episodeRatingKey)).size,
      profile.members.length,
    );
  }
  assertEquals(result.recommendedProfileId, null);
});

Deno.test('same-family copies are split into two actionable season lanes', () => {
  const low = (id: number) => version(id, { bitrate: 3_500, fileSize: 200 });
  const high = (id: number) => version(id, { bitrate: 8_000, fileSize: 500 });
  const result = analyzeSeasonVersionProfiles([
    episode('episode-1', [high(1), high(2)]),
    episode('episode-2', [high(3), low(4)]),
    episode('episode-3', [high(5), low(6)]),
  ]);

  assertEquals(result.profiles.length, 2);
  assertEquals(result.profiles.map((profile) => profile.coverageCount), [3, 3]);
  assertEquals(
    result.profiles.every((profile) =>
      new Set(profile.members.map((member) => member.episodeRatingKey)).size === 3
    ),
    true,
  );
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
    new Map([
      ['episode-1:1', '/tv/Show/alpha/Show.S01E01.alpha.mkv'],
      ['episode-1:2', '/tv/Show/beta/Show.S01E01.beta.mkv'],
      ['episode-2:3', '/tv/Show/beta/Show.S01E02.beta.mkv'],
      ['episode-2:4', '/tv/Show/alpha/Show.S01E02.alpha.mkv'],
    ]),
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
