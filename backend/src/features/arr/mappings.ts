import type { SqliteClient } from '../../db/index.ts';

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
