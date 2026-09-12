import {
  configuredStoragePath,
  type ServicePathRoot,
  type ServiceStorageEndpoint,
  storageContains,
} from '../../../../shared/serviceStorage.ts';
import {
  assertRootConfigurations,
  evidenceFingerprint,
  loadServiceRoots,
  serviceEndpoints,
} from './serviceStorage.ts';
import type { DownloadClientTarget } from './downloadClient.ts';
import { appendRemotePath } from './ownership.ts';
import { withTransaction } from '../../db/index.ts';

/** Current service namespaces for Plex-only version removal; never local filesystem authority. */
export interface VersionStorageEvidence {
  serverId: number;
  libraryKey: string;
  connections: ServiceStorageEndpoint[];
  roots: ServicePathRoot[];
}

export async function captureVersionStorageEvidence(
  serverId: number,
  libraryKey: string,
): Promise<VersionStorageEvidence | undefined> {
  const configured = withTransaction((db) =>
    db.prepare(
      'SELECT 1 FROM service_path_roots WHERE server_id = ? AND service_key = ? LIMIT 1',
    ).value<[number]>(serverId, `plex:${libraryKey}`)
  );
  if (!configured) return undefined;
  const [allRoots, allConnections] = await Promise.all([
    loadServiceRoots(serverId),
    serviceEndpoints(serverId),
  ]);
  const applicable = (key: string) => key === `plex:${libraryKey}` || key.startsWith('qb:');
  const roots = allRoots.filter((root) => applicable(root.serviceKey)).sort((a, b) => a.id - b.id);
  // A saved but stale discovered root is an error, never permission to fall back.
  assertRootConfigurations(roots, allConnections);
  if (!roots.some((root) => root.serviceKey === `plex:${libraryKey}`)) {
    throw new Error('Current Plex storage evidence is unavailable; refresh host discovery');
  }
  const connections = allConnections.filter((entry) => applicable(entry.key))
    .map((entry) => ({ ...entry, roots: [], discoveryError: undefined }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return { serverId, libraryKey, roots, connections };
}

export async function assertVersionStorageEvidenceUnchanged(
  serverId: number,
  libraryKey: string,
  accepted: VersionStorageEvidence,
): Promise<void> {
  if (accepted.serverId !== serverId || accepted.libraryKey !== libraryKey) {
    throw new Error('Accepted version storage belongs to a different server or library');
  }
  const current = await captureVersionStorageEvidence(serverId, libraryKey);
  if (!current || evidenceFingerprint(current) !== evidenceFingerprint(accepted)) {
    throw new Error('Accepted service configuration or storage relationships changed');
  }
}

/** Read-only veto against complete current manifests; this never authorizes torrent deletion. */
export async function assertVersionStoragePathsUnowned(
  evidence: VersionStorageEvidence,
  paths: readonly string[],
  targets: readonly DownloadClientTarget[],
): Promise<void> {
  if (paths.length === 0) throw new Error('Could not verify all Plex deletion paths');
  const map = (key: string, path: string) => configuredStoragePath(evidence.roots, key, path);
  const selected = paths.map((path) => map(`plex:${evidence.libraryKey}`, path));
  const expected = evidence.connections.filter((entry) => entry.key.startsWith('qb:'));
  if (
    expected.length !== targets.length ||
    targets.some((target) =>
      !expected.some((entry) =>
        entry.key === `qb:${target.instanceKey}` &&
        entry.configurationIdentity === evidenceFingerprint(target.configurationIdentity)
      )
    )
  ) throw new Error('The applicable download clients changed after confirmation');
  for (const target of targets) {
    if (!target.client.scanJobSummaries) {
      throw new Error('Current download inventory is unavailable');
    }
    const key = `qb:${target.instanceKey}`;
    const fingerprint = await target.client.scanJobSummaries(async (summary) => {
      const folder = map(key, summary.contentPath);
      if (!selected.some((path) => storageContains(folder, path, false))) return;
      const job = await target.client.findJob(summary.id);
      if (
        !job || job.filesTruncated || job.fileCount < 1 ||
        job.fileCount !== job.manifestFiles.length
      ) {
        throw new Error('Current download manifest is incomplete');
      }
      // A changing summary can move ownership outside the candidate folder during inspection.
      if (
        job.id !== summary.id || job.contentPath !== summary.contentPath ||
        job.savePath !== summary.savePath ||
        job.size !== summary.size
      ) {
        throw new Error('Current download changed during ownership inspection');
      }
      for (const file of job.manifestFiles) {
        const remote = appendRemotePath(job.savePath, file.path);
        if (!remote) throw new Error('Current download manifest contains an invalid path');
        const owned = map(key, remote);
        if (selected.some((path) => path.toLowerCase() === owned.toLowerCase())) {
          throw new Error(
            'A retained download owns a selected file. Its torrent must be explicitly selected for verified cleanup before this path can be removed',
          );
        }
      }
    });
    if (fingerprint !== await target.client.scanJobSummaries(() => Promise.resolve())) {
      throw new Error('Current download inventory changed during ownership inspection');
    }
  }
}
