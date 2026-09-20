import type { ClassifiedSonarrPath } from './pathOwnership.ts';

export interface SonarrInventoryFile {
  id: number;
  path: string;
  size: number;
}

export interface PersistedSonarrReclamation {
  instanceId: number;
  instanceName: string;
  instanceUrl: string;
  configurationUpdatedAt: number;
  mappingIdentity: string;
  seriesId: number;
  tvdbId: number;
  inventory: SonarrInventoryFile[];
  inventoryIdentity: string;
  /** Snapshot-only accounting scope. Full inventory remains bound by inventoryIdentity. */
  accountingManagedFileIds?: number[];
  /** Durable intent for this target's Sonarr series deletion, written immediately before it. */
  arrDeleteAttemptedAt?: number;
  proofs: Array<
    ClassifiedSonarrPath & {
      managedFileId: number;
      managedFileSize: number;
      managedPath: string;
      unlinkAttemptedAt?: number;
      unlinkConfirmedAt?: number;
      accountingIneligibleAt?: number;
    }
  >;
}
