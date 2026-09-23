import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ServiceDeletionChoices } from '../../../../shared/serviceOwnedDeletion.ts';
import type { HistoricalDownloadPreview } from '../../../../shared/historicalDownloads.ts';
import type { NewDeletionTarget } from '../deletionOperations/service.ts';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import { historicalTranslation, listHistoricalAccess } from '../arr/historicalDownloadAccess.ts';
import {
  historicalDownloadLineage,
  type HistoricalLineageCandidate,
  type HistoricalOwner,
  historicalOwnerId,
  radarrHistoricalDownloadLineage,
  selectedRadarrHistoricalFiles,
} from './historicalDownloadLineage.ts';
import {
  serviceOwnedFingerprint,
  type ServiceOwnedPlan,
  type ServiceOwnedPlanningInput,
} from './serviceOwnedPlanning.ts';

export type HistoricalDiscovery = HistoricalOwner & {
  contexts?: HistoricalDiscovery[];
  discovery: 1;
  id: string;
  instanceId: number;
  path: string;
  accessId: string;
  accessRevision: string;
  lineage: HistoricalLineageCandidate;
};

/** Read history once per title, sharing the native inventory already needed for the preview.
 * No filesystem, alias, download-ownership or repeated stability reads belong here. */
export async function discoverHistoricalDownloads(
  serverId: number,
  plans: ServiceOwnedPlan[],
  arr: readonly ArrDeleteTarget[],
  snapshots: NonNullable<ServiceOwnedPlanningInput['sonarrSnapshots']>,
  historyReads = new Map<string, Promise<unknown>>(),
  radarrFiles: NonNullable<ServiceOwnedPlanningInput['radarrFiles']> = new Map(),
): Promise<{ preview: HistoricalDownloadPreview; scope: HistoricalDiscovery[] }> {
  const scope: HistoricalDiscovery[] = [];
  const skipped: HistoricalDownloadPreview['skipped'] = [];
  const access = listHistoricalAccess(serverId);
  const fileActions = new Map<string, Set<string>>();
  const contexts = new Map<
    string,
    { instanceId: number; seriesId: number; episodes: Set<number> }
  >();
  for (const action of plans.flatMap((p) => p.actions)) {
    if (
      !['sonarr', 'radarr'].includes(action.service) || !action.recordId || !action.instanceId ||
      !action.fileId
    ) {
      continue;
    }
    const key = `${action.instanceId}:${action.recordId}`;
    const fileKey = `${key}:${action.fileId}`;
    const actionIds = fileActions.get(fileKey) ?? new Set<string>();
    actionIds.add(action.id);
    fileActions.set(fileKey, actionIds);
    const context = contexts.get(key) ??
      { instanceId: action.instanceId, seriesId: action.recordId, episodes: new Set<number>() };
    for (const id of action.episodeIds ?? []) context.episodes.add(id);
    contexts.set(key, context);
  }
  let records = 0;
  for (const [key, context] of contexts) {
    try {
      const target = arr.find((a) => a.instanceId === context.instanceId)!;
      const current = target.instanceType === 'radarr'
        ? await target.client.radarrMovieSnapshot(context.seriesId, await radarrFiles.get(key))
        : snapshots.get(key);
      if (!current) throw new Error('Current title inventory unavailable');
      const history = await target.client.historicalImports(
        context.seriesId,
        await historyReads.get(key),
      );
      records += history.records.length + history.problems.length;
      if (records > 50_000) throw new Error('History discovery budget exceeded');
      const eligibleFiles = 'movieId' in current
        ? selectedRadarrHistoricalFiles(plans, context.instanceId, current)
        : new Set<number>();
      const lineage = 'movieId' in current
        ? radarrHistoricalDownloadLineage(history, current, eligibleFiles)
        : historicalDownloadLineage(history, current, context.episodes);
      skipped.push(...lineage.skipped);
      for (const candidate of lineage.candidates) {
        const roots = access.filter((a) =>
          a.instanceId === context.instanceId && a.configuration.enabled &&
          a.configuration.localRoot && candidate.source.startsWith(a.configuration.remoteRoot + '/')
        );
        if (roots.length !== 1) {
          skipped.push({
            source: candidate.source,
            reason: 'An enabled, unambiguous completed-download folder is required',
          });
          continue;
        }
        if (scope.length >= 10_000) throw new Error('History discovery budget exceeded');
        const root = roots[0];
        const value = {
          discovery: 1 as const,
          instanceId: context.instanceId,
          ...(target.instanceType === 'radarr'
            ? { service: 'radarr' as const, movieId: context.seriesId }
            : { seriesId: context.seriesId }),
          path: historicalTranslation(candidate.source, root.configuration),
          accessId: root.id,
          accessRevision: root.revision,
          lineage: candidate,
        };
        scope.push({ ...value, id: serviceOwnedFingerprint(value) });
      }
    } catch {
      skipped.push({
        source: `Arr title ${context.seriesId}`,
        reason: 'History discovery unavailable; optional files are excluded',
      });
    }
  }
  return {
    scope,
    preview: {
      discovery: true,
      fingerprint: serviceOwnedFingerprint(scope),
      candidates: scope.map((c) => ({
        id: c.id,
        path: c.lineage.source,
        size: 0,
        ownerCount: c.lineage.owners.length,
        actionIds: [
          ...new Set(
            c.lineage.fileIds.flatMap((
              fileId,
            ) => [...(fileActions.get(`${c.instanceId}:${historicalOwnerId(c)}:${fileId}`) ?? [])]),
          ),
        ],
      })),
      skipped,
    },
  };
}

interface DiscoveryEnvelope {
  serverId: number;
  choices: ServiceDeletionChoices;
  fingerprint: string;
  targets: NewDeletionTarget[];
  historical: HistoricalDiscovery[];
  historicalFingerprint: string;
}

// An authenticated opaque response, not a cache or execution credential. Restart expires open previews;
// accepted requests retain their complete immutable scope in the existing database.
const discoveryKey = randomBytes(32);
export function sealDiscovery(value: DiscoveryEnvelope): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', discoveryKey, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const token = Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  if (token.length > 32_000_000) {
    throw new Error('Discovery scope is too large; select fewer items');
  }
  return token;
}
export function openDiscovery(token: unknown): DiscoveryEnvelope {
  if (typeof token !== 'string' || token.length > 32_000_000) {
    throw new Error('Missing discovery consent');
  }
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length < 28) throw new Error('Invalid discovery consent');
  const decipher = createDecipheriv('aes-256-gcm', discoveryKey, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
  );
}
