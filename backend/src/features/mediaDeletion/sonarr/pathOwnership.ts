import type { DownloadClientTarget, DownloadJob } from '../downloadClient.ts';
import {
  downloadJobManifestFingerprint,
  downloadJobSummaryFingerprint,
} from '../downloadClient.ts';
import {
  discoverMappedDownloadJobs,
  localDownloadJobOwnedPaths,
} from '../mappedDownloadDiscovery.ts';
import type { VerifiedOrphanFile } from '../hardlinks.ts';

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
 * discovery can remove authority, never create it. Unmapped live QB storage is
 * unknown ownership, not evidence that a connected client does not own a path.
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
      if (target.provider !== 'qbittorrent') continue;
      try {
        const discovery = await discoverMappedDownloadJobs(target, [{ path: file.path }, {
          path: file.importedPath,
        }]);
        inspections.push({
          instanceKey: target.instanceKey,
          instanceName: target.instanceName,
          configurationIdentity: target.configurationIdentity,
          discoverySummaryFingerprint: discovery.summaryFingerprint,
          sourcePathCovered: true,
          managedPathCovered: true,
        });
        for (const job of discovery.jobs) {
          if (!completeManifest(job)) {
            const reason = `${target.instanceName}: qBittorrent returned an incomplete manifest`;
            failures.push(reason);
            mutationFailures.push(reason);
            continue;
          }
          if (
            (await localDownloadJobOwnedPaths(job, { path: file.importedPath }, target)).length > 0
          ) {
            const reason =
              `${target.instanceName}: a live qBittorrent job owns the exact Sonarr-managed directory entry`;
            failures.push(reason);
            mutationFailures.push(reason);
          }
          const sourceCandidates = await localDownloadJobOwnedPaths(
            job,
            { path: file.path },
            target,
          );
          if (sourceCandidates.length === 0) continue;
          const exactCandidates = await localDownloadJobOwnedPaths(
            job,
            { path: file.path },
            target,
            undefined,
            true,
          );
          if (sourceCandidates.some((path) => !exactCandidates.includes(path))) {
            failures.push(
              `${target.instanceName}: case-ambiguous qBittorrent ownership cannot authorize payload deletion`,
            );
            continue;
          }
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
            authorizedSourcePaths: sourceCandidates.sort(),
          });
        }
      } catch (error) {
        const reason = `${target.instanceName}: ${
          error instanceof Error ? error.message : 'ownership inspection failed'
        }`;
        failures.push(reason);
        mutationFailures.push(reason);
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
