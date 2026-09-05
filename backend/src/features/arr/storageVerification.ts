import type {
  ArrPathMapping,
  ArrStorageVerificationResponse,
} from '@plex-librarian/shared/types.ts';
import type { ArrClient } from '../../integrations/arr/client.ts';
import { mapArrPath, verifyOrphanHardlink } from '../mediaDeletion/hardlinks.ts';
import { lstatChain } from '../mediaDeletion/pathNamespace.ts';

/** Folder presence is not proof that the correct host folder is mounted. */
export async function inspectStorageRoots(
  mappings: readonly ArrPathMapping[],
  inspect = lstatChain,
): Promise<NonNullable<ArrStorageVerificationResponse['roots']>> {
  return await Promise.all(mappings.map(async ({ kind, arrPath, localPath }) => {
    try {
      const info = await inspect(localPath);
      return {
        kind,
        arrPath,
        localPath,
        status: info.isDirectory ? 'accessible' as const : 'inaccessible' as const,
      };
    } catch (error) {
      return {
        kind,
        arrPath,
        localPath,
        status: error instanceof Deno.errors.NotFound
          ? 'missing' as const
          : 'inaccessible' as const,
      };
    }
  }));
}

/** Read-only sample verification; never a durable deletion authorization. */
export async function verifyArrStorage(
  client: Pick<ArrClient, 'lookup' | 'mediaFiles' | 'torrentAssociations' | 'type'>,
  externalIds: readonly number[],
  mappings: readonly ArrPathMapping[],
  filesystem = { inspect: lstatChain, verify: verifyOrphanHardlink },
): Promise<ArrStorageVerificationResponse> {
  const roots = await inspectStorageRoots(mappings);
  let libraryPath: string | undefined;
  let library: NonNullable<ArrStorageVerificationResponse['library']> = {
    status: 'no_sample',
    reason:
      'No suitable current file was found in the sample. Select and sync a library, then check again. You can still save this connection.',
  };
  let historicalReason =
    'No verifiable historical download hardlink was found in the sample. This optional check does not prevent saving or deleting current library files.';
  for (const id of externalIds.slice(0, 3)) {
    const record = await client.lookup(id);
    if (!record) continue;
    const files = await client.mediaFiles(record.id);
    for (const file of (files ?? []).slice(0, 20)) {
      if (!file.path || !Number.isSafeInteger(file.size) || file.size! <= 0) continue;
      const mapped = mapArrPath(file.path, 'library', mappings);
      if (!mapped) {
        if (!libraryPath) {
          library = {
            status: 'unavailable',
            arrPath: file.path,
            reason: 'No library mapping covers this current file. Check the library root.',
          };
        }
        continue;
      }
      let failure = 'The local file does not match the current library file size or type.';
      try {
        const info = await filesystem.inspect(mapped.path);
        if (info.isFile && info.size === file.size) {
          libraryPath = mapped.path;
          library = {
            status: 'verified',
            arrPath: file.path,
            localPath: mapped.path,
            reason:
              'A current library file is accessible and its size matches. Each deletion checks its own files again.',
          };
          break;
        }
      } catch {
        failure =
          'Plex Librarian cannot access this current file. Check that the local mount exposes the same folder as the mapped Sonarr/Radarr root.';
      }
      if (!libraryPath) {
        library = {
          status: 'unavailable',
          arrPath: file.path,
          localPath: mapped.path,
          reason: failure,
        };
      }
    }
    if (!libraryPath) continue;
    const managed = (files ?? []).flatMap((file) =>
      file.path ? [{ path: file.path, id: file.id, size: file.size }] : []
    );
    try {
      for (const association of (await client.torrentAssociations(record.id)).slice(0, 20)) {
        if (!association.sourcePath) continue;
        const verified = await filesystem.verify(client.type, association, mappings, managed, {
          exactTwoLinks: client.type === 'sonarr',
        });
        if (verified?.file) {
          return {
            roots,
            status: 'verified',
            library,
            historical: {
              status: 'verified',
              reason:
                'A historical download hardlink was verified. Each deletion checks its own files again.',
            },
            libraryPath: verified.file.importedPath,
            downloadPath: verified.file.path,
            reason:
              'Verified a current library file and its historical download hardlink. Each deletion will check its own files again.',
          };
        }
      }
    } catch {
      historicalReason =
        'Historical cleanup could not be checked. Current library access is verified; you can still save these paths.';
    }
    // This record supplied a current sample; history is optional. Do not let
    // unrelated records invalidate its successful filesystem check.
    break;
  }
  return {
    roots,
    status: 'unverified',
    library,
    historical: libraryPath ? { status: 'unverified', reason: historicalReason } : {
      status: 'not_checked',
      reason: 'Verify library access first. Historical cleanup has not been checked.',
    },
    ...(libraryPath ? { libraryPath } : {}),
    reason: libraryPath
      ? 'Library file access checked. No verifiable historical download hardlink was found in the sample. You can save these paths; deletion previews will explain what can be removed.'
      : 'Could not verify storage using current library files. Check the mappings and container mounts, or sync the library to provide a sample. You can still save these paths.',
  };
}
