import { assertEquals } from '@std/assert';
import {
  requestAvailability,
  requestEvidenceChanged,
  requestSeasonNumbers,
  resolveAvailabilityObservation,
} from './availability.ts';

Deno.test('partial show is available when every requested season is available', () => {
  const result = requestAvailability({
    id: 1,
    is4k: false,
    seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }],
    media: {
      mediaType: 'tv',
      status: 4,
      seasons: [
        { seasonNumber: 1, status: 5, updatedAt: '2026-01-01T00:00:00Z' },
        { seasonNumber: 2, status: 5, updatedAt: '2026-01-03T00:00:00Z' },
        { seasonNumber: 3, status: 2, updatedAt: '2026-01-04T00:00:00Z' },
      ],
    },
  });
  assertEquals(result.available, true);
  assertEquals(result.updatedAt, 1_767_398_400);
  assertEquals(result.estimated, true);
});

Deno.test('requested TV scope remains unavailable while one requested season is not available', () => {
  const result = requestAvailability({
    id: 1,
    seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }],
    media: {
      mediaType: 'tv',
      status: 4,
      seasons: [
        { seasonNumber: 1, status: 5 },
        { seasonNumber: 2, status: 3 },
      ],
    },
  });
  assertEquals(result.available, false);
});

Deno.test('requested TV scope remains unavailable when a season row is missing', () => {
  const result = requestAvailability({
    id: 1,
    seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }],
    media: {
      mediaType: 'tv',
      status: 5,
      seasons: [{ seasonNumber: 1, status: 5 }],
    },
  });
  assertEquals(result, { available: false, updatedAt: null, estimated: true });
});

Deno.test('requested TV scope remains unavailable when media seasons are absent', () => {
  const result = requestAvailability({
    id: 1,
    seasons: [{ seasonNumber: 3 }],
    media: { mediaType: 'tv', status: 5 },
  });
  assertEquals(result, { available: false, updatedAt: null, estimated: true });
});

Deno.test('a missing requested-season timestamp makes the availability date unknown', () => {
  const result = requestAvailability({
    id: 1,
    seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }],
    media: {
      mediaType: 'tv',
      seasons: [
        { seasonNumber: 1, status: 5, updatedAt: '2025-01-01T00:00:00Z' },
        { seasonNumber: 2, status: 5 },
      ],
    },
  });
  assertEquals(result, { available: true, updatedAt: null, estimated: true });
});

Deno.test('4K requests use 4K availability instead of normal availability', () => {
  const result = requestAvailability({
    id: 1,
    is4k: true,
    media: { mediaType: 'movie', status: 5, status4k: 3 },
  });
  assertEquals(result.available, false);
});

Deno.test('movies prefer Seerr mediaAddedAt as exact availability evidence', () => {
  assertEquals(
    requestAvailability({
      id: 1,
      media: {
        mediaType: 'movie',
        status: 5,
        mediaAddedAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-06-01T00:00:00Z',
      },
    }),
    { available: true, updatedAt: 1_767_225_600, estimated: false },
  );
});

Deno.test('completed movies retain exact availability after Seerr marks media deleted', () => {
  assertEquals(
    requestAvailability({
      id: 1,
      status: 5,
      media: {
        mediaType: 'movie',
        status: 7,
        mediaAddedAt: '2025-01-01T00:00:00Z',
        updatedAt: '2026-06-01T00:00:00Z',
      },
    }),
    { available: true, updatedAt: 1_735_689_600, estimated: false },
  );
});

Deno.test('4K requests do not borrow the standard copy mediaAddedAt timestamp', () => {
  assertEquals(
    requestAvailability({
      id: 1,
      is4k: true,
      media: {
        mediaType: 'movie',
        status4k: 5,
        mediaAddedAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-06-01T00:00:00Z',
      },
    }),
    { available: true, updatedAt: 1_780_272_000, estimated: true },
  );
});

Deno.test('season zero remains part of requested TV scope', () => {
  const record = {
    id: 1,
    seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }],
    media: {
      mediaType: 'tv',
      status: 5,
      seasons: [
        { seasonNumber: 0, status: 3 },
        { seasonNumber: 1, status: 5 },
      ],
    },
  };
  assertEquals(requestSeasonNumbers(record), [0, 1]);
  assertEquals(requestAvailability(record).available, false);
});

Deno.test('availability stages observations for successful-sync promotion', () => {
  const first = resolveAvailabilityObservation(
    {
      availableAt: null,
      observedAt: null,
      observedSyncAt: null,
      observationFromSuccessfulSync: false,
      estimated: false,
    },
    { available: true, updatedAt: 1_700_000_000, estimated: true },
    1,
    2,
    false,
  );
  assertEquals(first, {
    availableAt: null,
    observedAt: 1_700_000_000,
    observedSyncAt: 2,
    estimated: true,
  });
  assertEquals(
    resolveAvailabilityObservation(
      { ...first, observationFromSuccessfulSync: true },
      { available: true, updatedAt: 1_700_000_100, estimated: true },
      1,
      3,
      false,
    ),
    first,
  );
});

Deno.test('an unavailable sync clears an unconfirmed availability observation', () => {
  assertEquals(
    resolveAvailabilityObservation(
      {
        availableAt: null,
        observedAt: 1_700_000_000,
        observedSyncAt: 1,
        observationFromSuccessfulSync: true,
        estimated: true,
      },
      { available: false, updatedAt: null, estimated: true },
      1,
      2,
      false,
    ),
    { availableAt: null, observedAt: null, observedSyncAt: null, estimated: false },
  );
});

Deno.test('completed requests confirm immediately and confirmed availability survives deletion', () => {
  const completed = resolveAvailabilityObservation(
    {
      availableAt: null,
      observedAt: null,
      observedSyncAt: null,
      observationFromSuccessfulSync: false,
      estimated: false,
    },
    { available: true, updatedAt: 1_700_000_000, estimated: true },
    1,
    2,
    true,
  );
  assertEquals(completed, {
    availableAt: 1_700_000_000,
    observedAt: null,
    observedSyncAt: null,
    estimated: true,
  });
  assertEquals(
    resolveAvailabilityObservation(
      { ...completed, observationFromSuccessfulSync: true },
      { available: false, updatedAt: null, estimated: true },
      1,
      3,
      false,
    ),
    completed,
  );
});

Deno.test('an observation written by a failed sync cannot confirm availability', () => {
  assertEquals(
    resolveAvailabilityObservation(
      {
        availableAt: null,
        observedAt: 1_700_000_000,
        observedSyncAt: 1_699_999_999,
        observationFromSuccessfulSync: false,
        estimated: true,
      },
      { available: true, updatedAt: 1_700_000_100, estimated: true },
      1,
      1_700_000_200,
      false,
    ),
    {
      availableAt: null,
      observedAt: 1_700_000_100,
      observedSyncAt: 1_700_000_200,
      estimated: true,
    },
  );
});

Deno.test('changed request evidence discards confirmed and pending availability', () => {
  assertEquals(
    resolveAvailabilityObservation(
      {
        availableAt: 1_700_000_000,
        observedAt: null,
        observedSyncAt: null,
        observationFromSuccessfulSync: true,
        estimated: true,
      },
      { available: false, updatedAt: null, estimated: true },
      1,
      1_800_000_000,
      false,
      true,
    ),
    { availableAt: null, observedAt: null, observedSyncAt: null, estimated: false },
  );
  assertEquals(
    requestEvidenceChanged(
      { mediaType: 'tv', seasonNumbers: [1] },
      { mediaType: 'tv', seasonNumbers: [1, 2] },
    ),
    true,
  );
});

Deno.test('a later exact timestamp cannot move confirmed history to a reappearance', () => {
  assertEquals(
    resolveAvailabilityObservation(
      {
        availableAt: 1_700_000_000,
        observedAt: null,
        observedSyncAt: null,
        observationFromSuccessfulSync: true,
        estimated: true,
      },
      { available: true, updatedAt: 1_800_000_000, estimated: false },
      1,
      1_800_000_100,
      false,
    ),
    {
      availableAt: 1_700_000_000,
      observedAt: null,
      observedSyncAt: null,
      estimated: true,
    },
  );
});

Deno.test('changed exact evidence restarts a pending availability observation', () => {
  assertEquals(
    resolveAvailabilityObservation(
      {
        availableAt: null,
        observedAt: 1_700_000_000,
        observedSyncAt: 1_700_000_100,
        observationFromSuccessfulSync: true,
        estimated: false,
      },
      { available: true, updatedAt: 1_800_000_000, estimated: false },
      1,
      1_800_000_100,
      false,
    ),
    {
      availableAt: null,
      observedAt: 1_800_000_000,
      observedSyncAt: 1_800_000_100,
      estimated: false,
    },
  );
});

Deno.test('completed requests confirm current exact evidence instead of a pending predecessor', () => {
  assertEquals(
    resolveAvailabilityObservation(
      {
        availableAt: null,
        observedAt: 1_700_000_000,
        observedSyncAt: 1_700_000_100,
        observationFromSuccessfulSync: true,
        estimated: false,
      },
      { available: true, updatedAt: 1_800_000_000, estimated: false },
      1,
      1_800_000_100,
      true,
    ),
    {
      availableAt: 1_800_000_000,
      observedAt: null,
      observedSyncAt: null,
      estimated: false,
    },
  );
});
