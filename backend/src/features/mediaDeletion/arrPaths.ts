import type { ArrPathMapping } from '@plex-librarian/shared/types.ts';
import { normalizeRemoteAbsolute } from './hardlinks.ts';

function normalizeLocalAbsolute(input: string): string | null {
  const raw = input.trim();
  if (!raw.startsWith('/') || raw.includes('\\')) return null;
  const segments: string[] = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

function localWithin(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function remoteWithin(root: string, path: string): boolean {
  const normalizedRoot = normalizeRemoteAbsolute(root);
  const normalizedPath = normalizeRemoteAbsolute(path);
  return normalizedRoot !== null && normalizedPath !== null &&
    normalizedRoot.separator === normalizedPath.separator &&
    (
      normalizedPath.comparison === normalizedRoot.comparison ||
      normalizedPath.comparison.startsWith(
        `${normalizedRoot.comparison}${normalizedRoot.separator}`,
      )
    );
}

/**
 * Resolves a Plex-reported path into the namespace used by one Arr instance.
 *
 * With mappings configured, the path must either already be inside an Arr root or
 * be inside exactly one mapped local root. Ambiguous or uncovered paths fail closed.
 * Without mappings, Plex and Arr are assumed to share one path namespace.
 */
export function resolveArrPath(
  input: string,
  kind: ArrPathMapping['kind'],
  mappings: readonly ArrPathMapping[],
): string | null {
  const normalizedInput = normalizeRemoteAbsolute(input);
  if (!normalizedInput) return null;
  if (mappings.length === 0) return normalizedInput.path;

  const candidates = new Map<string, string>();
  const localInput = normalizeLocalAbsolute(input);
  for (const mapping of mappings) {
    if (mapping.kind !== kind) continue;
    const arrRoot = normalizeRemoteAbsolute(mapping.arrPath);
    const localRoot = normalizeLocalAbsolute(mapping.localPath);
    if (!arrRoot || !localRoot) continue;

    if (remoteWithin(arrRoot.path, normalizedInput.path)) {
      candidates.set(normalizedInput.comparison, normalizedInput.path);
    }
    if (localInput && localWithin(localRoot, localInput)) {
      const relative = localInput.slice(localRoot.length).replace(/^\/+/, '');
      const mapped = relative
        ? `${arrRoot.path}${arrRoot.separator}${relative.replaceAll('/', arrRoot.separator)}`
        : arrRoot.path;
      const normalizedMapped = normalizeRemoteAbsolute(mapped);
      if (normalizedMapped) candidates.set(normalizedMapped.comparison, normalizedMapped.path);
    }
  }
  return candidates.size === 1 ? [...candidates.values()][0]! : null;
}

export function arrPathIsWithin(path: string, root: string): boolean {
  return remoteWithin(root, path);
}

export function arrDirname(path: string): string | null {
  const normalized = normalizeRemoteAbsolute(path);
  if (!normalized) return null;
  const slash = normalized.path.lastIndexOf(normalized.separator);
  if (slash <= 0) return null;
  if (normalized.separator === '\\' && slash === 2) return normalized.path.slice(0, 3);
  return normalized.path.slice(0, slash);
}
