import { assert, assertEquals } from '@std/assert';
import {
  deriveRelocationNamespace,
  validateRelocationBarrier,
  workflowKeyPresent,
} from './relocationModel.ts';

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

Deno.test('workflow key presence includes every JSON value including null', () => {
  for (const value of [null, {}, [], 'x', 1, true]) {
    assert(workflowKeyPresent({ relocationGuidance: value }, 'relocationGuidance'));
  }
  assertEquals(workflowKeyPresent({}, 'relocationGuidance'), false);
});
