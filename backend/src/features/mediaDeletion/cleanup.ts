import type { ArrDeleteTarget, CoordinatedDeleteItem } from '../arr/delete.ts';
import type { ArrExtraFile, ArrManagedFile } from '../../integrations/arr/client.ts';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { plexPathMappings } from '../../db/schema.ts';
import {
  type DownloadClientTarget,
  downloadJobManifestFingerprint,
  downloadJobSummaryFingerprint,
} from './downloadClient.ts';
import {
  type AttemptedOrphanFile,
  completedOrphanFileAttempt,
  deleteVerifiedOrphanFile,
  findRetainedSiblingPaths,
  normalizeRemoteAbsolute,
  type PayloadScanBudget,
  type VerifiedOrphanFile,
  verifyOrphanHardlink,
  verifyTrackedHardlinks,
} from './hardlinks.ts';
import {
  appendRemotePath,
  downloadJobOwnsPath,
  downloadPayloadIsExclusivelyOwned,
} from './ownership.ts';
import {
  lstatChain,
  type PlexNamespaceMappingRecord,
  resolvePlexToLocal,
} from './pathNamespace.ts';
import {
  assertPersistedSonarrReclamation,
  buildSonarrReclamation,
  canonicalSonarrInventory,
  type PersistedSonarrReclamation,
  sonarrInventoryIdentity,
} from './sonarr/reclamation.ts';
import { classifySonarrOwnedPaths } from './sonarr/pathOwnership.ts';
import type {
  CleanupItemWithoutPlexPaths,
  DirectPlexPathEvidence,
  DirectRetainedPathEvidence,
  PersistedResolvedCleanupItem,
  ResolvedCleanupItem,
  ResolvedDownloadJob,
} from './cleanup/types.ts';
export type {
  CleanupItemWithoutPlexPaths,
  DirectPlexPathEvidence,
  DirectRetainedPathEvidence,
  PersistedResolvedCleanupItem,
  PersistedResolvedDownloadJob,
  ResolvedCleanupItem,
  ResolvedDownloadJob,
} from './cleanup/types.ts';

export function publicSonarrHistoricalPaths(cleanup: ResolvedCleanupItem) {
  const classified = cleanup.sonarrReclamation?.proofs.map((proof) => ({
    path: proof.path,
    managedPath: proof.managedPath,
    size: proof.size,
    disposition: proof.ownershipDisposition ?? 'unverified',
    reason: proof.ownershipReason ?? 'Live qBittorrent ownership was not durably classified',
  })) ?? [];
  const classifiedPaths = new Set(classified.map((entry) => entry.path));
  const sonarrInstances = new Set(
    cleanup.arrTargets.filter((target) => target.type === 'sonarr').map((target) =>
      target.instanceName
    ),
  );
  const unavailable = cleanup.sources.flatMap((source) => {
    if (
      !sonarrInstances.has(source.instanceName) || source.verification !== 'unverified' ||
      !source.reason
    ) return [];
    const path = source.localPath ?? source.path;
    if (!path || classifiedPaths.has(path)) return [];
    return [{
      path,
      managedPath: source.importedPath,
      size: null,
      disposition: 'unverified' as const,
      reason: `${source.instanceName}: ${source.reason}`,
    }];
  });
  return [...new Map([...classified, ...unavailable].map((entry) => [entry.path, entry])).values()]
    .sort((left, right) => left.path.localeCompare(right.path));
}

/** Bind Sonarr historical unlink authority independently from qBittorrent intent. */
export async function bindSonarrPathOwnership(
  cleanup: ResolvedCleanupItem,
  downloadTargets: readonly DownloadClientTarget[],
  selectQbittorrent: boolean,
): Promise<ResolvedCleanupItem> {
  const reclamation = cleanup.sonarrReclamation;
  if (!reclamation) {
    return {
      ...cleanup,
      status: selectQbittorrent && cleanup.status === 'error' ? 'error' : 'resolved',
      downloadJobs: selectQbittorrent ? cleanup.downloadJobs : [],
      orphanFiles: [],
    };
  }
  const initiallyClassified = await classifySonarrOwnedPaths({
    files: reclamation.proofs,
    downloadTargets,
    selectedJobKeys: new Set(),
  });
  const existingJobKeys = new Set(
    cleanup.downloadJobs.map((job) => `${job.instanceKey}:${job.jobId}`),
  );
  const discoveredOwners = new Map<string, {
    target: DownloadClientTarget;
    job: NonNullable<
      NonNullable<(typeof initiallyClassified)[number]['ownershipJobs']>[number]['job']
    >;
    sourcePaths: Set<string>;
    importedPaths: Set<string>;
  }>();
  for (const proof of initiallyClassified) {
    for (const owner of proof.ownershipJobs ?? []) {
      if (!owner.job) continue;
      const target = downloadTargets.find((candidate) =>
        candidate.instanceKey === owner.instanceKey
      );
      if (!target) continue;
      const key = `${owner.instanceKey}:${owner.jobId}`;
      const current = discoveredOwners.get(key) ?? {
        target,
        job: owner.job,
        sourcePaths: new Set<string>(),
        importedPaths: new Set<string>(),
      };
      for (const path of owner.authorizedSourcePaths ?? []) current.sourcePaths.add(path);
      // Version planners compare this association to Plex/Sonarr's remote library
      // path. The proof's importedPath is the mapped local filesystem path.
      current.importedPaths.add(proof.managedPath);
      discoveredOwners.set(key, current);
    }
  }
  const discoveredJobs: ResolvedDownloadJob[] = [];
  for (const [key, owner] of discoveredOwners) {
    if (
      existingJobKeys.has(key) ||
      !downloadPayloadIsExclusivelyOwned(owner.job, owner.sourcePaths)
    ) continue;
    const { id: _id, ...publicJob } = owner.job;
    discoveredJobs.push({
      ...publicJob,
      provider: owner.target.provider,
      jobId: owner.job.id,
      instanceKey: owner.target.instanceKey,
      instanceName: owner.target.instanceName,
      sourcePath: [...owner.sourcePaths].sort()[0] ?? null,
      authorizedSourcePaths: [...owner.sourcePaths].sort(),
      provenance: 'arr_history',
      authorizationMode: 'manifest_paths',
      target: owner.target,
    });
  }
  const selectableJobs = [...cleanup.downloadJobs, ...discoveredJobs].sort((a, b) =>
    a.instanceKey.localeCompare(b.instanceKey) || a.jobId.localeCompare(b.jobId)
  );
  const discoveredSources = [...discoveredOwners.values()].flatMap((owner) =>
    [...owner.importedPaths].map((importedPath) => ({
      instanceName: owner.target.instanceName,
      downloadId: owner.job.id,
      path: [...owner.sourcePaths].sort()[0] ?? owner.job.contentPath,
      importedPath,
      verification: 'hardlink' as const,
    }))
  );
  const sources = [...new Map(
    [...cleanup.sources, ...discoveredSources].map((source) => [
      `${source.instanceName}\0${source.downloadId}\0${source.path}\0${source.importedPath ?? ''}`,
      source,
    ]),
  ).values()];
  const selectedJobKeys = new Set(
    (selectQbittorrent ? selectableJobs : []).map((job) => `${job.instanceKey}:${job.jobId}`),
  );
  const proofs = selectQbittorrent && selectedJobKeys.size > 0
    ? await classifySonarrOwnedPaths({
      files: reclamation.proofs,
      downloadTargets,
      selectedJobKeys,
    })
    : initiallyClassified;
  if (proofs.length === 0) {
    // A Sonarr inventory without an accepted two-link proof is still useful for
    // preview diagnostics, but it is not a reclamation operation. Persisting the
    // empty shell would make an ordinary Sonarr deletion fail durable rehydration,
    // whose invariant correctly requires at least one exact proof.
    const { sonarrReclamation: _sonarrReclamation, ...withoutReclamation } = cleanup;
    return {
      ...withoutReclamation,
      status: selectQbittorrent && cleanup.status === 'error' ? 'error' : 'resolved',
      downloadJobs: selectQbittorrent ? selectableJobs : [],
      sources,
      orphanFiles: [],
    };
  }
  const automatic = proofs.filter((proof) => proof.ownershipDisposition === 'delete');
  const blockedSelectedPayload = proofs.find((proof) =>
    proof.ownershipDisposition !== 'delete' &&
    proof.ownershipJobs.some((owner) => owner.selected)
  );
  const blockingProof = proofs.find((proof) => proof.sonarrMutationUnsafe) ??
    blockedSelectedPayload;
  const retainedPaths = [...new Map([
    ...cleanup.retainedPaths,
    ...proofs.filter((proof) => proof.ownershipDisposition !== 'delete').map((proof) => ({
      path: proof.path,
      reason: proof.ownershipReason,
    })),
  ].map((entry) => [entry.path, entry])).values()];
  return {
    ...cleanup,
    status: blockingProof !== undefined ||
        selectQbittorrent && cleanup.status === 'error'
      ? 'error'
      : 'resolved',
    ...(blockingProof?.ownershipReason ? { reason: blockingProof.ownershipReason } : {}),
    downloadJobs: selectQbittorrent ? selectableJobs : [],
    sources,
    orphanFiles: automatic,
    retainedPaths,
    sonarrReclamation: { ...reclamation, proofs },
  };
}

/** Final execution check: accepted deletions may be downgraded but never expanded. */
export async function revalidateAcceptedSonarrPathOwnership(
  accepted: ResolvedCleanupItem,
  downloadTargets: readonly DownloadClientTarget[],
  confirmedAttemptedAbsences: ReadonlySet<string> = new Set(),
): Promise<ResolvedCleanupItem> {
  if (!accepted.sonarrReclamation) return accepted;
  const acceptedPaths = new Set(accepted.orphanFiles.map((file) => file.path));
  const selectedJobKeys = new Set(
    accepted.downloadJobs.map((job) => `${job.instanceKey}:${job.jobId}`),
  );
  const checked = (await classifySonarrOwnedPaths({
    files: accepted.sonarrReclamation.proofs,
    downloadTargets,
    selectedJobKeys,
  })).map((proof) => {
    const prior = accepted.sonarrReclamation!.proofs.find((entry) => entry.path === proof.path);
    const priorSelected = prior?.ownershipJobs?.filter((owner) => owner.selected) ?? [];
    const currentInspections = new Map(
      proof.ownershipInspections.map((inspection) => [inspection.instanceKey, inspection]),
    );
    const lostInspections = (prior?.ownershipInspections ?? []).filter((inspection) => {
      const current = currentInspections.get(inspection.instanceKey);
      return !current || current.configurationIdentity !== inspection.configurationIdentity;
    });
    if (
      prior?.unlinkAttemptedAt !== undefined && confirmedAttemptedAbsences.has(proof.path)
    ) {
      const lostManagedInspection = lostInspections.find((inspection) =>
        inspection.managedPathCovered !== false
      );
      const mutationReason = proof.sonarrMutationUnsafe
        ? proof.ownershipReason
        : lostManagedInspection
        ? `${lostManagedInspection.instanceName}: the accepted qBittorrent ownership inspection is no longer valid`
        : undefined;
      return {
        ...prior,
        ownershipJobs: [...new Map([
          ...(prior.ownershipJobs ?? []),
          ...priorSelected,
        ].map((owner) => [`${owner.instanceKey}:${owner.jobId}`, owner])).values()],
        ...(mutationReason
          ? { ownershipReason: mutationReason, sonarrMutationUnsafe: true as const }
          : {}),
      };
    }
    if (lostInspections.length > 0) {
      const reason = lostInspections.map((inspection) =>
        `${inspection.instanceName}: the accepted qBittorrent ownership inspection is no longer valid`
      ).join('; ');
      return {
        ...proof,
        ownershipDisposition: 'unverified' as const,
        ownershipReason: reason,
        ...(lostInspections.some((inspection) => inspection.managedPathCovered !== false)
          ? { sonarrMutationUnsafe: true as const }
          : {}),
        ownershipJobs: [...new Map([
          ...proof.ownershipJobs,
          ...priorSelected,
        ].map((owner) => [`${owner.instanceKey}:${owner.jobId}`, owner])).values()],
      };
    }
    return {
      ...proof,
      ownershipJobs: [...new Map([
        ...proof.ownershipJobs,
        ...priorSelected,
      ].map((owner) => [`${owner.instanceKey}:${owner.jobId}`, owner])).values()],
    };
  });
  const unsafe = checked.find((proof) => proof.sonarrMutationUnsafe);
  if (unsafe) throw new Error(unsafe.ownershipReason);
  const blockedSelectedPayload = checked.find((proof) =>
    proof.ownershipDisposition !== 'delete' &&
    proof.ownershipJobs.some((owner) => owner.selected)
  );
  if (blockedSelectedPayload) throw new Error(blockedSelectedPayload.ownershipReason);
  const byPath = new Map(checked.map((proof) => [proof.path, proof]));
  const proofs = accepted.sonarrReclamation.proofs.map((proof) => {
    const current = byPath.get(proof.path);
    if (!current) return proof;
    // Execution may remove previously accepted authority, but it must never promote
    // a retained or unverified preview entry into a new deletion target.
    if (!acceptedPaths.has(proof.path)) {
      return current.ownershipDisposition === 'delete' ? proof : current;
    }
    return current;
  });
  const orphanFiles = checked.filter((proof) =>
    acceptedPaths.has(proof.path) && proof.ownershipDisposition === 'delete'
  );
  const downgraded = proofs.filter((proof) => proof.ownershipDisposition !== 'delete');
  return {
    ...accepted,
    orphanFiles,
    retainedPaths: [...new Map([
      ...accepted.retainedPaths,
      ...downgraded.map((proof) => ({
        path: proof.path,
        reason: proof.ownershipReason ?? 'Live qBittorrent ownership could not be verified',
      })),
    ].map((entry) => [entry.path, entry])).values()],
    sonarrReclamation: { ...accepted.sonarrReclamation, proofs },
  };
}

export function scopeSonarrReclamation(
  cleanup: ResolvedCleanupItem,
  managedFileIds: ReadonlySet<number>,
  managedPaths: ReadonlySet<string> = new Set(),
): ResolvedCleanupItem {
  const managedPathComparisons = new Set([...managedPaths].flatMap((path) => {
    const normalized = normalizeRemoteAbsolute(path)?.comparison;
    return normalized ? [normalized] : [];
  }));
  const sourceIsInScope = (source: ResolvedCleanupItem['sources'][number]) => {
    if (!source.importedPath || managedPathComparisons.size === 0) return false;
    const normalized = normalizeRemoteAbsolute(source.importedPath)?.comparison;
    return normalized !== undefined && managedPathComparisons.has(normalized);
  };
  if (!cleanup.sonarrReclamation) {
    return managedPathComparisons.size === 0
      ? cleanup
      : { ...cleanup, sources: cleanup.sources.filter(sourceIsInScope) };
  }
  const proofs = cleanup.sonarrReclamation.proofs.filter((proof) =>
    managedFileIds.has(proof.managedFileId)
  );
  if (proofs.length === 0) {
    return {
      ...cleanup,
      sources: cleanup.sources.filter(sourceIsInScope),
      orphanFiles: [],
      retainedPaths: [],
      sonarrReclamation: undefined,
    };
  }
  const paths = new Set(proofs.map((proof) => proof.path));
  const sourceBindings = new Set(proofs.flatMap((proof) => [
    `${proof.hash}\0${normalizeRemoteAbsolute(proof.path)?.comparison ?? proof.path}`,
    `${proof.hash}\0${normalizeRemoteAbsolute(proof.remotePath)?.comparison ?? proof.remotePath}`,
    `${proof.hash}\0${normalizeRemoteAbsolute(proof.managedPath)?.comparison ?? proof.managedPath}`,
  ]));
  const scopedSources = cleanup.sources.filter((source) =>
    sourceIsInScope(source) ||
    [source.localPath, source.path, source.importedPath].some((path) =>
      path && sourceBindings.has(
        `${source.downloadId}\0${normalizeRemoteAbsolute(path)?.comparison ?? path}`,
      )
    )
  );
  return {
    ...cleanup,
    sources: scopedSources,
    orphanFiles: cleanup.orphanFiles.filter((file) => paths.has(file.path)),
    retainedPaths: cleanup.retainedPaths.filter((entry) => paths.has(entry.path)),
    sonarrReclamation: {
      ...cleanup.sonarrReclamation,
      accountingManagedFileIds: [...managedFileIds]
        .filter((id) => cleanup.sonarrReclamation!.inventory.some((file) => file.id === id))
        .sort((left, right) => left - right),
      proofs,
    },
  };
}

function canonicalAuthorizationValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalAuthorizationValue).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalAuthorizationValue(entry)]),
    );
  }
  return value;
}

/** Opaque binding between the destructive paths/jobs shown in preview and acceptance. */
export async function cleanupAuthorizationFingerprint(
  cleanup: ResolvedCleanupItem,
): Promise<string> {
  const accepted = persistResolvedCleanupIdentity(cleanup);
  const authorization = {
    ratingKey: accepted.ratingKey,
    downloadJobs: accepted.downloadJobs.map((job) => ({
      provider: job.provider,
      instanceKey: job.instanceKey,
      instanceName: job.instanceName,
      jobId: job.jobId,
      targetIdentity: job.targetIdentity,
      authorizedSourcePaths: job.authorizedSourcePaths,
      provenance: job.provenance,
      authorizationMode: job.authorizationMode,
      sonarrAssociations: job.sonarrAssociations,
      discoverySummaryFingerprint: job.discoverySummaryFingerprint,
      ownershipSummaryFingerprint: job.ownershipSummaryFingerprint,
      manifestFingerprint: job.manifestFingerprint,
      directPathEvidence: job.directPathEvidence,
      directPlexPathEvidence: job.directPlexPathEvidence,
      directRetainedPathEvidence: job.directRetainedPathEvidence,
      directDiscoveryCandidates: job.directDiscoveryCandidates,
      directPathMappings: job.directPathMappings,
    })),
    orphanFiles: accepted.orphanFiles,
    sonarrReclamation: accepted.sonarrReclamation,
    retainedPaths: accepted.retainedPaths,
    sources: accepted.sources,
    reason: accepted.reason,
  };
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(canonicalAuthorizationValue(authorization))),
  );
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}

export function cleanupIsEligible(
  cleanup: Pick<
    ResolvedCleanupItem,
    'status' | 'downloadJobs' | 'orphanFiles' | 'sonarrReclamation'
  >,
): boolean {
  return cleanup.status === 'resolved' &&
    (cleanup.downloadJobs.length > 0 ||
      (cleanup.sonarrReclamation !== undefined && cleanup.orphanFiles.length > 0));
}

export function cleanupHasDurableAcceptedIdentity(
  cleanup: Pick<ResolvedCleanupItem, 'downloadJobs' | 'sonarrReclamation'>,
): boolean {
  // Ordinary Arr-history live jobs are deliberately rediscovered at execution time.
  // Whole-show hash authority is the one history-derived job mode durably bound here.
  return cleanup.sonarrReclamation !== undefined ||
    (cleanup.downloadJobs.length > 0 &&
      cleanup.downloadJobs.every((job) =>
        job.provenance === 'direct_manifest' || job.authorizationMode === 'whole_show_hash'
      ));
}

export function persistResolvedCleanup(
  cleanup: ResolvedCleanupItem,
): PersistedResolvedCleanupItem {
  if (cleanup.status !== 'resolved') {
    throw new Error('Only a fully resolved download cleanup can be persisted');
  }
  const { observedDownloadJobKeys: _observedDownloadJobKeys, ...persisted } = cleanup;
  return {
    ...persisted,
    downloadJobs: cleanup.downloadJobs.map(({ target, ...job }) => ({
      ...job,
      targetIdentity: {
        provider: target.provider,
        instanceKey: target.instanceKey,
        configurationIdentity: target.configurationIdentity,
        instanceId: target.instanceId,
        instanceName: target.instanceName,
      },
    })),
  };
}

export function persistResolvedCleanupIdentity(
  cleanup: ResolvedCleanupItem,
): PersistedResolvedCleanupItem {
  const persisted = persistResolvedCleanup(cleanup);
  const selectedJobIds = new Set(persisted.downloadJobs.map((job) => job.jobId));
  const sources = [...new Map(
    persisted.sources.filter((source) => selectedJobIds.has(source.downloadId)).map((source) => [
      `${source.downloadId}:${source.importedPath ?? ''}`,
      source,
    ]),
  ).values()];
  return {
    ...persisted,
    // The torrent hash fixes the payload manifest. Keeping thousands of manifest
    // entries in every season target would only duplicate evidence that is fetched
    // and revalidated immediately before deletion.
    downloadJobs: persisted.downloadJobs.map((job) => ({ ...job, manifestFiles: [] })),
    // Execution only needs enough association evidence to prove coverage for the
    // selected jobs. Show-wide history and preview-only summaries belong to the
    // operation preview, not to every durable media target.
    sources,
    arrTargets: [],
    retainedPaths: [],
  };
}

export function rehydrateResolvedCleanup(
  cleanup: PersistedResolvedCleanupItem,
  targets: readonly DownloadClientTarget[],
): ResolvedCleanupItem {
  if (cleanup.status !== 'resolved') {
    throw new Error('The durable download cleanup is not resolved');
  }
  const downloadJobs = cleanup.downloadJobs.map(({ targetIdentity, ...job }) => {
    const matches = targets.filter((target) =>
      target.provider === targetIdentity.provider &&
      target.instanceKey === targetIdentity.instanceKey &&
      target.configurationIdentity === targetIdentity.configurationIdentity &&
      target.instanceId === targetIdentity.instanceId &&
      target.instanceName === targetIdentity.instanceName
    );
    if (matches.length !== 1) {
      throw new Error('The configured download client changed after cleanup was accepted');
    }
    if (
      typeof job.jobId !== 'string' || !job.jobId ||
      typeof targetIdentity.configurationIdentity !== 'string' ||
      !targetIdentity.configurationIdentity ||
      job.provider !== targetIdentity.provider ||
      job.instanceKey !== targetIdentity.instanceKey ||
      job.instanceName !== targetIdentity.instanceName ||
      !Array.isArray(job.authorizedSourcePaths) || job.authorizedSourcePaths.length === 0 ||
      job.authorizedSourcePaths.some((path) => typeof path !== 'string' || !path) ||
      (job.authorizationMode === 'whole_show_hash' &&
        (job.provenance !== 'arr_history' ||
          job.provider !== 'qbittorrent' || targetIdentity.provider !== 'qbittorrent' ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(job.jobId) ||
          !/^[a-f0-9]{64}$/.test(job.ownershipSummaryFingerprint ?? '') ||
          !/^[a-f0-9]{64}$/.test(job.manifestFingerprint ?? '') ||
          !Array.isArray(job.sonarrAssociations) || job.sonarrAssociations.length === 0 ||
          job.sonarrAssociations.some((association) =>
            !association || !Number.isSafeInteger(association.instanceId) ||
            association.instanceId <= 0 || typeof association.instanceUrl !== 'string' ||
            !association.instanceUrl ||
            !Number.isSafeInteger(association.configurationUpdatedAt) ||
            association.configurationUpdatedAt <= 0 ||
            !Number.isSafeInteger(association.seriesId) ||
            association.seriesId <= 0 || association.hash !== job.jobId ||
            !Array.isArray(association.sourcePaths) || association.sourcePaths.length === 0 ||
            association.sourcePaths.some((path) =>
              typeof path !== 'string' || normalizeRemoteAbsolute(path) === null
            )
          ))) ||
      (job.directPathEvidence !== undefined &&
        (job.provenance !== 'direct_manifest' ||
          !Array.isArray(job.directPlexPathEvidence) || job.directPlexPathEvidence.length === 0 ||
          !Array.isArray(job.directRetainedPathEvidence) ||
          !/^[a-f0-9]{64}$/.test(job.discoverySummaryFingerprint ?? '') ||
          !/^[a-f0-9]{64}$/.test(job.ownershipSummaryFingerprint ?? '') ||
          !/^[a-f0-9]{64}$/.test(job.manifestFingerprint ?? '') ||
          !Array.isArray(job.directDiscoveryCandidates) ||
          job.directDiscoveryCandidates.length === 0 ||
          job.directDiscoveryCandidates.some((candidate) =>
            !candidate || typeof candidate.path !== 'string' || !candidate.path ||
            typeof candidate.caseSensitive !== 'boolean' ||
            normalizeRemoteAbsolute(candidate.path) === null
          ) ||
          JSON.stringify(job.directPathMappings) !== JSON.stringify(matches[0]!.pathMappings)))
    ) {
      throw new Error('The durable download cleanup identity is malformed');
    }
    return { ...job, target: matches[0]! };
  });
  if (cleanup.sonarrReclamation) {
    assertPersistedSonarrReclamation(cleanup.sonarrReclamation, cleanup.orphanFiles);
  }
  return { ...cleanup, downloadJobs };
}

/**
 * Sonarr orphan proofs and selected job IDs are accepted authority. Current history may
 * suppress an unlink, but must never expand that authority to a newly appeared live job.
 */
export function mergeAcceptedSonarrCleanup(
  current: ResolvedCleanupItem,
  accepted: ResolvedCleanupItem,
  ownershipRevalidated = false,
): ResolvedCleanupItem {
  if (!accepted.sonarrReclamation) return accepted;
  if (current.status !== 'resolved') {
    if (ownershipRevalidated && accepted.downloadJobs.length === 0) return accepted;
    throw new Error(
      current.reason ?? 'Arr-history download cleanup could not be revalidated',
    );
  }
  const observedLiveHashes = new Set(
    [...(current.observedDownloadJobKeys ?? [])].map((key) => key.slice(key.lastIndexOf(':') + 1)),
  );
  const acceptedHistoryJobs = new Set(
    accepted.downloadJobs.filter((job) => job.provenance === 'arr_history').map(wholeShowJobKey),
  );
  return {
    ...current,
    downloadJobs: [
      ...accepted.downloadJobs.filter((job) => job.provenance === 'direct_manifest'),
      ...current.downloadJobs.filter((job) =>
        job.provenance === 'arr_history' && acceptedHistoryJobs.has(wholeShowJobKey(job))
      ),
    ],
    // Newly discovered history can change live-job eligibility, but it must never
    // authorize a replacement orphan path after the user accepted the preview. A
    // reappeared live job also suppresses direct unlink even when it cannot be deleted.
    orphanFiles: ownershipRevalidated
      ? accepted.orphanFiles
      : accepted.orphanFiles.filter((file) => !observedLiveHashes.has(file.hash)),
    sonarrReclamation: accepted.sonarrReclamation,
  };
}

function wholeShowJobKey(job: Pick<ResolvedDownloadJob, 'instanceKey' | 'jobId'>): string {
  return `${job.instanceKey}:${job.jobId}`;
}

function associationIdentity(
  association: NonNullable<ResolvedDownloadJob['sonarrAssociations']>[number],
): string {
  return JSON.stringify({
    instanceId: association.instanceId,
    instanceUrl: association.instanceUrl,
    configurationUpdatedAt: association.configurationUpdatedAt,
    seriesId: association.seriesId,
    hash: association.hash,
  });
}

/** Bind fresh whole-show discovery to the exact accepted job and Sonarr identities. */
export function assertAcceptedWholeShowHashCleanup(
  current: ResolvedCleanupItem,
  accepted: ResolvedCleanupItem,
  attemptedJobKeys: ReadonlySet<string>,
): void {
  if (!accepted.downloadJobs.some((job) => job.authorizationMode === 'whole_show_hash')) return;
  const acceptedJobs = accepted.downloadJobs;
  if (acceptedJobs.some((job) => job.authorizationMode !== 'whole_show_hash')) {
    throw new Error('The accepted whole-show download job set is malformed');
  }
  if (current.status !== 'resolved') {
    throw new Error(current.reason ?? 'Whole-show qBittorrent cleanup could not be revalidated');
  }
  const currentJobs = current.downloadJobs;
  const currentByKey = new Map(currentJobs.map((job) => [wholeShowJobKey(job), job]));
  const expectedPresent = acceptedJobs.filter((job) => {
    const key = wholeShowJobKey(job);
    return currentByKey.has(key) || !attemptedJobKeys.has(key);
  });
  if (
    new Set(currentJobs.map(wholeShowJobKey)).size !== currentJobs.length ||
    new Set(acceptedJobs.map(wholeShowJobKey)).size !== acceptedJobs.length ||
    currentJobs.length !== expectedPresent.length ||
    expectedPresent.some((job) => !currentByKey.has(wholeShowJobKey(job)))
  ) {
    throw new Error('The accepted whole-show download job set changed');
  }
  for (const acceptedJob of expectedPresent) {
    const currentJob = currentByKey.get(wholeShowJobKey(acceptedJob))!;
    if (
      currentJob.provenance !== 'arr_history' || currentJob.jobId !== acceptedJob.jobId ||
      currentJob.provider !== acceptedJob.provider ||
      currentJob.instanceName !== acceptedJob.instanceName ||
      currentJob.target.configurationIdentity !== acceptedJob.target.configurationIdentity ||
      currentJob.target.instanceId !== acceptedJob.target.instanceId ||
      currentJob.ownershipSummaryFingerprint !== acceptedJob.ownershipSummaryFingerprint ||
      currentJob.manifestFingerprint !== acceptedJob.manifestFingerprint
    ) throw new Error('The accepted whole-show download identity changed');
    const acceptedAssociations = acceptedJob.sonarrAssociations ?? [];
    const currentAssociations = currentJob.sonarrAssociations ?? [];
    if (
      new Set(acceptedAssociations.map(associationIdentity)).size !== acceptedAssociations.length ||
      new Set(currentAssociations.map(associationIdentity)).size !== currentAssociations.length ||
      acceptedAssociations.length !== currentAssociations.length
    ) throw new Error('The accepted Sonarr download association changed');
    for (const acceptedAssociation of acceptedAssociations) {
      const currentAssociation = currentAssociations.find((candidate) =>
        associationIdentity(candidate) === associationIdentity(acceptedAssociation)
      );
      const acceptedPaths = new Set(
        acceptedAssociation.sourcePaths.flatMap((path) => {
          const normalized = normalizeRemoteAbsolute(path);
          return normalized ? [normalized.comparison] : [];
        }),
      );
      if (
        !currentAssociation || acceptedPaths.size === 0 ||
        !currentAssociation.sourcePaths.some((path) => {
          const normalized = normalizeRemoteAbsolute(path);
          return normalized !== null && acceptedPaths.has(normalized.comparison);
        })
      ) throw new Error('The accepted Sonarr download association changed');
    }
  }
}

export interface DownloadedFileCleanupResult {
  deletedJobs: Array<{ provider: string; instanceName: string; jobId: string; name: string }>;
  alreadyRemovedJobs: Array<
    { provider: string; instanceName: string; jobId: string; name: string }
  >;
  deletedOrphanFiles: string[];
  alreadyRemovedOrphanFiles: string[];
}

async function assertDirectPlexMappingsUnchanged(
  evidence: readonly DirectPlexPathEvidence[],
): Promise<void> {
  if (evidence.length === 0) {
    throw new Error('Direct Plex path-mapping evidence is missing');
  }
  const scopes = new Map<string, { serverId: number; libraryKey: string }>();
  for (const item of evidence) {
    if (
      !Number.isSafeInteger(item.serverId) || item.serverId <= 0 || !item.libraryKey ||
      !item.plexPath || !item.localPath || !Number.isSafeInteger(item.mappingId) ||
      item.mappingId <= 0 || !Number.isSafeInteger(item.mappingRevision) ||
      item.mappingRevision <= 0 || !item.mappingPlexPath || !item.mappingLocalPath ||
      typeof item.mappingCaseSensitive !== 'boolean'
    ) throw new Error('Direct Plex path-mapping evidence is malformed');
    scopes.set(`${item.serverId}:${item.libraryKey}`, {
      serverId: item.serverId,
      libraryKey: item.libraryKey,
    });
  }
  const currentByScope = new Map<string, PlexNamespaceMappingRecord[]>();
  for (const [key, scope] of scopes) {
    const rows = await db.select().from(plexPathMappings).where(and(
      eq(plexPathMappings.serverId, scope.serverId),
      eq(plexPathMappings.libraryKey, scope.libraryKey),
    ));
    currentByScope.set(key, rows);
  }
  for (const item of evidence) {
    const rows = currentByScope.get(`${item.serverId}:${item.libraryKey}`) ?? [];
    const resolved = resolvePlexToLocal(item.plexPath, rows);
    if (
      !resolved || resolved.path !== item.localPath || resolved.mapping.id !== item.mappingId ||
      resolved.mapping.revision !== item.mappingRevision ||
      resolved.mapping.plexPath !== item.mappingPlexPath ||
      resolved.mapping.localPath !== item.mappingLocalPath ||
      resolved.mapping.caseSensitive !== item.mappingCaseSensitive
    ) throw new Error('Plex path mapping changed since direct cleanup was accepted');
  }
}

async function assertDirectRetainedPathsUnchanged(
  evidence: readonly DirectRetainedPathEvidence[],
): Promise<void> {
  for (const item of evidence) {
    const [info, canonical] = await Promise.all([
      lstatChain(item.localPath),
      Deno.realPath(item.localPath),
    ]);
    if (
      !info.isFile || info.isSymlink || info.size !== item.size ||
      String(info.dev) !== item.device || String(info.ino) !== item.inode ||
      canonical !== item.canonicalPath
    ) throw new Error('A retained Plex filesystem identity changed since preview');
  }
}

export class DownloadedFileCleanupError extends Error {
  constructor(
    message: string,
    readonly result: DownloadedFileCleanupResult,
    readonly system: string,
    readonly target: string,
  ) {
    super(message);
    this.name = 'DownloadedFileCleanupError';
  }
}

export function reconcileSharedDownloadCleanups(
  cleanups: readonly ResolvedCleanupItem[],
): ResolvedCleanupItem[] {
  const observations = new Map<string, { eligible: Set<string>; observed: Set<string> }>();
  for (const cleanup of cleanups) {
    for (const key of cleanup.observedDownloadJobKeys ?? []) {
      const state = observations.get(key) ?? {
        eligible: new Set<string>(),
        observed: new Set<string>(),
      };
      state.observed.add(cleanup.ratingKey);
      observations.set(key, state);
    }
    for (const job of cleanup.downloadJobs) {
      const key = `${job.instanceKey}:${job.jobId}`;
      const state = observations.get(key) ?? {
        eligible: new Set<string>(),
        observed: new Set<string>(),
      };
      if (cleanup.status === 'resolved') state.eligible.add(cleanup.ratingKey);
      observations.set(key, state);
    }
  }
  const conflicted = new Set(
    [...observations].filter(([, state]) =>
      [...state.observed].some((ratingKey) => !state.eligible.has(ratingKey))
    ).map(([key]) => key),
  );
  if (conflicted.size === 0) return [...cleanups];

  return cleanups.map((cleanup): ResolvedCleanupItem => {
    const removed = cleanup.downloadJobs.filter((job) =>
      conflicted.has(`${job.instanceKey}:${job.jobId}`)
    );
    if (removed.length === 0) return cleanup;
    const downloadJobs = cleanup.downloadJobs.filter((job) =>
      !conflicted.has(`${job.instanceKey}:${job.jobId}`)
    );
    const retainedPaths = [...new Map([
      ...cleanup.retainedPaths,
      ...removed.map((job) => ({
        path: job.contentPath || job.savePath,
        reason:
          'This download job is also associated with a selected title that did not independently authorize its complete payload; the shared job and files are retained',
      })),
    ].map((entry) => [entry.path, entry])).values()];
    if (downloadJobs.length > 0 || cleanup.orphanFiles.length > 0) {
      return { ...cleanup, downloadJobs, retainedPaths };
    }
    if (cleanup.status !== 'resolved') return { ...cleanup, downloadJobs, retainedPaths };
    return {
      ...cleanup,
      status: 'unavailable',
      downloadJobs,
      reason: 'A matching download job is shared with another selected title and is retained',
      retainedPaths,
    };
  });
}

export function selectVerifiedDownloadCleanups(
  cleanups: Iterable<ResolvedCleanupItem>,
): Map<string, ResolvedCleanupItem> {
  const verified = new Map<string, ResolvedCleanupItem>();
  for (const cleanup of cleanups) {
    // Error results may contain jobs observed before another configured client
    // failed. They are deliberately excluded: only a completely resolved item is
    // safe to include in an optional partial-batch mutation.
    if (cleanup.status === 'resolved') verified.set(cleanup.ratingKey, cleanup);
  }
  return verified;
}

export async function executeDownloadedFileCleanup(
  cleanup: ResolvedCleanupItem,
  deletedDownloadJobKeys: Set<string>,
  deletedOrphanPaths: Set<string>,
  beforeDownloadJobDelete: (job: ResolvedDownloadJob, jobKey: string) => Promise<void> = () =>
    Promise.resolve(),
  deleteOrphanFile: (file: VerifiedOrphanFile) => Promise<void> = deleteVerifiedOrphanFile,
  beforeOrphanDelete: (file: VerifiedOrphanFile) => Promise<void> = () => Promise.resolve(),
  afterOrphanDelete: (file: VerifiedOrphanFile) => Promise<void> = () => Promise.resolve(),
  authorizeOrphanDelete: (file: VerifiedOrphanFile) => Promise<boolean> = () =>
    Promise.resolve(true),
): Promise<DownloadedFileCleanupResult> {
  const result: DownloadedFileCleanupResult = {
    deletedJobs: [],
    alreadyRemovedJobs: [],
    deletedOrphanFiles: [],
    alreadyRemovedOrphanFiles: [],
  };
  const directDiscoveries = new Map<
    DownloadClientTarget['client'],
    NonNullable<ReturnType<NonNullable<DownloadClientTarget['client']['discoverJobs']>>>
  >();
  for (const job of cleanup.downloadJobs) {
    const jobKey = `${job.instanceKey}:${job.jobId}`;
    const publicJob = {
      provider: job.provider,
      instanceName: job.instanceName,
      jobId: job.jobId,
      name: job.name,
    };
    if (deletedDownloadJobKeys.has(jobKey)) {
      result.alreadyRemovedJobs.push(publicJob);
      continue;
    }
    try {
      let current = job.directPathEvidence ? null : await job.target.client.findJob(job.jobId);
      const authorizedPaths = new Set(job.authorizedSourcePaths);
      if (job.directPathEvidence) {
        if (!job.target.client.discoverJobs) {
          throw new Error('Direct download discovery is unavailable during revalidation');
        }
        let discovery = directDiscoveries.get(job.target.client);
        if (!discovery) {
          discovery = job.target.client.discoverJobs(job.directDiscoveryCandidates ?? []);
          directDiscoveries.set(job.target.client, discovery);
        }
        const liveDiscovery = await discovery;
        current = liveDiscovery.jobs.find((candidate) => candidate.id === job.jobId) ?? null;
        for (const evidence of job.directPathEvidence) {
          const [info, canonical] = await Promise.all([
            Deno.lstat(evidence.localPath),
            Deno.realPath(evidence.localPath),
          ]);
          if (
            !info.isFile || info.isSymlink || info.size !== evidence.size ||
            String(info.dev) !== evidence.device || String(info.ino) !== evidence.inode ||
            canonical !== evidence.canonicalPath
          ) {
            throw new Error('Direct download filesystem ownership changed since preview');
          }
        }
        if (
          job.provenance !== 'direct_manifest' || !job.discoverySummaryFingerprint ||
          !job.ownershipSummaryFingerprint || !job.manifestFingerprint || !current ||
          liveDiscovery.summaryFingerprint !== job.discoverySummaryFingerprint ||
          await downloadJobSummaryFingerprint(current) !== job.ownershipSummaryFingerprint ||
          await downloadJobManifestFingerprint(current) !== job.manifestFingerprint ||
          JSON.stringify(job.directPathMappings) !== JSON.stringify(job.target.pathMappings)
        ) {
          throw new Error('Direct download manifest changed since preview');
        }
        await assertDirectPlexMappingsUnchanged(job.directPlexPathEvidence ?? []);
        if ((job.directRetainedPathEvidence?.length ?? 0) > 0) {
          await assertDirectPlexMappingsUnchanged(job.directRetainedPathEvidence!);
        }
        await assertDirectRetainedPathsUnchanged(job.directRetainedPathEvidence ?? []);
      }
      const wholeShowHash = job.authorizationMode === 'whole_show_hash';
      if (
        !current || current.id !== job.jobId ||
        !authorizedPaths.size ||
        ![...authorizedPaths].some((path) => downloadJobOwnsPath(current, path)) ||
        (wholeShowHash
          ? !job.ownershipSummaryFingerprint || !job.manifestFingerprint ||
            await downloadJobSummaryFingerprint(current) !== job.ownershipSummaryFingerprint ||
            await downloadJobManifestFingerprint(current) !== job.manifestFingerprint
          : !downloadPayloadIsExclusivelyOwned(current, authorizedPaths))
      ) {
        throw new Error(
          'Download job identity or manifest changed since verification; nothing was removed',
        );
      }
      await beforeDownloadJobDelete(job, jobKey);
      await job.target.client.deleteJob(job.jobId, { deleteData: true });
      deletedDownloadJobKeys.add(jobKey);
      result.deletedJobs.push(publicJob);
    } catch (error) {
      throw new DownloadedFileCleanupError(
        error instanceof Error ? error.message : 'download cleanup failed',
        result,
        job.provider,
        `${job.instanceName}: ${job.name}`,
      );
    }
  }
  for (const orphanFile of cleanup.orphanFiles) {
    if (deletedOrphanPaths.has(orphanFile.path)) {
      // A prior attempt can have completed the unlink but crashed before its
      // durable confirmation callback. Let the caller re-establish that
      // postcondition before treating the absence as completed.
      await afterOrphanDelete(orphanFile);
      result.alreadyRemovedOrphanFiles.push(orphanFile.path);
      continue;
    }
    const ownershipJobs = (orphanFile as Partial<
      import('./sonarr/pathOwnership.ts').ClassifiedSonarrPath
    >).ownershipJobs ?? [];
    const selectedOwnerWasDeleted = ownershipJobs.some((owner) =>
      owner.selected && deletedDownloadJobKeys.has(`${owner.instanceKey}:${owner.jobId}`)
    );
    // Sonarr-owned paths receive their final live-owner check immediately before
    // an unattempted unlink. A previously attempted, now-confirmed-absent selected
    // payload is already authoritative for paths in its exact accepted manifest.
    if (!selectedOwnerWasDeleted && !await authorizeOrphanDelete(orphanFile)) continue;
    try {
      await beforeOrphanDelete(orphanFile);
      try {
        await deleteOrphanFile(orphanFile);
      } catch (error) {
        // The selected exact payload deletion runs first. Its removal of this
        // snapshotted entry is attributable only after this path's own attempt marker.
        if (!(error instanceof Deno.errors.NotFound) || !selectedOwnerWasDeleted) throw error;
      }
      await afterOrphanDelete(orphanFile);
      deletedOrphanPaths.add(orphanFile.path);
      result.deletedOrphanFiles.push(orphanFile.path);
    } catch (error) {
      throw new DownloadedFileCleanupError(
        error instanceof Error ? error.message : 'orphan hardlink cleanup failed',
        result,
        'filesystem',
        orphanFile.path,
      );
    }
  }
  return result;
}

export async function confirmedAttemptedDownloadJobAbsences(
  cleanup: ResolvedCleanupItem,
  attemptedJobKeys: ReadonlySet<string>,
): Promise<Set<string>> {
  const confirmed = new Set<string>();
  for (const job of cleanup.downloadJobs) {
    const key = `${job.instanceKey}:${job.jobId}`;
    if (attemptedJobKeys.has(key) && await job.target.client.findJob(job.jobId) === null) {
      confirmed.add(key);
    }
  }
  return confirmed;
}

function externalId(item: CoordinatedDeleteItem): number | null {
  return item.type === 'movie' ? item.tmdbId : item.type === 'show' ? item.tvdbId : null;
}

export async function resolveDownloadCleanup(
  ratingKey: string,
  item: CoordinatedDeleteItem,
  arrTargets: ArrDeleteTarget[],
  downloadTargets: DownloadClientTarget[],
  attemptedDownloadJobKeys: ReadonlySet<string> = new Set(),
  attemptedOrphanFiles: readonly AttemptedOrphanFile[] = [],
  attemptedArrInstanceIds: ReadonlySet<number> = new Set(),
  payloadScanBudget?: PayloadScanBudget,
  options: { allowWholeShowHash?: boolean } = {},
): Promise<ResolvedCleanupItem> {
  const id = externalId(item);
  if (id === null || arrTargets.length === 0) {
    return {
      ratingKey,
      status: 'unavailable',
      downloadJobs: [],
      reason: id === null
        ? 'No TMDB/TVDB ID is available for Arr history lookup'
        : 'This library is not mapped to Sonarr or Radarr',
      arrStatus: 'unavailable',
      arrReason: id === null
        ? 'No TMDB/TVDB ID is available for managed deletion'
        : 'This library is not mapped to Sonarr or Radarr',
      arrTargets: [],
      sources: [],
      orphanFiles: [],
      retainedPaths: [],
    };
  }

  const associationPaths = new Map<string, Set<string>>();
  const sonarrAssociations = new Map<
    string,
    NonNullable<ResolvedDownloadJob['sonarrAssociations']>[number]
  >();
  const associationHashes = new Set<string>();
  const arrMediaIds = new Map<number, number | null>();
  const sharedAssociationHashes = new Set<string>();
  const sources = new Map<string, ResolvedCleanupItem['sources'][number]>();
  const orphanFiles: VerifiedOrphanFile[] = [];
  const sonarrCandidates: PersistedSonarrReclamation[] = [];
  const inspectionWarnings = new Map<string, ResolvedCleanupItem['retainedPaths'][number]>();
  const resolvedArrTargets: ResolvedCleanupItem['arrTargets'] = [];
  const arrErrors: string[] = [];
  const historyErrors: string[] = [];
  const managedFileErrors: string[] = [];
  const orphanAttemptErrors: string[] = [];
  let completedOrphanAttemptCount = 0;
  let completedArrAttemptCount = 0;
  let reclamationUnavailableReason: string | undefined;
  const configuredDownloadRoots = new Set(
    arrTargets.flatMap((target) =>
      target.pathMappings.filter((mapping) => mapping.kind === 'download').map((mapping) =>
        mapping.localPath
      )
    ),
  );
  for (const attempt of attemptedOrphanFiles) {
    try {
      if (await completedOrphanFileAttempt(attempt, configuredDownloadRoots)) {
        completedOrphanAttemptCount++;
      }
    } catch (error) {
      orphanAttemptErrors.push(
        `Orphan cleanup retry: ${error instanceof Error ? error.message : 'path check failed'}`,
      );
    }
  }
  for (const arr of arrTargets) {
    let record;
    try {
      record = await arr.client.lookup(id);
    } catch (error) {
      arrErrors.push(
        `${arr.instanceName}: ${error instanceof Error ? error.message : 'lookup failed'}`,
      );
      continue;
    }
    if (!record) {
      arrMediaIds.set(arr.instanceId, null);
      if (attemptedArrInstanceIds.has(arr.instanceId)) completedArrAttemptCount++;
      continue;
    }
    arrMediaIds.set(arr.instanceId, record.id);
    const verifiedStart = orphanFiles.length;
    let mediaFiles: ArrManagedFile[] | null;
    let extraFiles: ArrExtraFile[] | null;
    try {
      [mediaFiles, extraFiles] = await Promise.all([
        arr.client.type === 'sonarr'
          ? arr.client.mediaFiles(record.id)
          : arr.client.mediaFiles(record.id).catch(() => null),
        arr.client.extraFiles(record.id).catch(() => null),
      ]);
    } catch (error) {
      managedFileErrors.push(
        `${arr.instanceName}: ${
          error instanceof Error ? error.message : 'managed-file inventory lookup failed'
        }`,
      );
      resolvedArrTargets.push({
        instanceName: arr.instanceName,
        type: arr.client.type,
        title: record.title,
        path: record.path,
        seasons: record.seasons,
        mediaFiles: null,
        extraFiles: null,
      });
      continue;
    }
    resolvedArrTargets.push({
      instanceName: arr.instanceName,
      type: arr.client.type,
      title: record.title,
      path: record.path,
      seasons: record.seasons,
      mediaFiles,
      extraFiles: extraFiles?.map(({ relativePath, type }) => ({ relativePath, type })) ?? null,
    });
    try {
      const torrentAssociations = await arr.client.torrentAssociations(record.id);
      for (const association of torrentAssociations) {
        associationHashes.add(association.hash);
        const hashPaths = associationPaths.get(association.hash) ?? new Set<string>();
        if (association.sourcePath) hashPaths.add(association.sourcePath);
        associationPaths.set(association.hash, hashPaths);
        if (arr.client.type === 'sonarr' && association.sourcePath) {
          const key = `${arr.instanceId}:${association.hash}`;
          const evidence = sonarrAssociations.get(key) ?? {
            instanceId: arr.instanceId,
            instanceUrl: arr.instanceUrl,
            configurationUpdatedAt: arr.configurationUpdatedAt,
            seriesId: record.id,
            hash: association.hash,
            sourcePaths: [],
          };
          if (!evidence.sourcePaths.includes(association.sourcePath)) {
            evidence.sourcePaths.push(association.sourcePath);
          }
          sonarrAssociations.set(key, evidence);
        }
        if (association.sourcePath) {
          const trackedPaths = [
            ...(mediaFiles ?? []).map((file) => file.relativePath),
            ...(extraFiles ?? []).map((file) => file.relativePath),
          ];
          const currentManagedPaths = arr.client.type === 'sonarr'
            ? (mediaFiles ?? []).flatMap((file) =>
              file.path ? [{ path: file.path, id: file.id, size: file.size }] : []
            )
            : trackedPaths.flatMap((relativePath) => {
              const path = record.path ? appendRemotePath(record.path, relativePath) : null;
              return path ? [path] : [];
            });
          const verification = await verifyOrphanHardlink(
            arr.instanceName,
            association,
            arr.pathMappings,
            currentManagedPaths,
            { exactTwoLinks: arr.client.type === 'sonarr' },
          );
          if (verification) {
            sources.set(
              `${arr.instanceId}:${association.hash}:${association.sourcePath}:${association.importedPath}`,
              verification.source,
            );
            if (verification.file) orphanFiles.push(verification.file);
          }
          if (arr.client.type === 'radarr') {
            orphanFiles.push(
              ...await verifyTrackedHardlinks(
                record.path,
                trackedPaths,
                association,
                arr.pathMappings,
              ),
            );
          }
        }
      }
      if (arr.client.type === 'sonarr' && item.type === 'show' && mediaFiles !== null) {
        const snapshot = await arr.client.sonarrSeriesSnapshot(record.id);
        const inventory = canonicalSonarrInventory(snapshot);
        sonarrCandidates.push(buildSonarrReclamation(
          arr,
          record.id,
          id,
          inventory,
          await sonarrInventoryIdentity(inventory),
          orphanFiles.slice(verifiedStart),
        ));
      }
    } catch (error) {
      historyErrors.push(
        `${arr.instanceName}: ${error instanceof Error ? error.message : 'history lookup failed'}`,
      );
    }
  }

  let sonarrReclamation = sonarrCandidates.length === 1 ? sonarrCandidates[0] : undefined;
  if (sonarrCandidates.length > 1) {
    for (let index = orphanFiles.length - 1; index >= 0; index--) {
      if (orphanFiles[index]!.strictTwoLinkProof) orphanFiles.splice(index, 1);
    }
    sonarrReclamation = undefined;
    reclamationUnavailableReason =
      'More than one mapped Sonarr instance contains this series; hardlink data removal cannot be verified';
  }

  if (downloadTargets.length > 0 && arrErrors.length === 0 && associationHashes.size > 0) {
    for (const arr of arrTargets) {
      for (const hash of associationHashes) {
        try {
          if (
            !await arr.client.downloadIdIsExclusiveTo(arrMediaIds.get(arr.instanceId) ?? null, hash)
          ) {
            sharedAssociationHashes.add(hash);
          }
        } catch (error) {
          historyErrors.push(
            `${arr.instanceName}: ${
              error instanceof Error ? error.message : 'download history lookup failed'
            }`,
          );
        }
      }
    }
  }

  const publicSources = [...sources.values()];
  if (arrErrors.length > 0) {
    const reason = [...new Set(arrErrors)].join('; ');
    return {
      ratingKey,
      status: 'error',
      downloadJobs: [],
      reason,
      arrStatus: 'error',
      arrReason: reason,
      arrTargets: resolvedArrTargets,
      sources: publicSources,
      orphanFiles,
      retainedPaths: [...inspectionWarnings.values()],
      ...(sonarrReclamation ? { sonarrReclamation } : {}),
    };
  }
  if (resolvedArrTargets.length === 0 && completedArrAttemptCount === 0) {
    return {
      ratingKey,
      status: 'unavailable',
      downloadJobs: [],
      reason: 'The item was not found in any mapped Sonarr or Radarr instance',
      arrStatus: 'unavailable',
      arrReason: 'The item was not found in any mapped Sonarr or Radarr instance',
      arrTargets: [],
      sources: [],
      orphanFiles: [],
      retainedPaths: [...inspectionWarnings.values()],
      ...(sonarrReclamation ? { sonarrReclamation } : {}),
    };
  }
  if (orphanAttemptErrors.length > 0) {
    return {
      ratingKey,
      status: 'error',
      downloadJobs: [],
      reason: [...new Set(orphanAttemptErrors)].join('; '),
      arrStatus: 'resolved',
      arrTargets: resolvedArrTargets,
      sources: publicSources,
      orphanFiles: [],
      retainedPaths: [...inspectionWarnings.values()],
      ...(sonarrReclamation ? { sonarrReclamation } : {}),
    };
  }
  if (managedFileErrors.length > 0) {
    return {
      ratingKey,
      status: 'error',
      downloadJobs: [],
      reason: [...new Set(managedFileErrors)].join('; '),
      arrStatus: 'resolved',
      arrTargets: resolvedArrTargets,
      sources: publicSources,
      orphanFiles: [],
      retainedPaths: [...inspectionWarnings.values()],
    };
  }
  if (
    downloadTargets.length === 0 && orphanFiles.length === 0 &&
    completedOrphanAttemptCount === 0
  ) {
    return {
      ratingKey,
      status: 'unavailable',
      downloadJobs: [],
      reason: 'No download client connection is configured',
      arrStatus: 'resolved',
      arrTargets: resolvedArrTargets,
      sources: publicSources,
      orphanFiles: [],
      retainedPaths: [...inspectionWarnings.values()],
      ...(sonarrReclamation ? { sonarrReclamation } : {}),
    };
  }
  if (historyErrors.length > 0) {
    return {
      ratingKey,
      status: 'error',
      downloadJobs: [],
      reason: [...new Set(historyErrors)].join('; '),
      arrStatus: 'resolved',
      arrTargets: resolvedArrTargets,
      sources: publicSources,
      orphanFiles,
      retainedPaths: [...inspectionWarnings.values()],
      ...(sonarrReclamation ? { sonarrReclamation } : {}),
    };
  }

  const downloadJobs: ResolvedDownloadJob[] = [];
  const ownedLiveJobs: ResolvedDownloadJob[] = [];
  const observedDownloadJobKeys = new Set<string>();
  let completedAttemptCount = 0;
  let unownedLiveJobCount = 0;
  let nonExclusiveLiveJobCount = 0;
  const qbitErrors: string[] = [];
  for (const target of downloadTargets) {
    const instancePrefix = `${target.instanceKey}:`;
    const candidateHashes = new Set(associationHashes);
    for (const attemptedKey of attemptedDownloadJobKeys) {
      if (attemptedKey.startsWith(instancePrefix)) {
        candidateHashes.add(attemptedKey.slice(instancePrefix.length));
      }
    }
    for (const hash of candidateHashes) {
      const sourcePaths = associationPaths.get(hash) ?? new Set<string>();
      const sourcePath = sourcePaths.values().next().value ?? null;
      try {
        const job = await target.client.findJob(hash);
        if (!job) {
          if (attemptedDownloadJobKeys.has(`${target.instanceKey}:${hash}`)) {
            completedAttemptCount++;
          }
          continue;
        }
        if (![...sourcePaths].some((path) => downloadJobOwnsPath(job, path))) {
          // A hash can be re-added at a different save path, or appear in another
          // client instance. It is not the historical payload unless its full
          // manifest owns at least one exact Arr source path.
          unownedLiveJobCount++;
          continue;
        }
        const { id: _id, ...publicJob } = job;
        const wholeShowAssociations = [...sonarrAssociations.values()]
          .filter((association) => association.hash === hash)
          .map((association) => ({
            ...association,
            sourcePaths: [...association.sourcePaths].sort(),
          }))
          .sort((left, right) => left.instanceId - right.instanceId);
        const wholeShowSourcePaths = wholeShowAssociations.flatMap((association) =>
          association.sourcePaths
        );
        const wholeShowHashCandidate = options.allowWholeShowHash === true &&
          item.type === 'show' && target.provider === 'qbittorrent' &&
          Number.isSafeInteger(item.tvdbId) && item.tvdbId! > 0 &&
          wholeShowAssociations.length > 0;
        const canUseWholeShowHash = wholeShowHashCandidate && job.id === hash &&
          Number.isSafeInteger(job.fileCount) && job.fileCount > 0 &&
          Number.isSafeInteger(job.size) && job.size > 0 &&
          normalizeRemoteAbsolute(job.contentPath) !== null &&
          normalizeRemoteAbsolute(job.savePath) !== null &&
          job.fileCount === job.manifestFiles.length &&
          wholeShowSourcePaths.some((path) => downloadJobOwnsPath(job, path)) &&
          job.manifestFiles.every((file) =>
            typeof file.path === 'string' && file.path.length > 0 &&
            Number.isSafeInteger(file.size) && file.size! >= 0
          );
        if (wholeShowHashCandidate && !canUseWholeShowHash) {
          throw new Error('qBittorrent returned malformed whole-show download evidence');
        }
        const resolvedJob: ResolvedDownloadJob = {
          ...publicJob,
          provider: target.provider,
          jobId: hash,
          instanceKey: target.instanceKey,
          instanceName: target.instanceName,
          sourcePath: canUseWholeShowHash ? wholeShowSourcePaths[0]! : sourcePath,
          authorizedSourcePaths: canUseWholeShowHash ? wholeShowSourcePaths : [...sourcePaths],
          provenance: 'arr_history' as const,
          authorizationMode: canUseWholeShowHash ? 'whole_show_hash' : 'manifest_paths',
          ...(canUseWholeShowHash
            ? {
              sonarrAssociations: wholeShowAssociations,
              ownershipSummaryFingerprint: await downloadJobSummaryFingerprint(job),
              manifestFingerprint: await downloadJobManifestFingerprint(job),
            }
            : {}),
          target,
        };
        ownedLiveJobs.push(resolvedJob);
        observedDownloadJobKeys.add(`${target.instanceKey}:${hash}`);
        if (sharedAssociationHashes.has(hash)) {
          nonExclusiveLiveJobCount++;
          inspectionWarnings.set(job.contentPath || job.savePath, {
            path: job.contentPath || job.savePath,
            reason:
              'Arr history associates this download with another title; the shared job and payload are retained',
          });
          continue;
        }
        if (!canUseWholeShowHash && !downloadPayloadIsExclusivelyOwned(job, sourcePaths)) {
          nonExclusiveLiveJobCount++;
          inspectionWarnings.set(job.contentPath || job.savePath, {
            path: job.contentPath || job.savePath,
            reason:
              'Live download job contains files that are not individually attributed to this selected Arr title; the job and payload are retained',
          });
          continue;
        }
        downloadJobs.push(resolvedJob);
      } catch (error) {
        qbitErrors.push(
          `${target.instanceName}: ${error instanceof Error ? error.message : 'lookup failed'}`,
        );
      }
    }
  }

  if (qbitErrors.length > 0) {
    return {
      ratingKey,
      status: 'error',
      downloadJobs,
      reason: [...new Set(qbitErrors)].join('; '),
      arrStatus: 'resolved',
      arrTargets: resolvedArrTargets,
      sources: publicSources,
      orphanFiles,
      retainedPaths: [...inspectionWarnings.values()],
      observedDownloadJobKeys,
      ...(sonarrReclamation ? { sonarrReclamation } : {}),
    };
  }
  // Never unlink a file underneath a live job that was retained because its complete
  // payload could not be attributed. A download client could otherwise restore the file, and
  // the user would still have an active job with a partially removed payload.
  const directOrphanFiles = selectDirectOrphanFiles(orphanFiles, ownedLiveJobs);
  const executableReclamation = sonarrReclamation;
  const retainedPaths = [...new Map([
    ...inspectionWarnings.values(),
    ...await findRetainedSiblingPaths(
      directOrphanFiles,
      undefined,
      payloadScanBudget,
    ),
  ].map((entry) => [entry.path, entry])).values()];
  if (
    downloadJobs.length > 0 || completedAttemptCount > 0 || directOrphanFiles.length > 0 ||
    completedOrphanAttemptCount > 0
  ) {
    return {
      ratingKey,
      status: 'resolved',
      downloadJobs,
      ...(downloadJobs.length === 0 && directOrphanFiles.length === 0
        ? {
          reason: completedOrphanAttemptCount > 0
            ? 'Downloaded-file cleanup was previously started and the verified path is now absent'
            : 'Download cleanup was previously started and the job is now absent',
        }
        : {}),
      arrStatus: 'resolved',
      arrTargets: resolvedArrTargets,
      sources: publicSources,
      orphanFiles: directOrphanFiles,
      retainedPaths,
      observedDownloadJobKeys,
      ...(executableReclamation && executableReclamation.proofs.length > 0
        ? { sonarrReclamation: executableReclamation }
        : {}),
    };
  }
  return {
    ratingKey,
    status: 'unavailable',
    downloadJobs: [],
    reason: reclamationUnavailableReason ??
      (associationHashes.size === 0
        ? 'Arr has no retained download import history for this item'
        : nonExclusiveLiveJobCount > 0
        ? 'A matching live download contains files that are not all attributable to this Arr title'
        : unownedLiveJobCount > 0
        ? 'A matching download ID exists, but its manifest does not own the historical source path'
        : 'The imported download is no longer present in configured download clients'),
    arrStatus: 'resolved',
    arrTargets: resolvedArrTargets,
    sources: publicSources,
    orphanFiles: [],
    retainedPaths,
    observedDownloadJobKeys,
    ...(sonarrReclamation ? { sonarrReclamation } : {}),
  };
}

export function selectDirectOrphanFiles(
  files: readonly VerifiedOrphanFile[],
  jobs: readonly ResolvedDownloadJob[],
): VerifiedOrphanFile[] {
  return [
    ...new Map(
      files.filter((file) =>
        !jobs.some((job) => job.jobId === file.hash && downloadJobOwnsPath(job, file.remotePath))
      ).map((file) => [file.path, file]),
    ).values(),
  ];
}

export function publicCleanupItem(item: ResolvedCleanupItem): CleanupItemWithoutPlexPaths {
  return {
    ratingKey: item.ratingKey,
    status: item.status,
    reason: item.reason,
    downloadJobs: item.downloadJobs.map(({
      target: _target,
      manifestFiles: _manifestFiles,
      authorizedSourcePaths: _authorizedSourcePaths,
      directPathEvidence: _directPathEvidence,
      directPlexPathEvidence: _directPlexPathEvidence,
      directRetainedPathEvidence: _directRetainedPathEvidence,
      provenance: _provenance,
      authorizationMode: _authorizationMode,
      sonarrAssociations: _sonarrAssociations,
      discoverySummaryFingerprint: _discoverySummaryFingerprint,
      ownershipSummaryFingerprint: _ownershipSummaryFingerprint,
      manifestFingerprint: _manifestFingerprint,
      directDiscoveryCandidates: _directDiscoveryCandidates,
      directPathMappings: _directPathMappings,
      ...job
    }) => job),
    arrStatus: item.arrStatus,
    arrReason: item.arrReason,
    arrTargets: item.arrTargets.map((target) => ({
      ...target,
      mediaFiles: target.mediaFiles?.map(({ relativePath, size }) => ({ relativePath, size })) ??
        null,
    })),
    sources: item.sources,
    orphanFiles: item.orphanFiles.map(({ path, size, method }) => ({ path, size, method })),
    retainedPaths: item.retainedPaths,
    sonarrHistoricalPaths: publicSonarrHistoricalPaths(item),
  };
}
