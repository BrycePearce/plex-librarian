import { assert, assertEquals, assertThrows } from '@std/assert';
import {
  createRelocationGuidance,
  deriveRelocationNamespace,
  type RadarrMovieRelocationCandidate,
  relocationManualReason,
  validateRelocationBarrier,
  validateRelocationGuidance,
  workflowKeyPresent,
} from './relocationModel.ts';

const identity = '{"addImportExclusion":true,"pathMappings":[]}';
const candidate: RadarrMovieRelocationCandidate = {
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
  mappingIdentity: identity,
};

function target(overrides: Record<string, unknown> = {}) {
  return {
    targetKind: 'movie_version' as const,
    type: 'movie',
    mediaId: 11,
    selectedMediaIds: [11],
    operationMediaIds: [11],
    arrReassignmentMappings: [{
      instanceId: 1,
      instanceType: 'radarr',
      instanceUrl: 'http://radarr',
      configurationUpdatedAt: 1,
      mappingIdentity: identity,
    }],
    ...overrides,
  };
}

Deno.test('version-one Radarr relocation guidance is exact and target-bound', () => {
  const guidance = createRelocationGuidance(candidate, 100);
  assert(validateRelocationGuidance(guidance, target()));
  assertEquals(guidance.schemaVersion, 1);
  assertEquals(
    relocationManualReason(guidance),
    'Radarr can adopt the retained version only after the guided manual relocation',
  );
  assertEquals(guidance.destinationPlexPath, '/movies/Movie/retained.mkv');
  for (
    const mutation of [
      { ...guidance, extra: true },
      { ...guidance, schemaVersion: 2 },
      { ...guidance, service: 'sonarr' },
      { ...guidance, guidanceId: 'not-a-uuid' },
      { ...guidance, retainedFileSize: 0 },
      { ...guidance, destinationArrPath: '/movies/Other/retained.mkv' },
      { ...guidance, destinationPlexPath: '/movies/retained.mkv' },
      { ...guidance, selectedArrPath: '/movies/selected.mkv' },
      { ...guidance, mappingIdentity: '{"pathMappings":[]}' },
    ]
  ) assertEquals(validateRelocationGuidance(mutation, target()), null);
  assertEquals(
    validateRelocationGuidance({
      guidanceId: guidance.guidanceId,
      reason: guidance.reason,
      radarrMovieFolder: '/movies/Movie',
    }, target()),
    null,
  );
  assertEquals(validateRelocationGuidance(guidance, target({ mediaId: 99 })), null);
  assertEquals(validateRelocationGuidance(guidance, target({ selectedMediaIds: null })), null);
  assertEquals(validateRelocationGuidance(guidance, target({ operationMediaIds: [11, 12] })), null);
  assertEquals(validateRelocationGuidance(guidance, target({ arrReassignmentMappings: [] })), null);
  assertEquals(
    validateRelocationGuidance(
      guidance,
      target({
        expectedRetainedVersion: { mediaId: 12, fileSize: null },
      }),
    )?.retainedMediaId,
    12,
  );
  assertEquals(
    validateRelocationGuidance(
      guidance,
      target({
        expectedRetainedVersion: { mediaId: 12, fileSize: 1 },
      }),
    ),
    null,
  );

  const { observedAt: _observedAt, ...missingObservedAt } = guidance;
  for (
    const mutation of [
      missingObservedAt,
      { ...guidance, workflow: 'different' },
      { ...guidance, mediaType: 'episode' },
      { ...guidance, reason: 'different' },
      { ...guidance, selectedMediaId: 0 },
      { ...guidance, retainedMediaId: Number.MAX_SAFE_INTEGER + 1 },
      { ...guidance, arrInstanceId: -1 },
      { ...guidance, arrRecordId: 1.5 },
      { ...guidance, arrManagedFileId: 0 },
      { ...guidance, observedAt: Number.POSITIVE_INFINITY },
      { ...guidance, selectedPlexPath: 'relative/movie.mkv' },
      { ...guidance, destinationPlexPath: '/movies//Movie/retained.mkv' },
    ]
  ) assertEquals(validateRelocationGuidance(mutation, target()), null);
});

Deno.test('candidate conversion canonicalizes Arr paths and preserves Plex source evidence', () => {
  const guidance = createRelocationGuidance({
    ...candidate,
    selectedPlexPath: '/movies//Movie/./selected.mkv',
    retainedPlexPath: '/movies//retained.mkv',
    selectedArrPath: '/movies//Movie/./selected.mkv',
    managedDirectoryPath: '/movies//Movie/',
    sourceArrPath: '/movies//retained.mkv',
    destinationArrPath: '/movies//Movie/retained.mkv',
    destinationPlexPath: '/movies//Movie/retained.mkv',
  }, 100);
  assertEquals(guidance.selectedPlexPath, '/movies//Movie/./selected.mkv');
  assertEquals(guidance.retainedPlexPath, '/movies//retained.mkv');
  assertEquals(guidance.selectedArrPath, '/movies/Movie/selected.mkv');
  assertEquals(guidance.destinationPlexPath, '/movies/Movie/retained.mkv');
  assert(validateRelocationGuidance(guidance, target()));
  assertEquals(
    validateRelocationGuidance({
      ...guidance,
      destinationArrPath: '/movies//Movie/retained.mkv',
    }, target()),
    null,
  );
});

Deno.test('candidate conversion supports Windows cross-drive and UNC path roles', () => {
  for (
    const paths of [
      {
        selectedPlexPath: 'c:\\Movies\\Movie\\selected.mkv',
        selectedArrPath: 'c:\\Movies\\Movie\\selected.mkv',
        retainedPlexPath: 'd:\\Archive\\retained.mkv',
        sourceArrPath: 'd:\\Archive\\retained.mkv',
        managedDirectoryPath: 'c:\\Movies\\Movie',
        destinationArrPath: 'c:\\Movies\\Movie\\retained.mkv',
        destinationPlexPath: 'c:\\Movies\\Movie\\retained.mkv',
      },
      {
        selectedPlexPath: '\\\\server\\movies\\Movie\\selected.mkv',
        selectedArrPath: '\\\\server\\movies\\Movie\\selected.mkv',
        retainedPlexPath: '\\\\server\\archive\\retained.mkv',
        sourceArrPath: '\\\\server\\archive\\retained.mkv',
        managedDirectoryPath: '\\\\server\\movies\\Movie',
        destinationArrPath: '\\\\server\\movies\\Movie\\retained.mkv',
        destinationPlexPath: '\\\\server\\movies\\Movie\\retained.mkv',
      },
    ]
  ) {
    const guidance = createRelocationGuidance({ ...candidate, ...paths }, 100);
    assertEquals(
      guidance.selectedArrPath,
      guidance.selectedArrPath.startsWith('C:')
        ? 'C:\\Movies\\Movie\\selected.mkv'
        : '\\\\server\\movies\\Movie\\selected.mkv',
    );
    assert(validateRelocationGuidance(guidance, target()));
  }
});

Deno.test('candidate conversion truncates trusted instance names but validation never truncates', () => {
  const guidance = createRelocationGuidance(
    { ...candidate, arrInstanceName: 'R'.repeat(220) },
    100,
  );
  assertEquals(guidance.arrInstanceName.length, 200);
  assert(validateRelocationGuidance(guidance, target()));
  assertEquals(
    validateRelocationGuidance({ ...guidance, arrInstanceName: 'R'.repeat(201) }, target()),
    null,
  );
});

Deno.test('candidate conversion rejects incoherent namespace evidence before persistence', () => {
  assertThrows(() =>
    createRelocationGuidance({
      ...candidate,
      destinationPlexPath: '/unrelated/Movie/retained.mkv',
    }, 100)
  );
});

Deno.test('mapped destination derives from selected namespace provenance', () => {
  const mappingIdentity = JSON.stringify({
    addImportExclusion: true,
    pathMappings: [
      { kind: 'library', arrPath: '/movies', localPath: '/plex-movies' },
      { kind: 'library', arrPath: '/archive', localPath: '/plex-archive' },
    ],
  });
  assertEquals(
    deriveRelocationNamespace(
      mappingIdentity,
      '/plex-movies/Movie/selected.mkv',
      '/plex-archive/retained.mkv',
      '/movies/Movie/retained.mkv',
    ),
    {
      selectedArrPath: '/movies/Movie/selected.mkv',
      sourceArrPath: '/archive/retained.mkv',
      destinationPlexPath: '/plex-movies/Movie/retained.mkv',
    },
  );
});

Deno.test('mapping identity rejects malformed audit mappings even when authorization is valid', () => {
  const validLibraryMapping = {
    kind: 'library' as const,
    arrPath: '/movies',
    localPath: '/plex-movies',
  };
  for (
    const malformed of [
      { kind: 'download', arrPath: 'relative/downloads', localPath: '/downloads' },
      { kind: 'download', arrPath: '/downloads', localPath: 'relative/downloads' },
      { kind: 'library', arrPath: '../movies', localPath: '/unused' },
    ]
  ) {
    const mappingIdentity = JSON.stringify({
      addImportExclusion: true,
      pathMappings: [validLibraryMapping, malformed],
    });
    assertEquals(
      deriveRelocationNamespace(
        mappingIdentity,
        '/plex-movies/Movie/selected.mkv',
        '/plex-movies/retained.mkv',
        '/movies/Movie/retained.mkv',
      ),
      null,
    );
  }
});

Deno.test('mapping identity accepts absolute noncanonical roots as frozen configuration evidence', () => {
  const mappingIdentity = JSON.stringify({
    addImportExclusion: true,
    pathMappings: [{
      kind: 'library',
      arrPath: '/movies/',
      localPath: '/plex-movies/',
    }],
  });
  assertEquals(
    deriveRelocationNamespace(
      mappingIdentity,
      '/plex-movies/Movie/selected.mkv',
      '/plex-movies/retained.mkv',
      '/movies/Movie/retained.mkv',
    ),
    {
      selectedArrPath: '/movies/Movie/selected.mkv',
      sourceArrPath: '/movies/retained.mkv',
      destinationPlexPath: '/plex-movies/Movie/retained.mkv',
    },
  );
});

Deno.test('barriers are closed, positive, ordered, and correlated by callers', () => {
  const guidanceId = crypto.randomUUID();
  assertEquals(validateRelocationBarrier({ guidanceId, supersededAt: 10 }), {
    guidanceId,
    supersededAt: 10,
  });
  assertEquals(validateRelocationBarrier({ guidanceId, supersededAt: 10, syncId: 2 }), null);
  assertEquals(
    validateRelocationBarrier({
      guidanceId,
      supersededAt: 10,
      syncId: 2,
      finishedAt: 9,
    }),
    null,
  );
  assertEquals(validateRelocationBarrier({ guidanceId, supersededAt: 0 }), null);
  assertEquals(
    validateRelocationBarrier({ guidanceId, supersededAt: 10, unexpected: true }),
    null,
  );
  assertEquals(
    validateRelocationBarrier({
      guidanceId,
      supersededAt: 10,
      syncId: Number.NaN,
      finishedAt: 11,
    }),
    null,
  );
});

Deno.test('selection and accepted Arr evidence remain fail-closed', () => {
  const guidance = createRelocationGuidance(candidate, 100);
  for (
    const overrides of [
      { targetKind: 'episode_version' },
      { type: 'episode' },
      { selectedMediaIds: [11, 13] },
      { operationMediaIds: [] },
      { operationMediaIds: [11, 11] },
      {
        arrReassignmentMappings: [
          { instanceId: 1, instanceType: 'sonarr', mappingIdentity: identity },
        ],
      },
      {
        arrReassignmentMappings: [
          { instanceId: 1, instanceType: 'radarr', mappingIdentity: identity },
          { instanceId: 1, instanceType: 'radarr', mappingIdentity: identity },
        ],
      },
      { expectedRetainedVersion: { mediaId: 13, fileSize: 50_000 } },
    ]
  ) {
    assertEquals(validateRelocationGuidance(guidance, target(overrides)), null);
  }
});

Deno.test('workflow key presence includes every JSON value including null', () => {
  for (const value of [null, {}, [], 'x', 1, true]) {
    assert(workflowKeyPresent({ relocationGuidance: value }, 'relocationGuidance'));
  }
  assertEquals(workflowKeyPresent({}, 'relocationGuidance'), false);
});
