import { normalizeRemoteAbsolute } from '../mediaDeletion/hardlinks.ts';

export interface QbittorrentPathMappingInput {
  qbittorrentPath: string;
  localPath: string;
  caseSensitive: boolean;
  validationQbittorrentPath: string;
  validationLocalPath: string;
  validationSize: number;
}

function normalizeLocal(path: string): string | null {
  const value = path.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  if (!value || (!value.startsWith('/') && !/^[A-Za-z]:\//.test(value))) return null;
  const parts = value.replace(/^[A-Za-z]:\//, '').split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) return null;
  return Deno.build.os === 'windows' ? value.toLocaleLowerCase('en-US') : value;
}

function within(path: string, root: string, caseSensitive: boolean): boolean {
  const candidate = caseSensitive ? path : path.toLocaleLowerCase('en-US');
  const prefix = caseSensitive ? root : root.toLocaleLowerCase('en-US');
  const separator = prefix.includes('\\') ? '\\' : '/';
  return candidate === prefix || candidate.startsWith(`${prefix}${separator}`);
}

export async function validateQbittorrentPathMapping(
  input: QbittorrentPathMappingInput,
): Promise<QbittorrentPathMappingInput> {
  const remoteRoot = normalizeRemoteAbsolute(input.qbittorrentPath);
  const remoteFile = normalizeRemoteAbsolute(input.validationQbittorrentPath);
  const localRoot = normalizeLocal(input.localPath);
  const localFile = normalizeLocal(input.validationLocalPath);
  if (
    !remoteRoot || !remoteFile || !localRoot || !localFile ||
    remoteRoot.separator !== remoteFile.separator ||
    !within(remoteFile.path, remoteRoot.path, input.caseSensitive) ||
    !within(localFile, localRoot, Deno.build.os !== 'windows') ||
    !Number.isSafeInteger(input.validationSize) || input.validationSize <= 0
  ) {
    throw new Error('Path mapping and exact validation file must use compatible absolute paths');
  }
  const relativeRemote = remoteFile.path.slice(remoteRoot.path.length).replace(/^[\\/]+/, '')
    .replaceAll('\\', '/');
  const relativeLocal = localFile.slice(localRoot.length).replace(/^\/+/, '');
  const localCaseSensitive = Deno.build.os !== 'windows';
  if (
    (localCaseSensitive ? relativeRemote : relativeRemote.toLocaleLowerCase('en-US')) !==
      (localCaseSensitive ? relativeLocal : relativeLocal.toLocaleLowerCase('en-US'))
  ) {
    throw new Error('Validation paths do not identify the same relative file');
  }
  const [info, canonical] = await Promise.all([
    Deno.lstat(input.validationLocalPath),
    Deno.realPath(input.validationLocalPath),
  ]);
  if (!info.isFile || info.isSymlink || info.size !== input.validationSize) {
    throw new Error('The exact local validation file is missing, linked, or has the wrong size');
  }
  if (normalizeLocal(canonical) !== localFile) {
    throw new Error('The validation path resolves through a symlink or namespace alias');
  }
  return {
    ...input,
    qbittorrentPath: remoteRoot.path,
    localPath: input.localPath.replaceAll('\\', '/').replace(/\/+$/, ''),
    validationQbittorrentPath: remoteFile.path,
    validationLocalPath: input.validationLocalPath.replaceAll('\\', '/'),
  };
}

export function qbitMappingsOverlap(
  mappings: readonly { qbittorrentPath: string; localPath: string; caseSensitive: boolean }[],
): boolean {
  for (let left = 0; left < mappings.length; left++) {
    for (let right = left + 1; right < mappings.length; right++) {
      const a = mappings[left]!;
      const b = mappings[right]!;
      const ar = normalizeRemoteAbsolute(a.qbittorrentPath)!;
      const br = normalizeRemoteAbsolute(b.qbittorrentPath)!;
      const al = normalizeLocal(a.localPath)!;
      const bl = normalizeLocal(b.localPath)!;
      if (
        ar.separator === br.separator &&
          (within(ar.path, br.path, a.caseSensitive && b.caseSensitive) ||
            within(br.path, ar.path, a.caseSensitive && b.caseSensitive)) ||
        within(al, bl, Deno.build.os !== 'windows') || within(bl, al, Deno.build.os !== 'windows')
      ) {
        return true;
      }
    }
  }
  return false;
}
