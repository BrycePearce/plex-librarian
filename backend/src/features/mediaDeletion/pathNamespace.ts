export interface PersistedPathNamespaceEvidence {
  plexMappingId: number;
  plexMappingRevision: number;
  plexPath: string;
  localPath: string;
  arrPath: string;
  arrMappingKind: 'library' | 'download';
  arrMappingRoot: string;
  arrLocalRoot: string;
}

export interface PersistedPhysicalIdentityEvidence {
  selectedLocalPath: string;
  retainedLocalPath: string;
  selectedSize: number;
  retainedSize: number;
  selectedDevice: string;
  selectedInode: string;
  retainedDevice: string;
  retainedInode: string;
  selectedParentDevice: string;
  selectedParentInode: string;
  retainedParentDevice: string;
  retainedParentInode: string;
  selectedCanonicalPath: string;
  retainedCanonicalPath: string;
}

export async function lstatChain(path: string): Promise<Deno.FileInfo> {
  const windowsDrive = /^([a-zA-Z]:)[\\/]/.exec(path)?.[1];
  const separator = windowsDrive ? '\\' : '/';
  let current = windowsDrive ? `${windowsDrive}\\` : '';
  const segments = path.replace(/^[a-zA-Z]:[\\/]/, '').split(/[\\/]/).filter(Boolean);
  for (const segment of segments) {
    current = current
      ? `${current.replace(/[\\/]$/, '')}${separator}${segment}`
      : `${separator}${segment}`;
    const info = await Deno.lstat(current);
    if (info.isSymlink) {
      throw new Error(`Symbolic links are unavailable for path adoption: ${current}`);
    }
  }
  return await Deno.lstat(path);
}
