import { assertEquals } from '@std/assert';
import { analyzeSmartDuplicateVersions } from '@plex-librarian/shared/smartDuplicateAnalysis.ts';
import type { MediaVersion, SmartDuplicateCandidate } from '@plex-librarian/shared/types.ts';
import {
  isValidManualSeasonCleanupSelection,
  isValidSmartCleanupSelection,
  limitSmartDuplicateCandidates,
  SMART_CLEANUP_GROUP_LIMIT,
} from './smartAnalysis.ts';

function version(
  mediaId: number,
  overrides: Partial<MediaVersion> = {},
): MediaVersion {
  return {
    mediaId,
    videoResolution: '1080',
    width: 1920,
    height: 1080,
    duration: 7_200_000,
    bitrate: 10_000,
    videoCodec: 'h264',
    videoProfile: 'high',
    videoBitDepth: 8,
    videoDynamicRange: 'sdr',
    videoFrameRate: '24p',
    videoScanType: 'progressive',
    container: 'mkv',
    audioCodec: 'aac',
    audioChannels: 2,
    audioProfile: 'lc',
    audioStreams: [{
      codec: 'aac',
      language: 'eng',
      channels: 2,
      channelLayout: 'stereo',
      title: null,
      forced: false,
      default: true,
    }],
    subtitleStreams: [],
    streamDetailsAvailable: true,
    fileSize: 5_000,
    ...overrides,
  };
}

Deno.test('smart analysis marks complete matching profiles as obvious', () => {
  assertEquals(
    analyzeSmartDuplicateVersions([
      version(1, { bitrate: 9_800, fileSize: 4_900 }),
      version(2, { bitrate: 10_000, fileSize: 5_000 }),
    ]),
    {
      confidence: 'obvious',
      keepMediaId: 2,
      deleteMediaIds: [1],
      reclaimableSize: 4_900,
      reasons: [
        'Matching runtime, video, HDR, audio, and subtitle streams',
        'Bitrate differs by no more than 5%',
      ],
    },
  );
});

Deno.test('smart analysis recommends modest bitrate differences and reviews larger ones', () => {
  assertEquals(
    analyzeSmartDuplicateVersions([
      version(1, { bitrate: 9_000 }),
      version(2, { bitrate: 10_000 }),
    ])?.confidence,
    'near-identical',
  );
  assertEquals(
    analyzeSmartDuplicateVersions([
      version(1, { bitrate: 8_000 }),
      version(2, { bitrate: 10_000 }),
    ])?.confidence,
    'review',
  );
});

Deno.test('smart analysis treats resolution-only quality ladders as near-identical', () => {
  const recommendation = analyzeSmartDuplicateVersions([
    version(1, {
      videoResolution: '480',
      width: 720,
      height: 480,
      bitrate: 2_000,
      fileSize: 1_000,
    }),
    version(2, {
      videoResolution: '1080',
      width: 1920,
      height: 1080,
      bitrate: 10_000,
      fileSize: 5_000,
    }),
  ]);

  assertEquals(recommendation?.confidence, 'near-identical');
  assertEquals(recommendation?.keepMediaId, 2);
  assertEquals(recommendation?.deleteMediaIds, [1]);
});

Deno.test('smart analysis reviews a higher-resolution copy with lower bitrate', () => {
  const recommendation = analyzeSmartDuplicateVersions([
    version(1, {
      videoResolution: '1080',
      width: 1920,
      height: 1080,
      bitrate: 20_000,
    }),
    version(2, {
      videoResolution: '4k',
      width: 3840,
      height: 2160,
      bitrate: 10_000,
    }),
  ]);

  assertEquals(recommendation?.confidence, 'review');
});

Deno.test('smart analysis leaves cross-container matches unselected for review', () => {
  assertEquals(
    analyzeSmartDuplicateVersions([
      version(1, { container: 'mkv' }),
      version(2, { container: 'mp4' }),
    ])?.confidence,
    'review',
  );
});

Deno.test('smart analysis protects unique audio and incomplete stream data', () => {
  assertEquals(
    analyzeSmartDuplicateVersions([
      version(1),
      version(2, {
        audioStreams: [{
          codec: 'truehd',
          language: 'eng',
          channels: 8,
          channelLayout: '7.1',
          title: null,
          forced: false,
          default: true,
        }],
      }),
    ]),
    null,
  );
  assertEquals(
    analyzeSmartDuplicateVersions([
      version(1),
      version(2, {
        audioStreams: [{
          codec: 'aac',
          language: 'spa',
          channels: 2,
          channelLayout: 'stereo',
          title: null,
          forced: false,
          default: true,
        }],
      }),
    ]),
    null,
  );
  assertEquals(
    analyzeSmartDuplicateVersions([
      version(1),
      version(2, { streamDetailsAvailable: false }),
    ]),
    null,
  );
});

Deno.test('smart analysis accepts overlapping subtitle coverage as near-identical', () => {
  const english = {
    codec: 'srt',
    language: 'eng',
    channels: null,
    channelLayout: null,
    title: 'English',
    forced: false,
    default: true,
  };
  const spanish = {
    ...english,
    language: 'spa',
    title: 'Spanish',
    default: false,
  };
  const recommendation = analyzeSmartDuplicateVersions([
    version(1, { subtitleStreams: [english] }),
    version(2, { subtitleStreams: [english, spanish], bitrate: 10_500 }),
  ]);

  assertEquals(recommendation?.confidence, 'near-identical');
  assertEquals(recommendation?.keepMediaId, 2);
  assertEquals(
    recommendation?.reasons[0],
    'Matching runtime, video, HDR, and audio with overlapping subtitle coverage',
  );
  assertEquals(
    recommendation?.reasons[1],
    'Some subtitle tracks differ; shared language coverage remains',
  );
});

Deno.test('smart analysis protects disjoint subtitle coverage', () => {
  const subtitle = (language: string) => ({
    codec: 'srt',
    language,
    channels: null,
    channelLayout: null,
    title: null,
    forced: false,
    default: true,
  });

  assertEquals(
    analyzeSmartDuplicateVersions([
      version(1, { subtitleStreams: [subtitle('eng')] }),
      version(2, { subtitleStreams: [subtitle('spa')] }),
    ]),
    null,
  );
});

Deno.test('smart cleanup accepts a different version to keep but never every version', () => {
  const versions = [version(1), version(2), version(3)];
  const candidate: SmartDuplicateCandidate = {
    mediaType: 'movie',
    libraryKey: 'movies',
    ratingKey: '10',
    title: 'Movie',
    context: null,
    confidence: 'obvious',
    keepMediaId: 3,
    deleteMediaIds: [1, 2],
    reclaimableSize: 10_000,
    reasons: [],
    versions,
  };

  assertEquals(isValidSmartCleanupSelection(candidate, [1, 2]), true);
  assertEquals(isValidSmartCleanupSelection(candidate, [2, 3]), true);
  assertEquals(isValidSmartCleanupSelection(candidate, [1, 2, 3]), false);
  assertEquals(isValidSmartCleanupSelection(candidate, [1]), false);
  assertEquals(isValidSmartCleanupSelection(candidate, [1, 99]), false);
  assertEquals(isValidSmartCleanupSelection(candidate, [1, 1]), false);

  assertEquals(isValidManualSeasonCleanupSelection(candidate, [1]), true);
  assertEquals(isValidManualSeasonCleanupSelection(candidate, [1, 2]), true);
  assertEquals(isValidManualSeasonCleanupSelection(candidate, [1, 2, 3]), false);
  assertEquals(isValidManualSeasonCleanupSelection(candidate, [99]), false);
  assertEquals(isValidManualSeasonCleanupSelection(candidate, [1, 1]), false);
});

Deno.test('smart cleanup caps an automatic pass and prioritizes actionable candidates', () => {
  const candidates = Array.from(
    { length: SMART_CLEANUP_GROUP_LIMIT },
    (_, index): SmartDuplicateCandidate => ({
      mediaType: 'movie',
      libraryKey: 'movies',
      ratingKey: String(index),
      title: `Movie ${index}`,
      context: null,
      confidence: 'obvious',
      keepMediaId: 2,
      deleteMediaIds: [1],
      reclaimableSize: index,
      reasons: [],
      versions: [version(1), version(2)],
    }),
  );
  candidates.push({
    ...candidates[0]!,
    ratingKey: 'manual-review',
    confidence: 'review',
    reclaimableSize: Number.MAX_SAFE_INTEGER,
  });

  const limited = limitSmartDuplicateCandidates(candidates);

  assertEquals(limited.length, SMART_CLEANUP_GROUP_LIMIT);
  assertEquals(limited.some((candidate) => candidate.ratingKey === 'manual-review'), false);
});
