import { assertEquals, assertThrows } from '@std/assert';
import {
  canonicalSeasonDeletionIntent,
  parseSeasonDeletionRequest,
  seasonCleanupConflictDetails,
  SeasonCleanupRequestError,
} from './seasonCleanupRoute.ts';
import { DeletionConflictError } from '../deletionOperations/service.ts';

const fingerprint = 'a'.repeat(64);

Deno.test('season cleanup canonicalizes equivalent destructive intent', () => {
  const parsed = parseSeasonDeletionRequest('season-1', {
    clientRequestId: 'request-1',
    previewFingerprint: fingerprint,
    selections: [
      { episodeRatingKey: 'episode-2', mediaIds: [22, 21] },
      { episodeRatingKey: 'episode-1', mediaIds: [12, 11] },
    ],
    coordinateSonarr: true,
    cleanupDownloads: false,
  }, true);
  assertEquals(canonicalSeasonDeletionIntent(parsed), {
    seasonRatingKey: 'season-1',
    selections: [
      { episodeRatingKey: 'episode-1', mediaIds: [11, 12] },
      { episodeRatingKey: 'episode-2', mediaIds: [21, 22] },
    ],
    coordinateSonarr: true,
    cleanupDownloads: false,
  });
});

Deno.test('preview and cleanup share strict selection and destination parsing', () => {
  const intent = {
    selections: [{ episodeRatingKey: 'episode-1', mediaIds: [11] }],
    coordinateSonarr: false,
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
});

Deno.test('season cleanup rejects duplicate identities and generic smart-cleanup fields', () => {
  const base = {
    clientRequestId: 'request-1',
    previewFingerprint: fingerprint,
    coordinateSonarr: false,
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
    coordinateSonarr: false,
    cleanupDownloads: false,
  };
  for (
    const body of [
      { ...base, selections: [{ episodeRatingKey: ' episode-1', mediaIds: [11] }] },
      { ...base, coordinateSonarr: 'false' },
      { ...base, previewFingerprint: fingerprint.toUpperCase() },
      { ...base, cleanupDownloads: true },
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
