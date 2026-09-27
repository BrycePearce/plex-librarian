export interface ServiceStorageEndpoint {
  key: string;
  name: string;
  configurationIdentity: string;
  libraryKeys: string[];
  roots: string[];
  discoveryError?: string;
  connectionTestedAt?: number;
  supportedMedia?: boolean;
  connectionHost?: string;
  connectionPort?: number;
  connectionPath?: string;
  remotePathHints?: { host: string; remotePath: string; localPath: string }[];
}

export interface ServiceDeletionResponse {
  status: 'succeeded' | 'accepted';
  httpStatus: number;
}

export function storagePath(input: string): string {
  if (
    typeof input !== 'string' || !input || input !== input.trim() ||
    [...input].some((char) => char.charCodeAt(0) < 32)
  ) {
    throw new Error('Storage paths must be nonempty absolute paths without control characters');
  }
  const path = input.replaceAll('\\', '/').replace(/\/+$/, '') || '/';
  if (!path.startsWith('/') && !/^[A-Za-z]:\//.test(path)) {
    throw new Error('Storage paths must be absolute');
  }
  if (path.split('/').some((part) => part === '.' || part === '..') || /\/\//.test(path.slice(2))) {
    throw new Error('Traversal and ambiguous separators are unavailable in storage relationships');
  }
  return path;
}

export function storageContains(root: string, path: string, caseSensitive = true): boolean {
  const a = caseSensitive ? storagePath(root) : storagePath(root).toLowerCase();
  const b = caseSensitive ? storagePath(path) : storagePath(path).toLowerCase();
  return a === b || b.startsWith(a.endsWith('/') ? a : `${a}/`);
}
