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
  supportedMedia?: boolean;
  connectionHost?: string;
  remotePathHints?: { host: string; remotePath: string; localPath: string }[];
}

export type ProposedServiceRoot = Omit<ServicePathRoot, 'id' | 'serverId' | 'revision'>;

export interface ServiceStorageAutomation {
  unavailableServices?: Array<{ serviceKey: string; name: string; reason: string }>;
  status: 'ready' | 'confirmation_required' | 'unavailable';
  reason?: string;
  proposal?: {
    fingerprint: string;
    sharedRoot: string;
    serviceNames: string[];
    relationships: ProposedServiceRoot[];
  };
}

export interface ServiceStorageSettings {
  endpoints: ServiceStorageEndpoint[];
  relationships: ServicePathRoot[];
  automation?: ServiceStorageAutomation;
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
  if (matches.length === 0) {
    throw new Error(
      `No storage relationship covers the selected files for ${serviceKey}. In Media connections, add a relationship for this service's media root.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Overlapping storage relationships cover the selected files for ${serviceKey}. In Media connections, keep one unambiguous relationship for these files.`,
    );
  }
  if (matches[0].hasAliases) {
    throw new Error(
      `The storage relationship for ${serviceKey} declares aliases. Review this relationship in Media connections; deletion is unavailable while its paths have unresolved aliases.`,
    );
  }
  const root = matches[0];
  const suffix = normalized.slice(storagePath(root.serviceRoot).length).replace(/^\//, '');
  const resolved = storagePath(`${root.storageRoot.replace(/\/$/, '')}/${suffix}`);
  return root.caseSensitive ? resolved : resolved.toLowerCase();
}
