import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.ts';

import { arrInstances, arrLibraryMappings, arrPathMappings } from '../../db/schema.ts';
import { ArrClient } from '../../integrations/arr/client.ts';
import type { ArrPathMapping } from '@plex-librarian/shared/types.ts';

export interface CoordinatedDeleteItem {
  title: string;
  type: string;
  tmdbId: number | null;
  tvdbId: number | null;
}

export interface ArrDeleteTarget {
  instanceId: number;
  instanceName: string;
  instanceType: 'radarr' | 'sonarr';
  instanceUrl: string;
  configurationUpdatedAt: number;
  mappingIdentity: string;
  client: ArrClient;
  addImportExclusion: boolean;
  pathMappings: ArrPathMapping[];
}

export async function getArrDeleteTargets(
  serverId: number,
  libraryKey: string,
): Promise<ArrDeleteTarget[]> {
  const rows = await db.select({
    instanceId: arrInstances.id,
    instanceName: arrInstances.name,
    type: arrInstances.type,
    url: arrInstances.url,
    apiKey: arrInstances.apiKey,
    updatedAt: arrInstances.updatedAt,
    addImportExclusion: arrLibraryMappings.addImportExclusion,
  }).from(arrLibraryMappings).innerJoin(
    arrInstances,
    eq(arrLibraryMappings.arrInstanceId, arrInstances.id),
  ).where(and(
    eq(arrLibraryMappings.serverId, serverId),
    eq(arrLibraryMappings.libraryKey, libraryKey),
    eq(arrInstances.serverId, serverId),
  ));

  const mappings = rows.length === 0 ? [] : await db.select().from(arrPathMappings).where(
    inArray(arrPathMappings.arrInstanceId, rows.map((row) => row.instanceId)),
  );
  return rows.map((row) => {
    const pathMappings = mappings.filter((mapping) => mapping.arrInstanceId === row.instanceId).map(
      (mapping) => ({
        kind: mapping.kind,
        arrPath: mapping.arrPath,
        localPath: mapping.localPath,
      }),
    ).sort((left, right) =>
      `${left.kind}\0${left.arrPath}\0${left.localPath}`.localeCompare(
        `${right.kind}\0${right.arrPath}\0${right.localPath}`,
      )
    );
    return {
      instanceId: row.instanceId,
      instanceName: row.instanceName,
      instanceType: row.type,
      instanceUrl: row.url,
      configurationUpdatedAt: row.updatedAt,
      mappingIdentity: JSON.stringify({
        addImportExclusion: row.addImportExclusion,
        pathMappings,
      }),
      client: new ArrClient(row.type, row.url, row.apiKey),
      addImportExclusion: row.addImportExclusion,
      pathMappings,
    };
  });
}
