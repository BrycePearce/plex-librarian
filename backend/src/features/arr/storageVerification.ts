import type {
  ArrPathMapping,
  ArrStorageVerificationResponse,
} from '@plex-librarian/shared/types.ts';
import type { ArrClient } from '../../integrations/arr/client.ts';
import { mapArrPath } from '../mediaDeletion/hardlinks.ts';
import { lstatChain } from '../mediaDeletion/pathNamespace.ts';

/** Folder presence alone is not evidence of the correct media mount. */
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

/** Read-only current-file sample; never a durable deletion authorization. */
export async function verifyArrStorage(
  client: Pick<ArrClient, 'lookup' | 'mediaFiles'>,
  externalIds: readonly number[],
  mappings: readonly ArrPathMapping[],
  filesystem = { inspect: lstatChain },
  selectedPath?: string,
): Promise<ArrStorageVerificationResponse> {
  const roots = await inspectStorageRoots(mappings);
  let library: NonNullable<ArrStorageVerificationResponse['library']> = {
    status: 'no_sample',
    reason: selectedPath
      ? 'The selected file is no longer in the current service record. Refresh the deletion preview.'
      : 'No current file was found. Select and sync the library, then check again.',
  };
  for (const id of externalIds.slice(0, 3)) {
    const record = await client.lookup(id);
    if (!record) continue;
    const files = await client.mediaFiles(record.id);
    const candidates = selectedPath
      ? (files ?? []).filter((file) => file.path === selectedPath)
      : (files ?? []).slice(0, 20);
    for (const file of candidates) {
      if (!file.path || !Number.isSafeInteger(file.size) || file.size! <= 0) continue;
      const mapped = mapArrPath(file.path, 'library', mappings);
      if (!mapped) {
        library = {
          status: 'unavailable',
          arrPath: file.path,
          reason:
            'No library mapping covers this current file. Map its service folder to the folder exposed to Plex Librarian.',
        };
        continue;
      }
      let reason = 'The local file does not match the current library file size or type.';
      try {
        const info = await filesystem.inspect(mapped.path);
        if (info.isFile && info.size === file.size) {
          return {
            roots,
            status: 'verified',
            libraryPath: mapped.path,
            library: {
              status: 'verified',
              arrPath: file.path,
              localPath: mapped.path,
              reason:
                'This current file is accessible and its size matches. The deletion checks identity and ownership again.',
            },
            reason: 'Current file access verified. This check does not authorize a deletion.',
          };
        }
      } catch {
        reason =
          'Plex Librarian cannot read this current file. Expose the same folder to the container with read-only access, then check again.';
      }
      library = { status: 'unavailable', arrPath: file.path, localPath: mapped.path, reason };
    }
  }
  return {
    roots,
    status: 'unverified',
    library,
    reason: library.status === 'no_sample'
      ? library.reason
      : 'Could not verify the selected current file. Check the mapping and container mount, then refresh the preview.',
  };
}
