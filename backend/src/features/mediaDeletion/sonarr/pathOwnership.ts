import type { DownloadJob } from '../downloadClient.ts';

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
