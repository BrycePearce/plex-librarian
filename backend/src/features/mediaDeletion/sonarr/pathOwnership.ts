import type { DownloadClientTarget, DownloadJob } from '../downloadClient.ts';
import {
  downloadJobManifestFingerprint,
  downloadJobSummaryFingerprint,
} from '../downloadClient.ts';
import { directDiscoveryCandidates } from '../../qbittorrent/directDiscovery.ts';
import type { VerifiedOrphanFile } from '../hardlinks.ts';
import { downloadJobOwnsPath } from '../ownership.ts';

export type SonarrPathOwnershipDisposition =
  | 'delete'
  | 'retain_live_qbittorrent'
  | 'unverified';

export interface SonarrPathOwnerEvidence {
  instanceKey: string;
  instanceName: string;
  configurationIdentity: string;
  jobId: string;
  selected: boolean;
  summaryFingerprint: string;
  manifestFingerprint: string;
  /** Complete live job evidence used to build the existing exact payload authorization. */
  job?: DownloadJob;
  authorizedSourcePaths?: string[];
}

export interface SonarrPathInspectionEvidence {
  instanceKey: string;
  instanceName: string;
  configurationIdentity: string;
  discoverySummaryFingerprint: string;
  sourcePathCovered: boolean;
  managedPathCovered: boolean;
}

export interface ClassifiedSonarrPath extends VerifiedOrphanFile {
  ownershipDisposition?: SonarrPathOwnershipDisposition;
  ownershipReason?: string;
  ownershipInspections?: SonarrPathInspectionEvidence[];
  ownershipJobs?: SonarrPathOwnerEvidence[];
  sonarrMutationUnsafe?: true;
}

type FullyClassifiedSonarrPath =
  & ClassifiedSonarrPath
  & Required<
    Pick<
      ClassifiedSonarrPath,
      'ownershipDisposition' | 'ownershipReason' | 'ownershipInspections' | 'ownershipJobs'
    >
  >;

function completeManifest(job: DownloadJob): boolean {
  return !job.filesTruncated && Number.isSafeInteger(job.fileCount) && job.fileCount > 0 &&
    job.fileCount === job.manifestFiles.length &&
    job.manifestFiles.every((file) =>
      typeof file.path === 'string' && file.path.length > 0 &&
      Number.isSafeInteger(file.size) && file.size! >= 0
    );
}

/**
 * Classify only paths which already passed Sonarr's exact two-link proof. Download
 * discovery can remove authority, never create it. Clients without a mapping for
 * the local historical path are deliberately irrelevant.
 */
export async function classifySonarrOwnedPaths<T extends VerifiedOrphanFile>(input: {
  files: readonly T[];
  downloadTargets: readonly DownloadClientTarget[];
  selectedJobKeys: ReadonlySet<string>;
}): Promise<Array<T & FullyClassifiedSonarrPath>> {
  const results: Array<T & FullyClassifiedSonarrPath> = [];
  for (const file of input.files) {
    if (file.strictTwoLinkProof !== true) continue;
    const inspections: SonarrPathInspectionEvidence[] = [];
    const owners: SonarrPathOwnerEvidence[] = [];
    const failures: string[] = [];
    const mutationFailures: string[] = [];
    for (const target of input.downloadTargets) {
      if (target.provider !== 'qbittorrent' || !target.pathMappings?.length) continue;
      let sourceCandidates;
      let managedCandidates;
      try {
        sourceCandidates = directDiscoveryCandidates([file.path], target.pathMappings);
        managedCandidates = directDiscoveryCandidates([file.importedPath], target.pathMappings);
      } catch (error) {
        failures.push(
          `${target.instanceName}: ${
            error instanceof Error ? error.message : 'mapping inspection failed'
          }`,
        );
        continue;
      }
      const candidates = [
        ...new Map(
          [...sourceCandidates, ...managedCandidates].map((
            candidate,
          ) => [`${candidate.caseSensitive}:${candidate.path}`, candidate]),
        ).values(),
      ];
      if (candidates.length === 0) continue;
      if (!target.client.discoverJobs) {
        const reason = `${target.instanceName}: complete qBittorrent discovery is unavailable`;
        failures.push(reason);
        if (managedCandidates.length > 0) mutationFailures.push(reason);
        continue;
      }
      try {
        const discovery = await target.client.discoverJobs(candidates);
        inspections.push({
          instanceKey: target.instanceKey,
          instanceName: target.instanceName,
          configurationIdentity: target.configurationIdentity,
          discoverySummaryFingerprint: discovery.summaryFingerprint,
          sourcePathCovered: sourceCandidates.length > 0,
          managedPathCovered: managedCandidates.length > 0,
        });
        for (const job of discovery.jobs) {
          if (!completeManifest(job)) {
            const reason = `${target.instanceName}: qBittorrent returned an incomplete manifest`;
            failures.push(reason);
            if (managedCandidates.length > 0) mutationFailures.push(reason);
            continue;
          }
          if (managedCandidates.some((candidate) => downloadJobOwnsPath(job, candidate.path))) {
            const reason =
              `${target.instanceName}: a live qBittorrent job owns the exact Sonarr-managed directory entry`;
            failures.push(reason);
            mutationFailures.push(reason);
          }
          const owns = sourceCandidates.some((candidate) =>
            downloadJobOwnsPath(job, candidate.path)
          );
          if (!owns) continue;
          const key = `${target.instanceKey}:${job.id}`;
          owners.push({
            instanceKey: target.instanceKey,
            instanceName: target.instanceName,
            configurationIdentity: target.configurationIdentity,
            jobId: job.id,
            selected: input.selectedJobKeys.has(key),
            summaryFingerprint: await downloadJobSummaryFingerprint(job),
            manifestFingerprint: await downloadJobManifestFingerprint(job),
            job,
            authorizedSourcePaths: sourceCandidates
              .filter((candidate) => downloadJobOwnsPath(job, candidate.path))
              .map((candidate) => candidate.path)
              .sort(),
          });
        }
      } catch (error) {
        const reason = `${target.instanceName}: ${
          error instanceof Error ? error.message : 'ownership inspection failed'
        }`;
        failures.push(reason);
        if (managedCandidates.length > 0) mutationFailures.push(reason);
      }
    }
    const unselected = owners.filter((owner) => !owner.selected);
    const disposition: SonarrPathOwnershipDisposition = failures.length > 0
      ? 'unverified'
      : unselected.length > 0
      ? 'retain_live_qbittorrent'
      : 'delete';
    const reason = disposition === 'unverified'
      ? [...new Set(failures)].join('; ')
      : disposition === 'retain_live_qbittorrent'
      ? `Retained because ${
        unselected.map((owner) => `${owner.instanceName}:${owner.jobId}`).join(', ')
      } owns this exact entry and qBittorrent is not selected`
      : owners.length > 0
      ? 'The exact owning qBittorrent job is selected for payload deletion'
      : 'No live qBittorrent job owns this verified historical entry';
    results.push(
      {
        ...file,
        ownershipDisposition: disposition,
        ownershipReason: reason,
        ownershipInspections: inspections.sort((a, b) =>
          a.instanceKey.localeCompare(b.instanceKey)
        ),
        ownershipJobs: owners.sort((a, b) =>
          a.instanceKey.localeCompare(b.instanceKey) || a.jobId.localeCompare(b.jobId)
        ),
        ...(mutationFailures.length > 0 ? { sonarrMutationUnsafe: true as const } : {}),
      } as T & FullyClassifiedSonarrPath,
    );
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}
