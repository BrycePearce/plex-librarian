import { assertEquals } from '@std/assert';
import {
  classifyRelocationLifecycle,
  type RelocationLifecycleEvidence,
  type RelocationLifecycleRow,
} from './relocation.ts';
import {
  createRelocationGuidance,
  RELOCATION_SUPERSEDED_REASON,
  relocationManualReason,
} from './relocationModel.ts';

const mappingIdentity = '{"addImportExclusion":true,"pathMappings":[]}';
const guidance = createRelocationGuidance({
  service: 'radarr',
  mediaType: 'movie',
  reason: 'retained_parent_mismatch',
  selectedMediaId: 11,
  selectedPlexPath: '/movies/Movie/selected.mkv',
  selectedArrPath: '/movies/Movie/selected.mkv',
  retainedMediaId: 12,
  retainedPlexPath: '/movies/retained.mkv',
  retainedFileSize: 50_000,
  managedDirectoryPath: '/movies/Movie',
  sourceArrPath: '/movies/retained.mkv',
  destinationArrPath: '/movies/Movie/retained.mkv',
  destinationPlexPath: '/movies/Movie/retained.mkv',
  arrInstanceId: 1,
  arrInstanceName: 'Radarr',
  arrRecordId: 7,
  arrManagedFileId: 8,
  mappingIdentity,
}, 100);

const snapshot = {
  type: 'movie',
  mediaId: 11,
  ratingKey: 'movie',
  selectedMediaIds: [11],
  operationMediaIds: [11],
  arrReassignmentMappings: [{
    instanceId: 1,
    instanceType: 'radarr',
    mappingIdentity,
  }],
  relocationGuidance: guidance,
};

function row(overrides: Partial<RelocationLifecycleRow> = {}): RelocationLifecycleRow {
  return {
    targetId: 1,
    operationId: 'operation',
    serverId: 1,
    targetKind: 'movie_version',
    targetKey: 'movie:11',
    status: 'needs_attention',
    phase: 'validating',
    plexAttemptCount: 0,
    removalConfirmedAt: null,
    error: relocationManualReason(guidance),
    snapshot,
    ...overrides,
  };
}

function evidence(
  overrides: Partial<RelocationLifecycleEvidence> = {},
): RelocationLifecycleEvidence {
  return {
    removalEvidencePresent: false,
    reservations: [[1, 'movie', 11, 'movie', 'operation', 1]],
    ...overrides,
  };
}

Deno.test('lifecycle classifier accepts only the untouched active placement', () => {
  assertEquals(classifyRelocationLifecycle(row(), evidence()).placement, 'active');
  for (
    const [changedRow, changedEvidence] of [
      [row({ status: 'running' }), evidence()],
      [row({ phase: 'arr_coordination' }), evidence()],
      [row({ plexAttemptCount: 1 }), evidence()],
      [row({ removalConfirmedAt: 101 }), evidence()],
      [row({ snapshot: { ...snapshot, arrReassignments: [{}] } }), evidence()],
      [row({ snapshot: { ...snapshot, arrReassignments: 'invalid' } }), evidence()],
      [row(), evidence({ removalEvidencePresent: true })],
      [row(), evidence({ reservations: [] })],
      [row(), evidence({ reservations: [[1, 'movie', 99, 'movie', 'operation', 1]] })],
      [row(), evidence({ reservations: [[2, 'movie', 11, 'movie', 'operation', 1]] })],
      [row(), evidence({ reservations: [[1, 'episode', 11, 'movie', 'operation', 1]] })],
      [row(), evidence({ reservations: [[1, 'movie', 11, 'other', 'operation', 1]] })],
    ] as const
  ) {
    const result = classifyRelocationLifecycle(changedRow, changedEvidence);
    assertEquals(result.placement, 'invalid');
    assertEquals(result.guidanceState, 'invalid');
  }
});

Deno.test('lifecycle classifier correlates barriers only to an untouched supersede', () => {
  const barrier = { guidanceId: guidance.guidanceId, supersededAt: 101 };
  const superseded = row({
    status: 'cancelled',
    error: RELOCATION_SUPERSEDED_REASON,
    snapshot: { ...snapshot, relocationSyncBarrier: barrier },
  });
  const result = classifyRelocationLifecycle(superseded, evidence({ reservations: [] }));
  assertEquals(result.placement, 'superseded');
  assertEquals(result.guidanceState, 'valid');
  assertEquals(result.barrierState, 'incomplete');

  for (
    const changed of [
      row({ ...superseded, status: 'needs_attention' }),
      row({ ...superseded, error: 'different reason' }),
      row({ ...superseded, phase: 'arr_coordination' }),
      row({ ...superseded, plexAttemptCount: 1 }),
      row({ ...superseded, removalConfirmedAt: 101 }),
      row({
        ...superseded,
        snapshot: { ...superseded.snapshot, arrReassignments: [{}] },
      }),
      row({
        ...superseded,
        snapshot: { ...snapshot, relocationSyncBarrier: { ...barrier, supersededAt: 99 } },
      }),
    ]
  ) {
    assertEquals(
      classifyRelocationLifecycle(changed, evidence({ reservations: [] })).barrierState,
      'invalid',
    );
  }

  assertEquals(
    classifyRelocationLifecycle(superseded, evidence({ removalEvidencePresent: true }))
      .barrierState,
    'invalid',
  );
  assertEquals(
    classifyRelocationLifecycle(superseded, evidence()).barrierState,
    'invalid',
  );
});
