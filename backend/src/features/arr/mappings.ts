import type { SqliteClient } from '../../db/index.ts';
import type { ArrPathMapping } from '@plex-librarian/shared/types.ts';

function normalizeLocalPath(input: string): string | null {
  const raw = input.trim();
  if (!raw.startsWith('/') || raw.includes('\\')) return null;
  const segments: string[] = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  return segments.length > 0 ? `/${segments.join('/')}` : null;
}

function localPathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function pathMappingRootsAreDisjoint(mappings: readonly ArrPathMapping[]): boolean {
  const normalized = mappings.flatMap((mapping) => {
    const localPath = normalizeLocalPath(mapping.localPath);
    return localPath ? [{ kind: mapping.kind, localPath }] : [];
  });
  if (normalized.length !== mappings.length) return false;
  const libraryRoots = normalized.filter((mapping) => mapping.kind === 'library');
  const downloadRoots = normalized.filter((mapping) => mapping.kind === 'download');
  return !libraryRoots.some((library) =>
    downloadRoots.some((download) => localPathsOverlap(library.localPath, download.localPath))
  );
}

export function validPathMappings(value: unknown): ArrPathMapping[] | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const result: ArrPathMapping[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (
      !raw || (raw.kind !== 'library' && raw.kind !== 'download') ||
      typeof raw.arrPath !== 'string' || typeof raw.localPath !== 'string'
    ) return null;
    const rawArrPath = raw.arrPath.trim();
    const windowsArrPath = /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(rawArrPath);
    const windowsNormalized = rawArrPath.replace(/\//g, '\\');
    const arrPath = windowsArrPath
      ? /^[a-zA-Z]:\\+$/.test(windowsNormalized)
        ? `${windowsNormalized[0]!.toUpperCase()}:\\`
        : windowsNormalized.replace(/\\+$/, '')
      : rawArrPath.replace(/\/+$/, '') || '/';
    const localPath = normalizeLocalPath(raw.localPath);
    const arrSegments = arrPath.split(windowsArrPath ? /\\+/ : /\/+/);
    if (
      (!windowsArrPath && !arrPath.startsWith('/')) || localPath === null ||
      arrPath === '/' || arrSegments.includes('..')
    ) return null;
    const key = `${raw.kind}:${windowsArrPath ? arrPath.toLowerCase() : arrPath}`;
    if (seen.has(key)) return null;
    seen.add(key);
    result.push({ kind: raw.kind, arrPath, localPath });
  }
  const kinds = new Set(result.map((mapping) => mapping.kind));
  if (kinds.size === 1) return null;
  if (!pathMappingRootsAreDisjoint(result)) return null;
  return result;
}

export function replaceArrPathMappings(
  client: SqliteClient,
  instanceId: number,
  mappings: readonly ArrPathMapping[],
): void {
  const remove = client.prepare('DELETE FROM arr_path_mappings WHERE arr_instance_id = ?');
  let insert: ReturnType<SqliteClient['prepare']> | undefined;
  try {
    remove.run(instanceId);
    if (mappings.length === 0) return;
    insert = client.prepare(
      'INSERT INTO arr_path_mappings (arr_instance_id, kind, arr_path, local_path) ' +
        'VALUES (?, ?, ?, ?)',
    );
    for (const mapping of mappings) {
      insert.run(instanceId, mapping.kind, mapping.arrPath, mapping.localPath);
    }
  } finally {
    insert?.finalize();
    remove.finalize();
  }
}

export function replaceArrLibraryMappings(
  client: SqliteClient,
  serverId: number,
  libraryKey: string,
  instanceIds: readonly number[],
  addImportExclusion: boolean,
): void {
  const remove = client.prepare(
    'DELETE FROM arr_library_mappings WHERE server_id = ? AND library_key = ?',
  );
  let insert: ReturnType<SqliteClient['prepare']> | undefined;
  try {
    remove.run(serverId, libraryKey);
    if (instanceIds.length === 0) return;

    insert = client.prepare(
      'INSERT INTO arr_library_mappings ' +
        '(server_id, library_key, arr_instance_id, add_import_exclusion) VALUES (?, ?, ?, ?)',
    );
    for (const instanceId of instanceIds) {
      insert.run(serverId, libraryKey, instanceId, addImportExclusion ? 1 : 0);
    }
  } finally {
    insert?.finalize();
    remove.finalize();
  }
}

export function replaceArrInstanceMappings(
  client: SqliteClient,
  serverId: number,
  instanceId: number,
  libraryKeys: readonly string[],
  addImportExclusion: boolean,
): void {
  const remove = client.prepare(
    'DELETE FROM arr_library_mappings WHERE server_id = ? AND arr_instance_id = ?',
  );
  let insert: ReturnType<SqliteClient['prepare']> | undefined;
  try {
    remove.run(serverId, instanceId);
    if (libraryKeys.length === 0) return;

    insert = client.prepare(
      'INSERT INTO arr_library_mappings ' +
        '(server_id, library_key, arr_instance_id, add_import_exclusion) VALUES (?, ?, ?, ?)',
    );
    for (const libraryKey of libraryKeys) {
      insert.run(serverId, libraryKey, instanceId, addImportExclusion ? 1 : 0);
    }
  } finally {
    insert?.finalize();
    remove.finalize();
  }
}
