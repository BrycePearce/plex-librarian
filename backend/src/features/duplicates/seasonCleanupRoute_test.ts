import { assertEquals, assertThrows } from '@std/assert';
import {
  canonicalSeasonDeletionIntent,
  parseSeasonDeletionRequest,
  seasonCleanupConflictDetails,
  SeasonCleanupRequestError,
} from './seasonCleanupRoute.ts';
import { DeletionConflictError } from '../deletionOperations/service.ts';
import {
  downloadCleanupEvidenceAgrees,
  managedEpisodesNeedBreakGlass,
  seasonDownloadJobAssignments,
} from './seasonDeletionPlanner.ts';
import type { ResolvedCleanupItem } from '../mediaDeletion/cleanup.ts';

const fingerprint = 'a'.repeat(64);

function cleanupEvidence(paths: string[]): ResolvedCleanupItem {
  return {
    status: 'resolved',
    downloadJobs: [{
      instanceKey: 'db:1',
      jobId: 'hash',
      authorizedSourcePaths: paths,
    }],
  } as unknown as ResolvedCleanupItem;
}

Deno.test('Arr and direct cleanup evidence must authorize the same payload', () => {
  assertEquals(
    downloadCleanupEvidenceAgrees(
      cleanupEvidence(['/downloads/a.mkv']),
      cleanupEvidence(['/downloads/a.mkv']),
    ),
    true,
  );
  assertEquals(
    downloadCleanupEvidenceAgrees(
      cleanupEvidence(['/downloads/a.mkv']),
      cleanupEvidence(['/downloads/a.mkv', '/downloads/b.mkv']),
    ),
    false,
  );
});

Deno.test('season download jobs have one deterministic durable owner', () => {
  const entries = [
    { episodeRatingKey: 'episode-z', episodeNumber: 1, mediaId: 11, path: '/shows/e1.mkv' },
    { episodeRatingKey: 'episode-a', episodeNumber: 2, mediaId: 21, path: '/shows/e2.mkv' },
  ];
  assertEquals(
    seasonDownloadJobAssignments(entries, [
      { downloadId: 'single', importedPath: '/shows/e1.mkv' },
      { downloadId: 'pack', importedPath: '/shows/e1.mkv' },
      { downloadId: 'pack', importedPath: '/shows/e2.mkv' },
    ], false),
    {
      owners: new Map([['single', 'episode-z:11']]),
      coveredTargetKeys: new Set(['episode-z:11']),
    },
  );
  assertEquals(
    seasonDownloadJobAssignments(entries, [
      { downloadId: 'pack', importedPath: '/shows/e1.mkv' },
      { downloadId: 'pack', importedPath: '/shows/e2.mkv' },
    ], true),
    {
      owners: new Map([['pack', 'episode-z:11']]),
      coveredTargetKeys: new Set(['episode-z:11', 'episode-a:21']),
    },
  );
});

Deno.test('shared download jobs use the same ordering as durable season targets', () => {
  const entries = [
    {
      episodeRatingKey: 'episode-1',
      episodeNumber: 1,
      mediaId: 10,
      path: '/shows/managed.mkv',
      automaticAdoption: true,
    },
    {
      episodeRatingKey: 'episode-1',
      episodeNumber: 1,
      mediaId: 20,
      path: '/shows/plex-only.mkv',
      automaticAdoption: false,
    },
  ];
  assertEquals(
    seasonDownloadJobAssignments(entries, [
      { downloadId: 'pack', importedPath: '/shows/managed.mkv' },
      { downloadId: 'pack', importedPath: '/shows/plex-only.mkv' },
    ], true).owners,
    new Map([['pack', 'episode-1:20']]),
  );
});

Deno.test('break-glass is offered when any managed episode is unadoptable', () => {
  assertEquals(
    managedEpisodesNeedBreakGlass(new Set(['episode-1']), new Set()),
    true,
  );
  assertEquals(
    managedEpisodesNeedBreakGlass(
      new Set(['episode-1', 'episode-2']),
      new Set(['episode-2']),
    ),
    true,
  );
  assertEquals(
    managedEpisodesNeedBreakGlass(
      new Set(['episode-1', 'episode-2']),
      new Set(['episode-1', 'episode-2']),
    ),
    false,
  );
  assertEquals(managedEpisodesNeedBreakGlass(new Set(), new Set()), false);
});

Deno.test('season cleanup canonicalizes equivalent destructive intent', () => {
  const parsed = parseSeasonDeletionRequest('season-1', {
    clientRequestId: 'request-1',
    previewFingerprint: fingerprint,
    selections: [
      { episodeRatingKey: 'episode-2', mediaIds: [22, 21] },
      { episodeRatingKey: 'episode-1', mediaIds: [12, 11] },
    ],
    sonarrMode: 'adopt_retained',
    cleanupDownloads: false,
  }, true);
  assertEquals(canonicalSeasonDeletionIntent(parsed), {
    seasonRatingKey: 'season-1',
    selections: [
      { episodeRatingKey: 'episode-1', mediaIds: [11, 12] },
      { episodeRatingKey: 'episode-2', mediaIds: [21, 22] },
    ],
    sonarrMode: 'adopt_retained',
    cleanupDownloads: false,
  });
});

Deno.test('preview and cleanup share strict selection and destination parsing', () => {
  const intent = {
    selections: [{ episodeRatingKey: 'episode-1', mediaIds: [11] }],
    sonarrMode: 'none' as const,
    cleanupDownloads: false,
  };
  assertEquals(parseSeasonDeletionRequest('season-1', intent, false).selections, intent.selections);
  assertEquals(
    parseSeasonDeletionRequest('season-1', {
      ...intent,
      clientRequestId: 'request-1',
      previewFingerprint: fingerprint,
    }, true).selections,
    intent.selections,
  );
  assertEquals(
    parseSeasonDeletionRequest('season-1', {
      ...intent,
      cleanupDownloads: true,
    }, false).cleanupDownloads,
    true,
  );
});

Deno.test('season cleanup rejects duplicate identities and generic smart-cleanup fields', () => {
  const base = {
    clientRequestId: 'request-1',
    previewFingerprint: fingerprint,
    sonarrMode: 'none',
    cleanupDownloads: false,
  };
  for (
    const body of [
      {
        ...base,
        selections: [
          { episodeRatingKey: 'episode-1', mediaIds: [11] },
          { episodeRatingKey: 'episode-1', mediaIds: [12] },
        ],
      },
      { ...base, selections: [{ episodeRatingKey: 'episode-1', mediaIds: [11, 11] }] },
      {
        ...base,
        selections: [{ episodeRatingKey: 'episode-1', mediaIds: [11] }],
        manualSeasonReview: true,
      },
    ]
  ) {
    assertThrows(
      () => parseSeasonDeletionRequest('season-1', body, true),
      SeasonCleanupRequestError,
    );
  }
});

Deno.test('season cleanup requires exact identifiers, booleans, and fingerprint shape', () => {
  const base = {
    clientRequestId: 'request-1',
    previewFingerprint: fingerprint,
    selections: [{ episodeRatingKey: 'episode-1', mediaIds: [11] }],
    sonarrMode: 'none',
    cleanupDownloads: false,
  };
  for (
    const body of [
      { ...base, selections: [{ episodeRatingKey: ' episode-1', mediaIds: [11] }] },
      { ...base, sonarrMode: 'invalid' },
      { ...base, previewFingerprint: fingerprint.toUpperCase() },
    ]
  ) {
    assertThrows(
      () => parseSeasonDeletionRequest('season-1', body, true),
      SeasonCleanupRequestError,
    );
  }
});

Deno.test('season cleanup exposes recovery codes only for actionable conflicts', () => {
  assertEquals(
    seasonCleanupConflictDetails(
      new DeletionConflictError('clientRequestId was already used with a different request'),
    ),
    { code: 'REQUEST_ID_CONFLICT' },
  );
  assertEquals(
    seasonCleanupConflictDetails(
      new DeletionConflictError(
        'this library already has an active deletion operation',
        409,
        'op-1',
      ),
    ),
    { code: 'DELETION_CONFLICT', operationId: 'op-1' },
  );
  assertEquals(
    seasonCleanupConflictDetails(
      new DeletionConflictError('the accepted Arr mapping configuration changed'),
    ),
    {},
  );
});
