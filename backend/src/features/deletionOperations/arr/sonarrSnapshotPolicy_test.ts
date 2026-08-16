import { assertEquals } from '@std/assert';
import {
  findAuthorizedSonarrCandidate,
  sonarrInventoryHasOnlyAuthorizedCandidates,
  type SonarrRescanAuthorizedChange,
  sonarrRescanHasOnlyAuthorizedChange,
  sonarrRescanHasOnlyAuthorizedChanges,
} from './sonarrSnapshotPolicy.ts';

const before = {
  episodes: [
    {
      id: 9,
      seriesId: 8,
      seasonNumber: 1,
      episodeNumber: 1,
      episodeFileId: 0,
      monitored: false,
    },
    {
      id: 11,
      seriesId: 8,
      seasonNumber: 1,
      episodeNumber: 2,
      episodeFileId: 12,
      monitored: false,
    },
  ],
  files: [{
    id: 12,
    seriesId: 8,
    path: '/tv/Show/Season 01/episode-2-old.mkv',
    relativePath: 'Season 01/episode-2-old.mkv',
    size: 50_000,
    episodeIds: [11],
  }],
};

const authorized: SonarrRescanAuthorizedChange[] = [
  {
    targetId: 1,
    episodeId: 9,
    oldFileId: 0,
    candidates: [{
      mediaId: 22,
      path: '/tv/Show/Season 01/episode-1-new.mkv',
      size: 40_000,
    }],
  },
  {
    targetId: 2,
    episodeId: 11,
    oldFileId: 12,
    restoredMonitored: true,
    candidates: [{
      mediaId: 32,
      path: '/tv/Show/Season 01/episode-2-new.mkv',
      size: 60_000,
    }],
  },
];

const after = {
  episodes: [
    { ...before.episodes[0]!, episodeFileId: 20 },
    { ...before.episodes[1]!, episodeFileId: 21, monitored: true },
  ],
  files: [
    {
      id: 20,
      seriesId: 8,
      path: '/tv/Show/Season 01/episode-1-new.mkv',
      relativePath: 'Season 01/episode-1-new.mkv',
      size: 40_000,
      episodeIds: [9],
    },
    {
      id: 21,
      seriesId: 8,
      path: '/tv/Show/Season 01/episode-2-new.mkv',
      relativePath: 'Season 01/episode-2-new.mkv',
      size: 60_000,
      episodeIds: [11],
    },
  ],
};

Deno.test('Sonarr rescan reconciliation detects collateral without target adoption', () => {
  assertEquals(sonarrRescanHasOnlyAuthorizedChange(before, before, 9, null), true);
  assertEquals(
    sonarrRescanHasOnlyAuthorizedChange(
      before,
      {
        episodes: before.episodes.map((episode) =>
          episode.id === 11 ? { ...episode, episodeFileId: 13 } : episode
        ),
        files: [{ ...before.files[0]!, id: 13 }],
      },
      9,
      null,
    ),
    false,
  );
});

Deno.test('Sonarr rescan reconciliation permits every authorized season target only', () => {
  assertEquals(sonarrRescanHasOnlyAuthorizedChanges(before, after, authorized), true);
  assertEquals(
    sonarrRescanHasOnlyAuthorizedChanges(before, {
      ...after,
      files: after.files.map((file) =>
        file.id === 21 ? { ...file, path: '/tv/Show/Season 01/unreviewed.mkv' } : file
      ),
    }, authorized),
    false,
  );
});

Deno.test('Sonarr candidate and inventory policy use the exact normalized allowlist', () => {
  assertEquals(findAuthorizedSonarrCandidate(after.files[0]!, authorized[0]!.candidates), {
    mediaId: 22,
    path: '/tv/Show/Season 01/episode-1-new.mkv',
    size: 40_000,
  });
  const candidate = {
    path: '/tv/Show/Season 01/episode-1-new.mkv',
    size: 40_000,
    seriesId: 8,
    seasonNumber: 1,
    episodeIds: [9],
    rejectionReasons: [],
  };
  assertEquals(sonarrInventoryHasOnlyAuthorizedCandidates([candidate], authorized), true);
  assertEquals(
    sonarrInventoryHasOnlyAuthorizedCandidates([
      { ...candidate, path: '/tv/Show/Season 01/unreviewed.mkv' },
    ], authorized),
    false,
  );
  assertEquals(
    sonarrInventoryHasOnlyAuthorizedCandidates([
      { ...candidate, path: '/tv/Show/Season 01/unreviewed.mkv', rejectionReasons: ['rejected'] },
    ], authorized),
    true,
  );
});
