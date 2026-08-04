import type { PlexMediaVersionPathPreview } from '../../integrations/plex/types.ts';
import type { ArrExtraFile, ArrMediaRecord } from '../../integrations/arr/client.ts';
import type { ArrDeleteTarget, CoordinatedDeleteItem } from '../arr/delete.ts';
import { arrDirname, arrPathIsWithin, resolveArrPath } from './arrPaths.ts';
import { normalizeRemoteAbsolute } from './hardlinks.ts';
import { appendRemotePath } from './ownership.ts';

export interface EligibleArrReassignment {
  target: ArrDeleteTarget;
  recordId: number;
  recordPath: string;
  episodeId: number | null;
  managedFileId: number | null;
  managedFileSize: number | null;
  managedPath: string | null;
  managedMediaId: number | null;
  candidatePaths: Map<number, string>;
  candidateRecordPaths: Map<number, string>;
  candidateFileSizes: Map<number, number | null>;
  alreadyReassigned: boolean;
}

export interface PersistedArrMappingIdentity {
  instanceId: number;
  instanceType: 'radarr' | 'sonarr';
  instanceUrl: string;
  configurationUpdatedAt: number;
  mappingIdentity: string;
}

export interface PersistedArrReassignment extends PersistedArrMappingIdentity {
  recordId: number;
  recordPath: string;
  episodeId: number | null;
  managedFileId: number;
  managedPath: string;
  retainedMediaId: number;
  retainedPath: string;
  retainedRecordPath?: string;
  retainedFileSize?: number | null;
}

export interface PersistedArrOwnership {
  instanceId: number;
  recordId: number | null;
  episodeId: number | null;
  managedFileId: number | null;
  managedPath: string | null;
  managedMediaId: number | null;
}

export interface ArrReassignmentPlanningResult {
  eligibleArrReassignments: EligibleArrReassignment[];
  arrMappingIdentities: PersistedArrMappingIdentity[];
  arrOwnerships: PersistedArrOwnership[];
  arrOwnershipValid: boolean;
  arrOwnershipReason?: string;
  arrManagedMediaIds: number[];
  arrReassignCandidateMediaIds: number[];
  arrReassignStatus: 'resolved' | 'unavailable' | 'error';
  arrReassignReason?: string;
}

function normalizedComparison(path: string): string | null {
  return normalizeRemoteAbsolute(path)?.comparison ?? null;
}

function conservativeComparison(path: string): string | null {
  return normalizeRemoteAbsolute(path)?.path.toLocaleLowerCase('en-US') ?? null;
}

function ownershipMatches(
  expected: PersistedArrOwnership,
  actual: PersistedArrOwnership,
): boolean {
  return expected.instanceId === actual.instanceId &&
    expected.recordId === actual.recordId &&
    expected.episodeId === actual.episodeId &&
    expected.managedFileId === actual.managedFileId &&
    expected.managedMediaId === actual.managedMediaId &&
    (
      expected.managedPath === actual.managedPath ||
      (
        expected.managedPath !== null && actual.managedPath !== null &&
        normalizedComparison(expected.managedPath) === normalizedComparison(actual.managedPath)
      )
    );
}

export async function buildArrReassignmentPlan({
  mediaType,
  item,
  selectedMediaIds,
  liveVersions,
  arrTargets,
  episodeIdentity,
  excludedReassignMediaIds = selectedMediaIds,
  requiredMappingIdentities,
  requiredReassignments = new Map<number, PersistedArrReassignment>(),
  requiredOwnerships = new Map<number, PersistedArrOwnership>(),
  lookupRecords = new Map<number, ArrMediaRecord | null>(),
  radarrExtraFiles = new Map<number, readonly ArrExtraFile[] | Error>(),
}: {
  mediaType: 'movie' | 'episode';
  item: CoordinatedDeleteItem;
  selectedMediaIds: ReadonlySet<number>;
  liveVersions: readonly PlexMediaVersionPathPreview[];
  arrTargets: readonly ArrDeleteTarget[];
  episodeIdentity?: { seasonNumber: number; episodeNumber: number };
  excludedReassignMediaIds?: ReadonlySet<number>;
  requiredMappingIdentities?: readonly PersistedArrMappingIdentity[];
  requiredReassignments?: ReadonlyMap<number, PersistedArrReassignment>;
  requiredOwnerships?: ReadonlyMap<number, PersistedArrOwnership>;
  lookupRecords?: ReadonlyMap<number, ArrMediaRecord | null>;
  radarrExtraFiles?: ReadonlyMap<number, readonly ArrExtraFile[] | Error>;
}): Promise<ArrReassignmentPlanningResult> {
  const selectedVersions = [...selectedMediaIds].map((mediaId) =>
    liveVersions.find((version) => version.mediaId === mediaId)
  );
  const reassignPathsComplete = liveVersions.every((version) => !version.truncated) &&
    (
      selectedVersions.every((version) =>
        version !== undefined && version.paths.length > 0 && !version.truncated
      ) ||
      requiredReassignments.size > 0 || requiredOwnerships.size > 0
    );

  const eligibleArrReassignments: EligibleArrReassignment[] = [];
  const arrOwnerships: PersistedArrOwnership[] = [];
  const arrReassignErrors: string[] = [];
  const arrReassignUnsafeReasons: string[] = [];
  const managedMediaIds = new Set<number>();
  const arrMappingIdentities = arrTargets.filter((target) =>
    (mediaType === 'movie' && target.client.type === 'radarr') ||
    (mediaType === 'episode' && target.client.type === 'sonarr')
  ).map((target) => ({
    instanceId: target.instanceId,
    instanceType: target.instanceType,
    instanceUrl: target.instanceUrl,
    configurationUpdatedAt: target.configurationUpdatedAt,
    mappingIdentity: target.mappingIdentity,
  })).sort((left, right) => left.instanceId - right.instanceId);
  if (
    requiredMappingIdentities !== undefined &&
    JSON.stringify(arrMappingIdentities) !== JSON.stringify(requiredMappingIdentities)
  ) {
    arrReassignUnsafeReasons.push('The mapped Arr instance set changed');
  }
  const retainedIds = new Set(
    [...requiredReassignments.values()].map((entry) => entry.retainedMediaId),
  );
  const requiredRetainedMediaId = retainedIds.size === 1 ? [...retainedIds][0] : undefined;
  if (retainedIds.size > 1) {
    arrReassignUnsafeReasons.push('The persisted Arr reassignment target is inconsistent');
  }
  const externalId = mediaType === 'movie' ? item.tmdbId : item.tvdbId;
  if (!reassignPathsComplete) {
    arrReassignUnsafeReasons.push(
      'Plex returned more version paths than the bounded preview can verify',
    );
  } else if (externalId === null) {
    arrReassignUnsafeReasons.push(
      `No ${mediaType === 'movie' ? 'TMDB' : 'TVDB'} ID is available for ${
        mediaType === 'movie' ? 'Radarr' : 'Sonarr'
      } lookup`,
    );
  } else if (mediaType === 'episode' && !episodeIdentity) {
    arrReassignUnsafeReasons.push('The Sonarr episode identity is incomplete');
  } else {
    for (const target of arrTargets) {
      if (
        (mediaType === 'movie' && target.client.type !== 'radarr') ||
        (mediaType === 'episode' && target.client.type !== 'sonarr')
      ) continue;
      try {
        const required = requiredReassignments.get(target.instanceId);
        const requiredOwnership = requiredOwnerships.get(target.instanceId);
        if (
          required &&
          (target.instanceType !== required.instanceType ||
            target.instanceUrl !== required.instanceUrl ||
            target.configurationUpdatedAt !== required.configurationUpdatedAt ||
            target.mappingIdentity !== required.mappingIdentity)
        ) {
          arrReassignUnsafeReasons.push(
            `${target.instanceName} Arr or mapping configuration changed`,
          );
          continue;
        }
        const lookupRecord = lookupRecords.has(target.instanceId)
          ? lookupRecords.get(target.instanceId)!
          : await target.client.lookup(externalId);
        const record = lookupRecord && mediaType === 'movie'
          ? { ...lookupRecord, ...(await target.client.radarrMovie(lookupRecord.id)) }
          : lookupRecord;
        if (!record) {
          const ownership = {
            instanceId: target.instanceId,
            recordId: null,
            episodeId: null,
            managedFileId: null,
            managedPath: null,
            managedMediaId: null,
          } satisfies PersistedArrOwnership;
          arrOwnerships.push(ownership);
          if (required || (requiredOwnership && !ownershipMatches(requiredOwnership, ownership))) {
            arrReassignUnsafeReasons.push(
              `${target.instanceName} no longer has the required managed record`,
            );
          }
          continue;
        }
        if (required && record.id !== required.recordId) {
          arrReassignUnsafeReasons.push(
            `${target.instanceName} returned a different managed record`,
          );
          continue;
        }
        let managedFile;
        let episodeId: number | null = null;
        let episodeFileShared = false;
        let arrRecordExists = false;
        if (mediaType === 'movie') {
          managedFile = await target.client.radarrManagedFile(record.id);
          arrRecordExists = true;
        } else {
          const managedEpisode = await target.client.episodeManagedFile(
            record.id,
            episodeIdentity!.seasonNumber,
            episodeIdentity!.episodeNumber,
          );
          episodeId = managedEpisode?.episodeId ?? null;
          managedFile = managedEpisode?.file ?? null;
          episodeFileShared = managedEpisode?.shared === true;
          arrRecordExists = managedEpisode !== null;
        }
        if (!arrRecordExists) {
          const ownership = {
            instanceId: target.instanceId,
            recordId: record.id,
            episodeId: null,
            managedFileId: null,
            managedPath: null,
            managedMediaId: null,
          } satisfies PersistedArrOwnership;
          arrOwnerships.push(ownership);
          if (required || (requiredOwnership && !ownershipMatches(requiredOwnership, ownership))) {
            arrReassignUnsafeReasons.push(
              `${target.instanceName} no longer has the required episode record`,
            );
          }
          continue;
        }
        if (required && episodeId !== required.episodeId) {
          arrReassignUnsafeReasons.push(
            `${target.instanceName} returned a different managed episode`,
          );
          continue;
        }
        const managedPath = managedFile?.path ??
          (managedFile && record.path
            ? appendRemotePath(record.path, managedFile.relativePath)
            : null);
        const normalizedManagedPath = managedPath ? normalizedComparison(managedPath) : null;
        const resolvedVersions = liveVersions.map((version) => ({
          version,
          paths: version.paths.flatMap((path) => {
            const resolved = resolveArrPath(path, 'library', target.pathMappings);
            return resolved ? [resolved] : [];
          }),
        }));
        if (
          resolvedVersions.some((candidate) =>
            candidate.version.paths.length === 0 ||
            candidate.paths.length !== candidate.version.paths.length
          )
        ) {
          arrReassignUnsafeReasons.push(
            `${target.instanceName} could not resolve every known Plex version path safely`,
          );
          continue;
        }
        const resolvedPathOwners = new Map<string, Set<number>>();
        const conservativePathOwners = new Map<string, Set<number>>();
        for (const resolvedVersion of resolvedVersions) {
          for (const path of resolvedVersion.paths) {
            const normalized = normalizedComparison(path);
            if (!normalized) continue;
            const owners = resolvedPathOwners.get(normalized) ?? new Set<number>();
            owners.add(resolvedVersion.version.mediaId);
            resolvedPathOwners.set(normalized, owners);
            const conservative = conservativeComparison(path);
            if (conservative) {
              const conservativeOwners = conservativePathOwners.get(conservative) ??
                new Set<number>();
              conservativeOwners.add(resolvedVersion.version.mediaId);
              conservativePathOwners.set(conservative, conservativeOwners);
            }
          }
        }
        if ([...conservativePathOwners.values()].some((owners) => owners.size > 1)) {
          arrReassignUnsafeReasons.push(
            `${target.instanceName} has Plex version paths that differ only by case`,
          );
          continue;
        }
        const matchingManagedVersions = normalizedManagedPath
          ? resolvedVersions.filter((candidate) =>
            candidate.paths.some((path) => normalizedComparison(path) === normalizedManagedPath)
          )
          : [];
        if (matchingManagedVersions.length > 1) {
          arrReassignUnsafeReasons.push(
            `${target.instanceName} managed path matches multiple Plex versions`,
          );
          continue;
        }
        const liveSelectedVersions = resolvedVersions.filter((candidate) =>
          selectedMediaIds.has(candidate.version.mediaId)
        );
        const selectedPathsResolved = liveSelectedVersions.every((candidate) =>
          candidate.version.paths.length > 0 &&
          candidate.paths.length === candidate.version.paths.length
        );
        const hasPersistedOwnershipEvidence = required !== undefined ||
          requiredOwnership !== undefined;
        if (
          managedFile &&
          (
            normalizedManagedPath === null ||
            !selectedPathsResolved ||
            (!hasPersistedOwnershipEvidence &&
              liveSelectedVersions.length !== selectedMediaIds.size)
          )
        ) {
          arrReassignUnsafeReasons.push(
            `${target.instanceName} managed path ownership could not be resolved safely`,
          );
          continue;
        }
        const managedVersion = matchingManagedVersions[0]?.version;
        const managedResolvedPaths = matchingManagedVersions[0]?.paths ?? [];
        const ownership = {
          instanceId: target.instanceId,
          recordId: record.id,
          episodeId,
          managedFileId: managedFile?.id ?? null,
          managedPath,
          managedMediaId: managedVersion?.mediaId ?? null,
        } satisfies PersistedArrOwnership;
        arrOwnerships.push(ownership);
        if (requiredOwnership && !required && !ownershipMatches(requiredOwnership, ownership)) {
          arrReassignUnsafeReasons.push(
            `${target.instanceName} changed its managed ownership`,
          );
          continue;
        }
        const managesSelectedVersion = managedVersion !== undefined &&
          selectedMediaIds.has(managedVersion.mediaId);
        if (managesSelectedVersion) {
          managedMediaIds.add(managedVersion.mediaId);
        }
        if (
          managesSelectedVersion &&
          (
            managedVersion.paths.length !== 1 ||
            managedResolvedPaths.length !== 1 ||
            normalizedComparison(managedResolvedPaths[0]!) !== normalizedManagedPath
          )
        ) {
          arrReassignUnsafeReasons.push(
            `${target.instanceName} managed Plex version does not have one exact file path`,
          );
          continue;
        }
        if (episodeFileShared && managesSelectedVersion) {
          arrReassignUnsafeReasons.push(
            `${target.instanceName} managed file is shared by multiple episode records`,
          );
          continue;
        }
        if (mediaType === 'movie' && (managesSelectedVersion || required !== undefined)) {
          const cachedExtras = radarrExtraFiles.get(target.instanceId);
          if (cachedExtras instanceof Error) throw cachedExtras;
          const extras = cachedExtras ?? await target.client.extraFiles(record.id);
          const selectedManagedFileId = required?.managedFileId ?? managedFile?.id;
          if (extras.some((extra) => extra.movieFileId === selectedManagedFileId)) {
            arrReassignUnsafeReasons.push(
              `${target.instanceName} has extra files linked to the selected managed file`,
            );
            continue;
          }
        }
        if (!required && !managesSelectedVersion) continue;
        if (required) {
          const normalizedRecordPath = normalizedComparison(record.path ?? '');
          const normalizedOriginalRoot = normalizedComparison(required.recordPath);
          const normalizedRetainedRoot = normalizedComparison(
            required.retainedRecordPath ?? required.recordPath,
          );
          if (
            normalizedRecordPath === null ||
            (mediaType === 'movie'
              ? normalizedRecordPath !== normalizedOriginalRoot
              : normalizedRecordPath !== normalizedOriginalRoot &&
                normalizedRecordPath !== normalizedRetainedRoot)
          ) {
            arrReassignUnsafeReasons.push(
              `${target.instanceName} changed its managed root path`,
            );
            continue;
          }
          if (managedFile) {
            const stillOriginal = managedFile.id === required.managedFileId &&
              normalizedManagedPath === normalizedComparison(required.managedPath);
            const alreadyRetained = normalizedManagedPath ===
              normalizedComparison(required.retainedPath);
            if (!stillOriginal && !alreadyRetained) {
              arrReassignUnsafeReasons.push(
                `${target.instanceName} changed its managed file`,
              );
              continue;
            }
          }
        }
        if (
          required && managedVersion !== undefined &&
          managedVersion.mediaId !== requiredRetainedMediaId &&
          !managesSelectedVersion
        ) {
          arrReassignUnsafeReasons.push(
            `${target.instanceName} changed to a different managed Plex version`,
          );
          continue;
        }
        if (!record.path) {
          arrReassignUnsafeReasons.push(
            `${target.instanceName} returned a record without a managed path`,
          );
          continue;
        }
        if (normalizedComparison(record.path) === null) {
          arrReassignUnsafeReasons.push(
            `${target.instanceName} returned an invalid absolute managed path`,
          );
          continue;
        }
        const candidatePaths = new Map<number, string>();
        const candidateRecordPaths = new Map<number, string>();
        const candidateFileSizes = new Map<number, number | null>();
        for (const { version, paths } of resolvedVersions) {
          if (excludedReassignMediaIds.has(version.mediaId) || version.truncated) continue;
          if (version.paths.length !== 1 || paths.length !== 1) continue;
          const normalizedPath = normalizedComparison(paths[0]!);
          if (
            normalizedPath === null ||
            resolvedPathOwners.get(normalizedPath)?.size !== 1 ||
            !resolvedPathOwners.get(normalizedPath)?.has(version.mediaId)
          ) continue;
          if (mediaType === 'episode' && !arrPathIsWithin(paths[0]!, record.path)) continue;
          if (
            mediaType === 'movie' &&
            normalizedComparison(arrDirname(paths[0]!) ?? '') !== normalizedComparison(record.path)
          ) continue;
          const candidateRecordPath = mediaType === 'movie' ? arrDirname(paths[0]!) : record.path;
          if (candidateRecordPath === null) continue;
          const candidateSize = mediaType === 'movie'
            ? version.projectedFileSize ?? null
            : version.fileSize ?? null;
          if (
            mediaType === 'movie' &&
            (!Number.isSafeInteger(candidateSize) || candidateSize! < 0)
          ) continue;
          if (
            mediaType === 'movie' &&
            resolvedVersions.some((other) =>
              other.version.mediaId !== managedVersion?.mediaId &&
              other.version.mediaId !== version.mediaId &&
              other.paths.some((path) => arrPathIsWithin(path, record.path!))
            )
          ) continue;
          if (
            mediaType === 'movie' &&
            await target.client.fileVisibility(paths[0]!) !== 'file'
          ) continue;
          candidatePaths.set(version.mediaId, paths[0]!);
          candidateRecordPaths.set(version.mediaId, candidateRecordPath);
          candidateFileSizes.set(version.mediaId, candidateSize);
        }
        if (candidatePaths.size === 0) {
          arrReassignUnsafeReasons.push(
            mediaType === 'episode'
              ? `${target.instanceName} cannot adopt a retained copy outside its managed series folder`
              : `${target.instanceName} has no visible retained Plex version in its exact current movie folder with known size and no competing file`,
          );
          continue;
        }
        if (
          requiredRetainedMediaId !== undefined &&
          !candidatePaths.has(requiredRetainedMediaId)
        ) {
          arrReassignUnsafeReasons.push(
            `${target.instanceName} can no longer adopt the persisted retained version`,
          );
          continue;
        }
        if (
          required &&
          normalizedComparison(candidatePaths.get(required.retainedMediaId) ?? '') !==
            normalizedComparison(required.retainedPath)
        ) {
          arrReassignUnsafeReasons.push(
            `${target.instanceName} retained Plex path changed`,
          );
          continue;
        }
        if (
          required &&
          normalizedComparison(candidateRecordPaths.get(required.retainedMediaId) ?? '') !==
            normalizedComparison(
              required.retainedRecordPath ??
                (mediaType === 'movie'
                  ? arrDirname(required.retainedPath) ?? ''
                  : required.recordPath),
            )
        ) {
          arrReassignUnsafeReasons.push(
            `${target.instanceName} retained managed root changed`,
          );
          continue;
        }
        const retainedRecordPath = requiredRetainedMediaId === undefined
          ? undefined
          : candidateRecordPaths.get(requiredRetainedMediaId);
        const alreadyReassigned = requiredRetainedMediaId !== undefined &&
          managedVersion?.mediaId === requiredRetainedMediaId &&
          retainedRecordPath !== undefined &&
          normalizedComparison(record.path) === normalizedComparison(retainedRecordPath);
        eligibleArrReassignments.push({
          target,
          recordId: record.id,
          recordPath: record.path,
          episodeId,
          managedFileId: managedFile?.id ?? null,
          managedFileSize: managedFile?.size ?? null,
          managedPath,
          managedMediaId: managedVersion?.mediaId ?? null,
          candidatePaths,
          candidateRecordPaths,
          candidateFileSizes,
          alreadyReassigned,
        });
      } catch (error) {
        arrReassignErrors.push(
          `${target.instanceName}: ${error instanceof Error ? error.message : 'lookup failed'}`,
        );
      }
    }
  }

  const eligibleReassignInstanceIds = new Set(
    eligibleArrReassignments.map((entry) => entry.target.instanceId),
  );
  const mediaIdsManagedByOtherInstances = new Set(
    arrOwnerships.flatMap((ownership) =>
      ownership.managedMediaId !== null &&
        !eligibleReassignInstanceIds.has(ownership.instanceId)
        ? [ownership.managedMediaId]
        : []
    ),
  );
  for (const instanceId of requiredReassignments.keys()) {
    if (!eligibleReassignInstanceIds.has(instanceId)) {
      arrReassignUnsafeReasons.push(
        'Not every required Arr instance can be verified for reassignment',
      );
      break;
    }
  }
  const observedOwnershipInstanceIds = new Set(arrOwnerships.map((entry) => entry.instanceId));
  for (const instanceId of requiredOwnerships.keys()) {
    if (!observedOwnershipInstanceIds.has(instanceId)) {
      arrReassignUnsafeReasons.push('Not every required Arr ownership can be verified');
      break;
    }
  }
  let commonReassignCandidates = new Set<number>();
  if (eligibleArrReassignments.length > 0) {
    commonReassignCandidates = new Set(eligibleArrReassignments[0]!.candidatePaths.keys());
    for (const entry of eligibleArrReassignments.slice(1)) {
      for (const id of commonReassignCandidates) {
        if (!entry.candidatePaths.has(id)) commonReassignCandidates.delete(id);
      }
    }
    for (const id of mediaIdsManagedByOtherInstances) {
      commonReassignCandidates.delete(id);
    }
    if (commonReassignCandidates.size === 0) {
      eligibleArrReassignments.length = 0;
      arrReassignUnsafeReasons.push(
        mediaIdsManagedByOtherInstances.size > 0
          ? 'Every retained Plex version is already managed by another mapped Arr instance'
          : 'Mapped Arr instances do not share one safe retained version target',
      );
    }
    if (requiredRetainedMediaId === undefined && managedMediaIds.size !== 1) {
      eligibleArrReassignments.length = 0;
      commonReassignCandidates.clear();
      arrReassignUnsafeReasons.push(
        'Mapped Arr instances do not agree on the currently managed Plex version',
      );
    }
  }
  const arrReassignStatus = arrReassignErrors.length === 0 &&
      arrReassignUnsafeReasons.length === 0 &&
      eligibleArrReassignments.length > 0 &&
      commonReassignCandidates.size > 0
    ? 'resolved' as const
    : arrReassignErrors.length > 0
    ? 'error' as const
    : 'unavailable' as const;
  const arrReassignReason = arrReassignStatus === 'error'
    ? arrReassignErrors.join('; ')
    : arrReassignStatus === 'unavailable'
    ? arrReassignUnsafeReasons[0] ??
      `The selected deletion does not include a ${
        mediaType === 'movie' ? 'Radarr' : 'Sonarr'
      }-managed copy`
    : undefined;
  const arrOwnershipValid = arrReassignErrors.length === 0 &&
    arrReassignUnsafeReasons.length === 0;
  const arrOwnershipReason = arrReassignErrors[0] ?? arrReassignUnsafeReasons[0];

  return {
    eligibleArrReassignments,
    arrMappingIdentities,
    arrOwnerships: arrOwnerships.sort((left, right) => left.instanceId - right.instanceId),
    arrOwnershipValid,
    ...(arrOwnershipReason ? { arrOwnershipReason } : {}),
    arrManagedMediaIds: [...managedMediaIds].sort((a, b) => a - b),
    arrReassignCandidateMediaIds: [...commonReassignCandidates].sort((a, b) => a - b),
    arrReassignStatus,
    ...(arrReassignReason ? { arrReassignReason } : {}),
  };
}
