import type {
  ArrPathMapping,
  ArrStorageVerificationResponse,
} from '@plex-librarian/shared/types.ts';
import type { ArrClient } from '../../integrations/arr/client.ts';
import { mapArrPath, verifyOrphanHardlink } from '../mediaDeletion/hardlinks.ts';
import { lstatChain } from '../mediaDeletion/pathNamespace.ts';

/** Read-only sample verification; never a durable deletion authorization. */
export async function verifyArrStorage(
  client: Pick<ArrClient, 'lookup' | 'mediaFiles' | 'torrentAssociations' | 'type'>,
  externalIds: readonly number[],
  mappings: readonly ArrPathMapping[],
  filesystem = { inspect: lstatChain, verify: verifyOrphanHardlink },
): Promise<ArrStorageVerificationResponse> {
  let libraryPath: string | undefined;
  for (const id of externalIds.slice(0, 3)) {
    const record = await client.lookup(id);
    if (!record) continue;
    const files = await client.mediaFiles(record.id);
    for (const file of (files ?? []).slice(0, 20)) {
      if (!file.path || !Number.isSafeInteger(file.size) || file.size! <= 0) continue;
      const mapped = mapArrPath(file.path, 'library', mappings);
      if (!mapped) continue;
      try {
        const info = await filesystem.inspect(mapped.path);
        if (info.isFile && info.size === file.size) {
          libraryPath = mapped.path;
          break;
        }
      } catch { /* Another bounded sample may be accessible. */ }
    }
    if (!libraryPath) continue;
    const managed = (files ?? []).flatMap((file) =>
      file.path ? [{ path: file.path, id: file.id, size: file.size }] : []
    );
    for (const association of (await client.torrentAssociations(record.id)).slice(0, 20)) {
      if (!association.sourcePath) continue;
      const verified = await filesystem.verify(client.type, association, mappings, managed, {
        exactTwoLinks: client.type === 'sonarr',
      });
      if (verified?.file) {
        return {
          status: 'verified',
          libraryPath: verified.file.importedPath,
          downloadPath: verified.file.path,
          reason:
            'Verified a current library file and its historical download hardlink. Each deletion will check its own files again.',
        };
      }
    }
  }
  return {
    status: 'unverified',
    ...(libraryPath ? { libraryPath } : {}),
    reason: libraryPath
      ? 'Library file access checked. No verifiable historical download hardlink was found in the sample. You can save these paths; deletion previews will explain what can be removed.'
      : 'Could not verify storage using current library files. Check the mappings and container mounts, or sync the library to provide a sample. You can still save these paths.',
  };
}
