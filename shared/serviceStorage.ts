/** A user-confirmed service-to-storage relationship, never a Librarian mount. */
export interface ServicePathRoot {
  id: number;
  serverId: number;
  serviceKey: string;
  configurationIdentity: string;
  serviceRoot: string;
  storageRoot: string;
  caseSensitive: boolean;
  hasAliases: boolean;
  revision: number;
}

export interface ServiceStorageEndpoint {
  key: string;
  name: string;
  configurationIdentity: string;
  libraryKeys: string[];
  roots: string[];
  discoveryError?: string;
  connectionTestedAt?: number;
}

export interface ServiceStorageSettings {
  endpoints: ServiceStorageEndpoint[];
  relationships: ServicePathRoot[];
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

export function configuredStoragePath(
  roots: readonly ServicePathRoot[],
  serviceKey: string,
  path: string,
): string {
  const normalized = storagePath(path);
  const matches = roots.filter((root) =>
    root.serviceKey === serviceKey &&
    storageContains(root.serviceRoot, normalized, root.caseSensitive)
  );
  if (matches.length !== 1 || matches[0].hasAliases) {
    throw new Error(
      `Storage relationship is missing, ambiguous, or has declared aliases for ${serviceKey}. Review Media connections.`,
    );
  }
  const root = matches[0];
  const suffix = normalized.slice(storagePath(root.serviceRoot).length).replace(/^\//, '');
  const resolved = storagePath(`${root.storageRoot.replace(/\/$/, '')}/${suffix}`);
  return root.caseSensitive ? resolved : resolved.toLowerCase();
}
