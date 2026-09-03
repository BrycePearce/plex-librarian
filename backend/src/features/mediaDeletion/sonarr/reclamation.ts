import type { SqliteClient } from '../../../db/index.ts';
import type { ArrDeleteTarget } from '../../arr/delete.ts';
import type { SonarrSeriesSnapshot } from '../../../integrations/arr/client.ts';
import type { VerifiedOrphanFile } from '../hardlinks.ts';
import type { ClassifiedSonarrPath } from './pathOwnership.ts';

export type HardlinkStorageOutcome = 'verified' | 'unknown' | 'mixed';

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

export interface HardlinkStorageAggregate {
  outcome: HardlinkStorageOutcome;
  verifiedHardlinkDataSize: number;
  verifiedFileCount: number | null;
  unknownFileCount: number | null;
  reasons: string[];
}

export function assertPersistedSonarrReclamation(
  accepted: PersistedSonarrReclamation,
  orphanFiles: readonly VerifiedOrphanFile[],
): void {
  const positiveIds = [accepted.instanceId, accepted.seriesId, accepted.tvdbId];
  const inventory = accepted.inventory;
  const accountingIds = accepted.accountingManagedFileIds;
  const proofPaths = accepted.proofs.filter((proof) =>
    proof.ownershipDisposition === undefined || proof.ownershipDisposition === 'delete'
  )
    .map((proof) => proof.path).sort();
  const orphanPaths = orphanFiles.filter((file) => file.strictTwoLinkProof).map((file) => file.path)
    .sort();
  if (
    positiveIds.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    !accepted.instanceName || !accepted.instanceUrl || !accepted.mappingIdentity ||
    !Number.isSafeInteger(accepted.configurationUpdatedAt) ||
    (accepted.arrDeleteAttemptedAt !== undefined &&
      (!Number.isSafeInteger(accepted.arrDeleteAttemptedAt) ||
        accepted.arrDeleteAttemptedAt <= 0)) ||
    !/^[a-f0-9]{64}$/.test(accepted.inventoryIdentity) || inventory.length === 0 ||
    (accountingIds !== undefined &&
      (accountingIds.length === 0 ||
        accountingIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
        JSON.stringify(accountingIds) !==
          JSON.stringify([...new Set(accountingIds)].sort((left, right) => left - right)) ||
        accountingIds.some((id) => !inventory.some((file) => file.id === id)))) ||
    JSON.stringify(inventory) !==
      JSON.stringify(
        [...inventory].sort((left, right) =>
          left.id - right.id || left.path.localeCompare(right.path) || left.size - right.size
        ),
      ) ||
    accepted.proofs.length === 0 || JSON.stringify(proofPaths) !== JSON.stringify(orphanPaths)
  ) throw new Error('The durable Sonarr hardlink reclamation identity is malformed');
  const boundIds = new Set<number>();
  for (const proof of accepted.proofs) {
    const managed = inventory.find((file) => file.id === proof.managedFileId);
    if (
      !managed || boundIds.has(proof.managedFileId) || managed.path !== proof.managedPath ||
      managed.size !== proof.managedFileSize || proof.size !== proof.managedFileSize ||
      (accountingIds !== undefined && !accountingIds.includes(proof.managedFileId)) ||
      proof.nlink !== 2 || proof.strictTwoLinkProof !== true || !proof.path ||
      (proof.ownershipDisposition !== undefined &&
        !['delete', 'retain_live_qbittorrent', 'unverified'].includes(
          proof.ownershipDisposition,
        )) ||
      !proof.importedPath || !proof.root || !proof.importedRoot ||
      !proof.rootDevice || !proof.rootInode || !proof.importedRootDevice ||
      !proof.importedRootInode || !proof.managedPath || !Number.isSafeInteger(proof.dev) ||
      !Number.isSafeInteger(proof.ino)
    ) throw new Error('The durable Sonarr hardlink proof is malformed or conflicting');
    boundIds.add(proof.managedFileId);
  }
}

export function canonicalSonarrInventory(snapshot: SonarrSeriesSnapshot): SonarrInventoryFile[] {
  return snapshot.files.map(({ id, path, size }) => ({ id, path, size })).sort((left, right) =>
    left.id - right.id || left.path.localeCompare(right.path) || left.size - right.size
  );
}

export async function sonarrInventoryIdentity(
  inventory: readonly SonarrInventoryFile[],
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(inventory)),
  );
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}

export async function assertAcceptedSonarrInventory(
  accepted: PersistedSonarrReclamation,
  current: SonarrSeriesSnapshot,
): Promise<void> {
  const identity = await sonarrInventoryIdentity(canonicalSonarrInventory(current));
  if (identity !== accepted.inventoryIdentity) {
    throw new Error('The complete Sonarr EpisodeFile inventory changed after cleanup was accepted');
  }
}

export function buildSonarrReclamation(
  target: ArrDeleteTarget,
  seriesId: number,
  tvdbId: number,
  inventory: SonarrInventoryFile[],
  inventoryIdentity: string,
  files: readonly VerifiedOrphanFile[],
): PersistedSonarrReclamation {
  const proofs = files.flatMap((file) =>
    file.strictTwoLinkProof === true && Number.isSafeInteger(file.managedFileId) &&
      file.managedFileId! > 0 && file.managedFileSize === file.size && file.managedPath
      ? [{
        ...file,
        ownershipDisposition: 'unverified' as const,
        ownershipReason: 'Live qBittorrent ownership has not been inspected',
        ownershipInspections: [],
        ownershipJobs: [],
        managedFileId: file.managedFileId!,
        managedFileSize: file.managedFileSize!,
        managedPath: file.managedPath,
      }]
      : []
  );
  const bindings = new Set<string>();
  const ids = new Set<number>();
  const managedPaths = new Set<string>();
  for (const proof of proofs) {
    const binding = `${proof.managedFileId}\0${proof.managedPath}\0${proof.managedFileSize}`;
    if (
      bindings.has(binding) || ids.has(proof.managedFileId) ||
      managedPaths.has(proof.managedPath)
    ) {
      throw new Error('Conflicting Sonarr EpisodeFile hardlink proof bindings');
    }
    bindings.add(binding);
    ids.add(proof.managedFileId);
    managedPaths.add(proof.managedPath);
    const managedMatches = inventory.filter((entry) =>
      entry.path === proof.managedPath && entry.size === proof.size
    );
    const managed = managedMatches[0];
    if (
      managedMatches.length !== 1 || managed?.id !== proof.managedFileId
    ) {
      throw new Error('A hardlink proof does not bind to the accepted Sonarr EpisodeFile');
    }
  }
  return {
    instanceId: target.instanceId,
    instanceName: target.instanceName,
    instanceUrl: target.instanceUrl,
    configurationUpdatedAt: target.configurationUpdatedAt,
    mappingIdentity: target.mappingIdentity,
    seriesId,
    tvdbId,
    inventory,
    inventoryIdentity,
    proofs,
  };
}

export function deriveHardlinkStorageAggregate(
  accepted: PersistedSonarrReclamation,
  reasons: readonly string[] = [],
): HardlinkStorageAggregate {
  const verified = accepted.proofs.filter((proof) =>
    proof.unlinkConfirmedAt !== undefined && proof.accountingIneligibleAt === undefined
  );
  const identities = new Map<string, number>();
  for (const proof of verified) {
    const key = `${proof.dev}:${proof.ino}`;
    const prior = identities.get(key);
    if (prior !== undefined && prior !== proof.size) {
      throw new Error('Conflicting accepted sizes share one hardlink identity');
    }
    identities.set(key, proof.size);
  }
  let bytes = 0;
  for (const size of identities.values()) {
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(bytes + size)) {
      throw new Error('Verified hardlink byte total exceeds the safe integer range');
    }
    bytes += size;
  }
  const accountingIds = accepted.accountingManagedFileIds === undefined
    ? new Set(accepted.inventory.map((file) => file.id))
    : new Set(accepted.accountingManagedFileIds);
  const verifiedIds = new Set(
    verified.flatMap((proof) =>
      accountingIds.has(proof.managedFileId) ? [proof.managedFileId] : []
    ),
  );
  const verifiedFileCount = identities.size;
  const unknownFileCount = [...accountingIds].filter((id) => !verifiedIds.has(id)).length;
  return {
    outcome: verifiedFileCount === 0 ? 'unknown' : unknownFileCount === 0 ? 'verified' : 'mixed',
    verifiedHardlinkDataSize: Math.round(bytes / 1000),
    verifiedFileCount,
    unknownFileCount,
    reasons: [...new Set(reasons)],
  };
}

export function sonarrReclamationAccountingFileCount(
  accepted: PersistedSonarrReclamation,
): number {
  return accepted.accountingManagedFileIds?.length ?? accepted.inventory.length;
}

/**
 * Every durably confirmed unlink retains its survivor and final-absence obligations.
 * Accounting ineligibility affects credit only; it must never relax mutation safety.
 */
export function unlinkConfirmedReclamationProofs(
  accepted: PersistedSonarrReclamation,
): PersistedSonarrReclamation['proofs'] {
  return accepted.proofs.filter((proof) => proof.unlinkConfirmedAt !== undefined);
}

export function checkpointHardlinkStorageOutcome(
  client: SqliteClient,
  input: {
    targetId: number;
    serverId: number;
    operationId: string;
    targetKey: string;
    aggregate: HardlinkStorageAggregate;
    now: number;
    advanceToPlexReconciliation?: boolean;
  },
): void {
  const value = input.aggregate;
  const changed = client.prepare(
    `UPDATE deletion_targets SET storage_outcome = ?, verified_hardlink_data_size = ?,
       verified_file_count = ?, unknown_file_count = ?, storage_outcome_reasons = ?,
       ${input.advanceToPlexReconciliation ? "phase = 'plex_reconciliation'," : ''}
       updated_at = ?
     WHERE id = ?${
      input.advanceToPlexReconciliation
        ? " AND status = 'running' AND phase = 'arr_coordination'"
        : ''
    }`,
  ).run(
    value.outcome,
    value.verifiedHardlinkDataSize,
    value.verifiedFileCount,
    value.unknownFileCount,
    JSON.stringify(value.reasons),
    input.now,
    input.targetId,
  );
  if (changed !== 1) {
    throw new Error('The deletion target changed before its storage outcome checkpoint');
  }
  client.prepare(
    `INSERT INTO media_removals
       (server_id, operation_id, target_kind, target_key, media_size, logical_attributable,
        verified_hardlink_data_size, verified_file_count, unknown_file_count, storage_outcome, created_at)
     VALUES (?, ?, 'item', ?, NULL, 0, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id, operation_id, target_kind, target_key) DO UPDATE SET
       verified_hardlink_data_size = excluded.verified_hardlink_data_size,
       verified_file_count = excluded.verified_file_count,
       unknown_file_count = excluded.unknown_file_count,
       storage_outcome = excluded.storage_outcome`,
  ).run(
    input.serverId,
    input.operationId,
    input.targetKey,
    value.verifiedHardlinkDataSize,
    value.verifiedFileCount,
    value.unknownFileCount,
    value.outcome,
    input.now,
  );
}

export const HARDLINK_OUTCOME_REASON = {
  cleanupUnselected: 'cleanup_unselected',
  liveJobOnly: 'live_download_job_only',
  incompleteProof: 'incomplete_two_link_proof',
  ambiguousInstance: 'ambiguous_sonarr_instance',
  crashWindow: 'unlink_confirmation_missing',
} as const;
