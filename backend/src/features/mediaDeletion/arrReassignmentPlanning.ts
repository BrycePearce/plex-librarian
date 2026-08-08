import type { PlexMediaVersionPathPreview } from '../../integrations/plex/types.ts';
import type { PlexClient } from '../../integrations/plex/client.ts';
import type { ArrExtraFile, ArrMediaRecord } from '../../integrations/arr/client.ts';
import type { RadarrPathAdoptionPreview } from '@plex-librarian/shared/types.ts';
import type { ArrDeleteTarget, CoordinatedDeleteItem } from '../arr/delete.ts';
import { arrBasename, arrDirname, arrPathIsWithin, resolveArrPath } from './arrPaths.ts';
import { normalizeRemoteAbsolute } from './hardlinks.ts';
import { appendRemotePath } from './ownership.ts';
import { withTransaction } from '../../db/index.ts';
import {
  loadPlexNamespaceMappings,
  type PersistedPathNamespaceEvidence,
  type PersistedPhysicalIdentityEvidence,
  provePhysicalDeletionIndependence,
  resolvePathNamespace,
} from './pathNamespace.ts';
import {
  bestMediaVersionCandidate,
  type MediaVersionQualityCandidate,
} from '@plex-librarian/shared/mediaVersionRanking.ts';

type ArrReassignmentDecisionCode =
  | 'retained_parent_mismatch'
  | 'external_error'
  | 'ordinary_reassignment_available'
  | 'other_unsafe';

export interface EligibleArrReassignment {
  target: ArrDeleteTarget;
  recordId: number;
  recordPath: string;
  episodeId: number | null;
  managedFileId: number | null;
  managedFileSize: number | null;
  managedPath: string | null;
  managedMediaId: number | null;
  monitored: boolean;
  candidatePaths: Map<number, string>;
  candidateRecordPaths: Map<number, string>;
  candidateFileSizes: Map<number, number | null>;
  alreadyReassigned: boolean;
  radarrPathPlan?: PersistedRadarrPathPlan;
  radarrPathPlans?: Map<number, PersistedRadarrPathPlan>;
}

export interface PersistedRadarrPathPlan {
  // The consent mode is accepted only for legacy persisted operations. New planning never emits it.
  mode: 'existing_path' | 'adopt_safe_path' | 'adopt_path_with_consent';
  arrInstanceId: number;
  movieId: number;
  retainedMediaId: number;
  originalMoviePath: string;
  targetMoviePath: string;
  retainedPath: string;
  originalMonitored: boolean;
  originalMovieFile: {
    id: number;
    path: string;
    relativePath: string;
    size: number;
  };
  adoptedMovieFile?: {
    id: number;
    path: string;
    relativePath: string;
    size: number;
  };
  pathOwnership: 'ordinary_radarr_library' | 'explicit_user_managed_location';
  userAuthorizedPathManagement: boolean;
  planFingerprint?: string;
  radarrBehaviorFingerprint: string;
  radarrVersion: string;
  behaviorSummary: {
    deleteEmptyFolders: boolean;
    fileDate: string;
    metadataConsumerCount: number;
    notificationConsumerCount: number;
  };
  namespaceEvidence: {
    selected: PersistedPathNamespaceEvidence;
    retained: PersistedPathNamespaceEvidence;
    libraryLocations: PersistedPathNamespaceEvidence[];
  };
  physicalIdentityEvidence: PersistedPhysicalIdentityEvidence;
  transition?: {
    monitoringProtectionAttemptedAt?: number;
    monitoringProtectedAt?: number;
    pathUpdateAttemptedAt?: number;
    pathConfirmedAt?: number;
    rescanAttemptedAt?: number;
    rescanCommandId?: number;
    rescanCommandStatus?: string;
    adoptedAt?: number;
    monitoringRestoredAt?: number;
  };
}

export interface PersistedRadarrRemovalFallback {
  mode: 'remove_from_radarr';
  arrInstanceId: number;
  arrConfigurationUpdatedAt: number;
  arrMappingIdentity: string;
  movieId: number;
  tmdbId: number;
  movieTitle: string;
  movieYear: number;
  selectedMediaId: number;
  retainedMediaId: number;
  selectedPlexPath: string;
  managedPath: string;
  retainedPlexPath: string;
  retainedFileSize: number;
  originalMoviePath: string;
  originalMonitored: boolean;
  createImportExclusion: true;
  deleteFiles: false;
  addImportExclusion: true;
  userAuthorizedRadarrRemoval: true;
  planFingerprint: string;
  exclusionPreexisting?: boolean;
  createdExclusionId?: number;
  transition?: {
    monitoringProtectionAttemptedAt?: number;
    monitoringProtectedAt?: number;
    exclusionCreationAttemptedAt?: number;
    exclusionConfirmedAt?: number;
    removalAttemptedAt?: number;
    movieAbsenceConfirmedAt?: number;
    plexDeletionAttemptedAt?: number;
    retainedSurvivalConfirmedAt?: number;
  };
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
  originalMonitored: boolean;
  radarrPathPlan?: PersistedRadarrPathPlan;
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
  radarrPathAdoption: RadarrPathAdoptionPreview;
}

class DecisionMessages extends Array<string> {
  constructor(
    private readonly code: ArrReassignmentDecisionCode,
    private readonly codes: ArrReassignmentDecisionCode[],
  ) {
    super();
  }

  override push(...messages: string[]): number {
    this.codes.push(...messages.map(() => this.code));
    return super.push(...messages);
  }
}

function normalizedComparison(path: string): string | null {
  return normalizeRemoteAbsolute(path)?.comparison ?? null;
}

function conservativeComparison(path: string): string | null {
  return normalizeRemoteAbsolute(path)?.path.toLocaleLowerCase('en-US') ?? null;
}

function ownershipMatches(expected: PersistedArrOwnership, actual: PersistedArrOwnership): boolean {
  return (
    expected.instanceId === actual.instanceId &&
    expected.recordId === actual.recordId &&
    expected.episodeId === actual.episodeId &&
    expected.managedFileId === actual.managedFileId &&
    expected.managedMediaId === actual.managedMediaId &&
    (expected.managedPath === actual.managedPath ||
      (expected.managedPath !== null &&
        actual.managedPath !== null &&
        normalizedComparison(expected.managedPath) === normalizedComparison(actual.managedPath)))
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
        .join(',')
    }}`;
  }
  return JSON.stringify(value);
}

async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function pathsOverlap(left: string, right: string): boolean {
  const a = normalizeRemoteAbsolute(left);
  const b = normalizeRemoteAbsolute(right);
  if (!a || !b || a.separator !== b.separator) return true;
  const leftPath = a.path.toLocaleLowerCase('en-US');
  const rightPath = b.path.toLocaleLowerCase('en-US');
  return (
    leftPath === rightPath ||
    leftPath.startsWith(`${rightPath}${a.separator}`) ||
    rightPath.startsWith(`${leftPath}${a.separator}`)
  );
}

const VIDEO_EXTENSIONS = new Set([
  '3gp',
  'asf',
  'avi',
  'divx',
  'flv',
  'm2ts',
  'm4v',
  'mkv',
  'mov',
  'mp4',
  'mpeg',
  'mpg',
  'mts',
  'ogm',
  'ogv',
  'rm',
  'rmvb',
  'ts',
  'vob',
  'webm',
  'wmv',
]);

function isVideoPath(path: string): boolean {
  const name = path.replaceAll('\\', '/').split('/').at(-1) ?? '';
  return VIDEO_EXTENSIONS.has(name.split('.').at(-1)?.toLocaleLowerCase('en-US') ?? '');
}

async function proveDedicatedFolder(
  target: ArrDeleteTarget,
  parent: string,
  retainedPath: string,
): Promise<void> {
  const maxEntries = 2_000;
  const maxDepth = 8;
  const rootChildren = await target.client.radarrImmediateChildren(parent);
  let entries = rootChildren.length;
  const media = rootChildren.filter((entry) => entry.type === 'file' && isVideoPath(entry.path));
  if (
    media.length !== 1 ||
    normalizedComparison(media[0]!.path) !== normalizedComparison(retainedPath)
  ) {
    throw new Error('the retained parent contains another video candidate');
  }
  const pending = rootChildren
    .filter((child) => child.type === 'folder')
    .map((child) => ({
      path: child.path,
      depth: 1,
    }));
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift()!;
    const normalized = normalizedComparison(current.path);
    if (!normalized || visited.has(normalized)) {
      throw new Error('the retained folder traversal encountered a path cycle or invalid folder');
    }
    visited.add(normalized);
    if (current.depth > maxDepth) {
      throw new Error('the retained folder traversal exceeded its depth limit');
    }
    const nested = await target.client.radarrImmediateChildren(current.path);
    entries += nested.length;
    if (entries > maxEntries) {
      throw new Error('the retained folder traversal exceeded its entry limit');
    }
    if (nested.some((entry) => entry.type === 'file' && isVideoPath(entry.path))) {
      throw new Error('the retained parent contains nested movie content');
    }
    for (const child of nested) {
      if (child.type === 'folder') pending.push({ path: child.path, depth: current.depth + 1 });
    }
  }
}

async function revalidatePersistedRadarrPathBoundary({
  plan,
  target,
  recordId,
  liveVersions,
  plexMappings,
  libraryKey,
  plexClient,
}: {
  plan: PersistedRadarrPathPlan;
  target: ArrDeleteTarget;
  recordId: number;
  liveVersions: readonly PlexMediaVersionPathPreview[];
  plexMappings: ReturnType<typeof loadPlexNamespaceMappings>;
  libraryKey: string;
  plexClient: Pick<PlexClient, 'libraryLocations'>;
}): Promise<void> {
  const selected = resolvePathNamespace(
    plan.namespaceEvidence.selected.plexPath,
    plexMappings,
    target.pathMappings,
  );
  const retained = resolvePathNamespace(
    plan.namespaceEvidence.retained.plexPath,
    plexMappings,
    target.pathMappings,
  );
  if (
    !selected ||
    !retained ||
    stableJson(selected) !== stableJson(plan.namespaceEvidence.selected) ||
    stableJson(retained) !== stableJson(plan.namespaceEvidence.retained)
  ) {
    throw new Error('the persisted path namespace mapping changed');
  }
  if (
    normalizedComparison(retained.arrPath) !== normalizedComparison(plan.retainedPath) ||
    normalizedComparison(arrDirname(retained.arrPath) ?? '') !==
      normalizedComparison(plan.targetMoviePath)
  ) {
    throw new Error('the retained path no longer resolves to the accepted movie folder');
  }

  const locations = await plexClient.libraryLocations(libraryKey);
  const mappedLocations = locations.locations.map((location) => {
    const evidence = resolvePathNamespace(location.path, plexMappings, target.pathMappings);
    if (!evidence) throw new Error('a Plex library location can no longer be mapped into Radarr');
    return evidence;
  });
  if (stableJson(mappedLocations) !== stableJson(plan.namespaceEvidence.libraryLocations)) {
    throw new Error('the persisted Plex library-location evidence changed');
  }
  if (
    mappedLocations.some(
      (location) =>
        normalizedComparison(location.arrPath) === normalizedComparison(plan.targetMoviePath),
    )
  ) {
    throw new Error('the accepted movie folder is now a Plex library root');
  }

  const selectedLive = liveVersions.find(
    (version) =>
      version.paths.length === 1 &&
      normalizedComparison(version.paths[0]!) ===
        normalizedComparison(plan.namespaceEvidence.selected.plexPath),
  );
  const retainedLive = liveVersions.find((version) => version.mediaId === plan.retainedMediaId);
  if (
    !retainedLive ||
    retainedLive.paths.length !== 1 ||
    normalizedComparison(retainedLive.paths[0]!) !==
      normalizedComparison(plan.namespaceEvidence.retained.plexPath) ||
    !Number.isSafeInteger(retainedLive.fileSize) ||
    retainedLive.fileSize! <= 0
  ) {
    throw new Error('the retained Plex version changed');
  }
  // Once Plex has confirmed deletion the selected path is expected to disappear. Until then,
  // repeat the physical proof at every planner/mutation boundary.
  if (selectedLive) {
    if (!Number.isSafeInteger(selectedLive.fileSize) || selectedLive.fileSize! <= 0) {
      throw new Error('the selected Plex version no longer has a known positive size');
    }
    const physical = await provePhysicalDeletionIndependence(
      selected.localPath,
      retained.localPath,
      selectedLive.fileSize!,
      retainedLive.fileSize!,
    );
    if (stableJson(physical) !== stableJson(plan.physicalIdentityEvidence)) {
      throw new Error('the persisted physical file identity changed');
    }
  }
  if ((await target.client.fileVisibility(retained.arrPath)) !== 'file') {
    throw new Error('Radarr can no longer see the exact retained file');
  }
  await proveDedicatedFolder(target, plan.targetMoviePath, retained.arrPath);

  const [capabilities, roots, catalog, activity] = await Promise.all([
    target.client.radarrPathAdoptionCapabilities(),
    target.client.radarrRootFolders(),
    target.client.radarrMovieCatalogPaths(),
    target.client.radarrMovieActivity(
      recordId,
      plan.transition?.rescanCommandId === undefined ? [] : [plan.transition.rescanCommandId],
    ),
  ]);
  const currentBehaviorSummary = capabilities.behavior
    ? {
      deleteEmptyFolders: capabilities.behavior.deleteEmptyFolders,
      fileDate: capabilities.behavior.fileDate,
      metadataConsumerCount: capabilities.behavior.metadataConsumerCount,
      notificationConsumerCount: capabilities.behavior.notificationConsumerCount,
    }
    : null;
  if (
    !capabilities.available ||
    !capabilities.behaviorFingerprint ||
    capabilities.version !== plan.radarrVersion ||
    capabilities.behaviorFingerprint !== plan.radarrBehaviorFingerprint ||
    stableJson(currentBehaviorSummary) !== stableJson(plan.behaviorSummary)
  ) {
    throw new Error('Radarr path-adoption capabilities or behavior changed');
  }
  if (!activity.quiet) throw new Error('Radarr has conflicting activity for this movie');
  if (
    roots.some(
      (root) => normalizedComparison(root.path) === normalizedComparison(plan.targetMoviePath),
    )
  ) {
    throw new Error('the accepted movie folder is now a Radarr root');
  }
  const containingRoots = roots.filter(
    (root) =>
      arrPathIsWithin(plan.targetMoviePath, root.path) &&
      normalizedComparison(plan.targetMoviePath) !== normalizedComparison(root.path),
  );
  if (containingRoots.length > 1) throw new Error('the accepted Radarr root is ambiguous');
  const requiresConsent = containingRoots.length === 0 || retained.arrMappingKind === 'download';
  if (
    (requiresConsent && plan.mode !== 'adopt_path_with_consent') ||
    (!requiresConsent && plan.mode !== 'adopt_safe_path')
  ) {
    throw new Error('the accepted path-ownership classification changed');
  }
  const collision = catalog.find(
    (movie) => movie.id !== recordId && pathsOverlap(movie.path, plan.targetMoviePath),
  );
  if (collision) throw new Error(`another Radarr movie now overlaps ${collision.path}`);
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
  serverId,
  libraryKey,
  plexClient,
  versionRanks = [],
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
  serverId?: number;
  libraryKey?: string;
  plexClient?: Pick<PlexClient, 'libraryLocations'>;
  versionRanks?: readonly MediaVersionQualityCandidate[];
}): Promise<ArrReassignmentPlanningResult> {
  const selectedVersions = [...selectedMediaIds].map((mediaId) =>
    liveVersions.find((version) => version.mediaId === mediaId)
  );
  const reassignPathsComplete = liveVersions.every((version) => !version.truncated) &&
    (selectedVersions.every(
      (version) => version !== undefined && version.paths.length > 0 && !version.truncated,
    ) ||
      requiredReassignments.size > 0 ||
      requiredOwnerships.size > 0);

  const decisionCodes: ArrReassignmentDecisionCode[] = [];
  const eligibleArrReassignments: EligibleArrReassignment[] = [];
  const arrOwnerships: PersistedArrOwnership[] = [];
  const arrReassignErrors = new DecisionMessages('external_error', decisionCodes);
  const arrReassignUnsafeReasons = new DecisionMessages('other_unsafe', decisionCodes);
  const recordDecision = (code: ArrReassignmentDecisionCode, message: string): void => {
    if (code === 'external_error') {
      arrReassignErrors.push(message);
    } else {
      const decisionIndex = decisionCodes.length;
      arrReassignUnsafeReasons.push(message);
      decisionCodes[decisionIndex] = code;
    }
  };
  const managedMediaIds = new Set<number>();
  let radarrPathAdoption: RadarrPathAdoptionPreview = {
    mode: 'unavailable',
    requiresConsent: false,
    reason: 'No safe Radarr retained-path adoption is available',
  };
  const arrMappingIdentities = arrTargets
    .filter(
      (target) =>
        (mediaType === 'movie' && target.client.type === 'radarr') ||
        (mediaType === 'episode' && target.client.type === 'sonarr'),
    )
    .map((target) => ({
      instanceId: target.instanceId,
      instanceType: target.instanceType,
      instanceUrl: target.instanceUrl,
      configurationUpdatedAt: target.configurationUpdatedAt,
      mappingIdentity: target.mappingIdentity,
    }))
    .sort((left, right) => left.instanceId - right.instanceId);
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
      ) {
        continue;
      }
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
        if (
          required &&
          Object.hasOwn(required, 'originalMonitored') &&
          typeof required.originalMonitored !== 'boolean'
        ) {
          arrReassignUnsafeReasons.push(
            `${target.instanceName} has malformed durable monitoring evidence`,
          );
          continue;
        }
        const lookupRecord = lookupRecords.has(target.instanceId)
          ? lookupRecords.get(target.instanceId)!
          : await target.client.lookup(externalId);
        const record = lookupRecord && mediaType === 'movie'
          ? {
            ...lookupRecord,
            ...(await target.client.radarrMovie(lookupRecord.id)),
          }
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
        const plexNamespaceMappings = serverId !== undefined && libraryKey !== undefined
          ? withTransaction((client) => loadPlexNamespaceMappings(client, serverId, libraryKey))
          : [];
        const resolvedVersions = liveVersions.map((version) => ({
          version,
          paths: version.paths.flatMap((path) => {
            const resolved = resolveArrPath(path, 'library', target.pathMappings) ??
              (plexNamespaceMappings.length > 0
                ? resolvePathNamespace(path, plexNamespaceMappings, target.pathMappings)?.arrPath
                : null);
            return resolved ? [resolved] : [];
          }),
        }));
        if (
          resolvedVersions.some(
            (candidate) =>
              candidate.version.paths.length === 0 ||
              candidate.paths.length !== candidate.version.paths.length,
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
        const selectedPathsResolved = liveSelectedVersions.every(
          (candidate) =>
            candidate.version.paths.length > 0 &&
            candidate.paths.length === candidate.version.paths.length,
        );
        const hasPersistedOwnershipEvidence = required !== undefined ||
          requiredOwnership !== undefined;
        if (
          managedFile &&
          (normalizedManagedPath === null ||
            !selectedPathsResolved ||
            (!hasPersistedOwnershipEvidence &&
              liveSelectedVersions.length !== selectedMediaIds.size))
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
          arrReassignUnsafeReasons.push(`${target.instanceName} changed its managed ownership`);
          continue;
        }
        const managesSelectedVersion = managedVersion !== undefined &&
          selectedMediaIds.has(managedVersion.mediaId);
        if (managesSelectedVersion) {
          managedMediaIds.add(managedVersion.mediaId);
        }
        if (
          managesSelectedVersion &&
          (managedVersion.paths.length !== 1 ||
            managedResolvedPaths.length !== 1 ||
            normalizedComparison(managedResolvedPaths[0]!) !== normalizedManagedPath)
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
          const extras = cachedExtras ?? (await target.client.extraFiles(record.id));
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
              ? normalizedRecordPath !== normalizedOriginalRoot &&
                normalizedRecordPath !==
                  normalizedComparison(required.radarrPathPlan?.targetMoviePath ?? '')
              : normalizedRecordPath !== normalizedOriginalRoot &&
                normalizedRecordPath !== normalizedRetainedRoot)
          ) {
            arrReassignUnsafeReasons.push(`${target.instanceName} changed its managed root path`);
            continue;
          }
          if (managedFile) {
            const stillOriginal = managedFile.id === required.managedFileId &&
              normalizedManagedPath === normalizedComparison(required.managedPath);
            const alreadyRetained =
              normalizedManagedPath === normalizedComparison(required.retainedPath);
            if (!stillOriginal && !alreadyRetained) {
              arrReassignUnsafeReasons.push(`${target.instanceName} changed its managed file`);
              continue;
            }
          }
        }
        if (
          required &&
          managedVersion !== undefined &&
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
        const radarrPathPlans = new Map<number, PersistedRadarrPathPlan>();
        const monitorTarget = mediaType === 'movie'
          ? await target.client.radarrMovieMonitorTarget({
            movieId: record.id,
            tmdbId: item.tmdbId!,
            path: record.path,
          })
          : await target.client.sonarrEpisodeMonitorTarget({
            episodeId: episodeId!,
            seriesId: record.id,
            seasonNumber: episodeIdentity!.seasonNumber,
            episodeNumber: episodeIdentity!.episodeNumber,
          });
        const retainedVersionCount = resolvedVersions.filter(
          ({ version }) => !excludedReassignMediaIds.has(version.mediaId),
        ).length;
        for (const { version, paths } of resolvedVersions) {
          if (excludedReassignMediaIds.has(version.mediaId) || version.truncated) continue;
          if (version.paths.length !== 1 || paths.length !== 1) continue;
          const normalizedPath = normalizedComparison(paths[0]!);
          if (
            normalizedPath === null ||
            resolvedPathOwners.get(normalizedPath)?.size !== 1 ||
            !resolvedPathOwners.get(normalizedPath)?.has(version.mediaId)
          ) {
            continue;
          }
          if (mediaType === 'episode' && !arrPathIsWithin(paths[0]!, record.path)) continue;
          const insideExactMovieFolder = mediaType !== 'movie' ||
            normalizedComparison(arrDirname(paths[0]!) ?? '') === normalizedComparison(record.path);
          const candidateRecordPath = mediaType === 'movie' ? arrDirname(paths[0]!) : record.path;
          if (candidateRecordPath === null) continue;
          const candidateSize = mediaType === 'movie'
            ? (version.projectedFileSize ?? null)
            : (version.fileSize ?? null);
          if (!Number.isSafeInteger(candidateSize) || candidateSize! <= 0) continue;
          if (
            mediaType === 'movie' &&
            resolvedVersions.some(
              (other) =>
                other.version.mediaId !== managedVersion?.mediaId &&
                other.version.mediaId !== version.mediaId &&
                other.paths.some((path) => arrPathIsWithin(path, record.path!)),
            )
          ) {
            continue;
          }
          if (mediaType === 'movie' && (await target.client.fileVisibility(paths[0]!)) !== 'file') {
            continue;
          }
          if (mediaType === 'movie' && !insideExactMovieFolder) {
            continue;
          }
          candidatePaths.set(version.mediaId, paths[0]!);
          candidateRecordPaths.set(version.mediaId, candidateRecordPath);
          candidateFileSizes.set(version.mediaId, candidateSize);
        }
        let outsideFailureReason: string | undefined;
        if (
          candidatePaths.size === 0 &&
          mediaType === 'movie' &&
          (!required || required.radarrPathPlan !== undefined) &&
          serverId !== undefined &&
          libraryKey !== undefined &&
          plexClient &&
          managedVersion &&
          managedFile &&
          managedPath &&
          managedVersion.paths.length === 1 &&
          managedFile.path &&
          managedFile.size !== null &&
          managedFile.size > 0
        ) {
          const plexMappings = plexNamespaceMappings;
          const machineIdentifier = withTransaction(
            (client) =>
              client
                .prepare('SELECT machine_identifier FROM servers WHERE id = ?')
                .value<[string]>(serverId)?.[0],
          );
          for (const { version } of resolvedVersions) {
            if (excludedReassignMediaIds.has(version.mediaId) || version.truncated) continue;
            if (required && version.mediaId !== required.retainedMediaId) continue;
            if (
              version.paths.length !== 1 ||
              !Number.isSafeInteger(version.fileSize) ||
              version.fileSize! <= 0
            ) {
              continue;
            }
            try {
              if (!machineIdentifier) throw new Error('the active Plex server identity is missing');
              const selectedNamespace = resolvePathNamespace(
                managedVersion.paths[0]!,
                plexMappings,
                target.pathMappings,
              );
              const retainedNamespace = resolvePathNamespace(
                version.paths[0]!,
                plexMappings,
                target.pathMappings,
              );
              if (!selectedNamespace || !retainedNamespace) {
                throw new Error(
                  'the Plex, Plex Librarian, and Radarr namespaces are not explicitly and unambiguously mapped',
                );
              }
              const retainedParent = arrDirname(retainedNamespace.arrPath);
              const retainedRelative = arrBasename(retainedNamespace.arrPath);
              if (!retainedParent || !retainedRelative) {
                throw new Error('the retained Radarr path has no dedicated direct parent');
              }
              if (
                retainedRelative.toLocaleLowerCase('en-US') ===
                  managedFile.relativePath.replaceAll('\\', '/').toLocaleLowerCase('en-US')
              ) {
                throw new Error(
                  'the old and retained Radarr-relative paths are equal, so a new movie-file record cannot be proven',
                );
              }
              const physicalIdentityEvidence = await provePhysicalDeletionIndependence(
                selectedNamespace.localPath,
                retainedNamespace.localPath,
                managedVersion.fileSize!,
                version.fileSize!,
              );
              if ((await target.client.fileVisibility(retainedNamespace.arrPath)) !== 'file') {
                throw new Error('Radarr cannot see the exact retained file');
              }
              await proveDedicatedFolder(target, retainedParent, retainedNamespace.arrPath);
              const locations = await plexClient.libraryLocations(libraryKey);
              const mappedLocations = locations.locations.map((location) => {
                const evidence = resolvePathNamespace(
                  location.path,
                  plexMappings,
                  target.pathMappings,
                );
                if (!evidence) {
                  throw new Error('a Plex library location cannot be mapped into Radarr');
                }
                return evidence;
              });
              if (
                mappedLocations.some(
                  (location) =>
                    normalizedComparison(location.arrPath) === normalizedComparison(retainedParent),
                )
              ) {
                throw new Error('the proposed movie folder is a Plex library root');
              }
              const [capabilities, roots, catalog, activity] = await Promise.all([
                target.client.radarrPathAdoptionCapabilities(),
                target.client.radarrRootFolders(),
                target.client.radarrMovieCatalogPaths(),
                target.client.radarrMovieActivity(record.id),
              ]);
              if (!capabilities.available || !capabilities.behaviorFingerprint) {
                throw new Error(
                  capabilities.reason ?? 'Radarr path-adoption capability is unavailable',
                );
              }
              if (!activity.quiet) {
                throw new Error(
                  `Radarr has conflicting movie activity: ${
                    activity.blocking
                      .map((entry) => entry.name)
                      .join(', ')
                  }`,
                );
              }
              const containingRoots = roots.filter(
                (root) =>
                  arrPathIsWithin(retainedParent, root.path) &&
                  normalizedComparison(retainedParent) !== normalizedComparison(root.path),
              );
              if (
                roots.some(
                  (root) =>
                    normalizedComparison(retainedParent) === normalizedComparison(root.path),
                )
              ) {
                throw new Error('the proposed movie folder is a Radarr root');
              }
              if (containingRoots.length > 1) {
                throw new Error('the proposed movie folder is ambiguous across Radarr roots');
              }
              const collision = catalog.find(
                (movie) => movie.id !== record.id && pathsOverlap(movie.path, retainedParent),
              );
              if (collision) {
                throw new Error(
                  `another Radarr movie overlaps the proposed path: ${collision.path}`,
                );
              }
              if (containingRoots.length === 0 || retainedNamespace.arrMappingKind === 'download') {
                throw new Error('the retained path is outside an ordinary Radarr library boundary');
              }
              const requiresConsent = false;
              const mode = 'adopt_safe_path' as const;
              const pathOwnership = 'ordinary_radarr_library' as const;
              const decision = {
                serverId,
                machineIdentifier,
                arrInstanceId: target.instanceId,
                arrConfigurationUpdatedAt: target.configurationUpdatedAt,
                arrMappingIdentity: target.mappingIdentity,
                radarrBehaviorFingerprint: capabilities.behaviorFingerprint,
                radarrVersion: capabilities.version!,
                behaviorSummary: {
                  deleteEmptyFolders: capabilities.behavior!.deleteEmptyFolders,
                  fileDate: capabilities.behavior!.fileDate,
                  metadataConsumerCount: capabilities.behavior!.metadataConsumerCount,
                  notificationConsumerCount: capabilities.behavior!.notificationConsumerCount,
                },
                movieId: record.id,
                originalMonitored: required?.radarrPathPlan?.originalMonitored ??
                  monitorTarget.monitored,
                selectedMediaIds: [...selectedMediaIds].sort((left, right) => left - right),
                retainedMediaId: version.mediaId,
                selectedPath: managedVersion.paths[0],
                retainedPath: version.paths[0],
                originalMoviePath: record.path,
                proposedMoviePath: retainedParent,
                pathOwnership,
                requiresConsent,
                namespaceMappings: [selectedNamespace, retainedNamespace, ...mappedLocations].map(
                  (evidence) => ({
                    plexMappingId: evidence.plexMappingId,
                    plexMappingRevision: evidence.plexMappingRevision,
                    arrMappingKind: evidence.arrMappingKind,
                    arrMappingRoot: evidence.arrMappingRoot,
                    arrLocalRoot: evidence.arrLocalRoot,
                  }),
                ),
              };
              const planFingerprint = await fingerprint(decision);
              const pathPlan: PersistedRadarrPathPlan = {
                mode,
                arrInstanceId: target.instanceId,
                movieId: record.id,
                retainedMediaId: version.mediaId,
                originalMoviePath: record.path,
                targetMoviePath: retainedParent,
                retainedPath: retainedNamespace.arrPath,
                originalMonitored: required?.radarrPathPlan?.originalMonitored ??
                  monitorTarget.monitored,
                originalMovieFile: {
                  id: managedFile.id,
                  path: managedPath,
                  relativePath: managedFile.relativePath,
                  size: managedFile.size,
                },
                pathOwnership,
                userAuthorizedPathManagement: true,
                planFingerprint,
                radarrBehaviorFingerprint: capabilities.behaviorFingerprint,
                radarrVersion: capabilities.version!,
                behaviorSummary: {
                  deleteEmptyFolders: capabilities.behavior!.deleteEmptyFolders,
                  fileDate: capabilities.behavior!.fileDate,
                  metadataConsumerCount: capabilities.behavior!.metadataConsumerCount,
                  notificationConsumerCount: capabilities.behavior!.notificationConsumerCount,
                },
                namespaceEvidence: {
                  selected: selectedNamespace,
                  retained: retainedNamespace,
                  libraryLocations: mappedLocations,
                },
                physicalIdentityEvidence,
              };
              if (
                required?.radarrPathPlan &&
                (required.radarrPathPlan.planFingerprint !== pathPlan.planFingerprint ||
                  required.radarrPathPlan.mode !== pathPlan.mode ||
                  normalizedComparison(required.radarrPathPlan.targetMoviePath) !==
                    normalizedComparison(pathPlan.targetMoviePath) ||
                  required.radarrPathPlan.retainedMediaId !== pathPlan.retainedMediaId ||
                  required.radarrPathPlan.radarrBehaviorFingerprint !==
                    pathPlan.radarrBehaviorFingerprint)
              ) {
                throw new Error('the persisted Radarr retained-path decision changed');
              }
              candidatePaths.set(version.mediaId, retainedNamespace.arrPath);
              candidateRecordPaths.set(version.mediaId, retainedParent);
              candidateFileSizes.set(version.mediaId, version.projectedFileSize ?? null);
              radarrPathPlans.set(version.mediaId, pathPlan);
            } catch (error) {
              outsideFailureReason = `${target.instanceName}: ${
                error instanceof Error ? error.message : 'outside-folder adoption is unavailable'
              } (retained path: ${version.paths[0]})`;
            }
          }
        }
        if (
          required?.radarrPathPlan &&
          candidatePaths.has(required.retainedMediaId) &&
          normalizedComparison(candidateRecordPaths.get(required.retainedMediaId) ?? '') ===
            normalizedComparison(required.radarrPathPlan.targetMoviePath)
        ) {
          try {
            if (libraryKey === undefined || !plexClient) {
              throw new Error('the Plex library identity required for path adoption is missing');
            }
            await revalidatePersistedRadarrPathBoundary({
              plan: required.radarrPathPlan,
              target,
              recordId: record.id,
              liveVersions,
              plexMappings: plexNamespaceMappings,
              libraryKey,
              plexClient,
            });
          } catch (error) {
            arrReassignUnsafeReasons.push(
              `${target.instanceName}: persisted Radarr path adoption is no longer safe: ${
                error instanceof Error ? error.message : 'boundary revalidation failed'
              }`,
            );
            continue;
          }
          radarrPathPlans.set(required.retainedMediaId, required.radarrPathPlan);
        }
        if (candidatePaths.size === 0) {
          recordDecision(
            mediaType === 'movie' && !required && retainedVersionCount === 1
              ? 'retained_parent_mismatch'
              : 'other_unsafe',
            mediaType === 'episode'
              ? `${target.instanceName} has no retained Plex version inside its managed series folder with a known positive size`
              : (outsideFailureReason ??
                `${target.instanceName} has no visible retained Plex version in its exact current movie folder with known size and no competing file`),
          );
          continue;
        }
        if (requiredRetainedMediaId !== undefined && !candidatePaths.has(requiredRetainedMediaId)) {
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
          arrReassignUnsafeReasons.push(`${target.instanceName} retained Plex path changed`);
          continue;
        }
        if (
          required &&
          normalizedComparison(candidateRecordPaths.get(required.retainedMediaId) ?? '') !==
            normalizedComparison(
              required.retainedRecordPath ??
                (mediaType === 'movie'
                  ? (arrDirname(required.retainedPath) ?? '')
                  : required.recordPath),
            )
        ) {
          arrReassignUnsafeReasons.push(`${target.instanceName} retained managed root changed`);
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
          monitored: monitorTarget.monitored,
          candidatePaths,
          candidateRecordPaths,
          candidateFileSizes,
          alreadyReassigned,
          ...(radarrPathPlans.size > 0 ? { radarrPathPlans } : {}),
        });
      } catch (error) {
        recordDecision(
          'external_error',
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
      ownership.managedMediaId !== null && !eligibleReassignInstanceIds.has(ownership.instanceId)
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
    if (eligibleArrReassignments.length > 1) {
      eligibleArrReassignments.length = 0;
      commonReassignCandidates.clear();
      arrReassignUnsafeReasons.push('The selected Plex version has multiple eligible Arr owners');
    }
  }
  if (eligibleArrReassignments.length === 1 && commonReassignCandidates.size > 0) {
    const entry = eligibleArrReassignments[0]!;
    const outsideCandidates = [...commonReassignCandidates].filter((mediaId) =>
      entry.radarrPathPlans?.has(mediaId)
    );
    if (outsideCandidates.length > 0) {
      const retainedMediaId = requiredRetainedMediaId ??
        bestMediaVersionCandidate(versionRanks, outsideCandidates) ??
        (outsideCandidates.length === 1 ? outsideCandidates[0]! : null);
      const pathPlan = retainedMediaId === null
        ? undefined
        : entry.radarrPathPlans?.get(retainedMediaId);
      if (!pathPlan) {
        arrReassignUnsafeReasons.push(
          'The retained outside-folder version could not be selected deterministically',
        );
        commonReassignCandidates.clear();
        eligibleArrReassignments.length = 0;
      } else {
        entry.radarrPathPlan = pathPlan;
        commonReassignCandidates = new Set([pathPlan.retainedMediaId]);
        radarrPathAdoption = {
          mode: pathPlan.mode === 'adopt_path_with_consent' ? 'unavailable' : pathPlan.mode,
          arrInstanceId: pathPlan.arrInstanceId,
          movieId: pathPlan.movieId,
          retainedMediaId: pathPlan.retainedMediaId,
          originalPath: pathPlan.originalMoviePath,
          retainedPath: pathPlan.retainedPath,
          proposedMoviePath: pathPlan.targetMoviePath,
          pathOwnership: pathPlan.pathOwnership,
          requiresConsent: false,
          planFingerprint: pathPlan.planFingerprint,
          radarrVersion: pathPlan.radarrVersion,
          minimumRadarrVersion: '6.3.0.10514',
          behaviorSummary: pathPlan.behaviorSummary,
        };
      }
    } else {
      const retainedMediaId = requiredRetainedMediaId ??
        bestMediaVersionCandidate(versionRanks, [...commonReassignCandidates]) ??
        (commonReassignCandidates.size === 1 ? [...commonReassignCandidates][0]! : undefined);
      radarrPathAdoption = {
        mode: 'existing_path',
        arrInstanceId: entry.target.instanceId,
        movieId: entry.recordId,
        ...(retainedMediaId !== undefined ? { retainedMediaId } : {}),
        originalPath: entry.recordPath,
        ...(retainedMediaId !== undefined
          ? {
            retainedPath: entry.candidatePaths.get(retainedMediaId),
            proposedMoviePath: entry.recordPath,
          }
          : {}),
        pathOwnership: 'ordinary_radarr_library',
        requiresConsent: false,
      };
    }
  }
  const arrReassignStatus = arrReassignErrors.length === 0 &&
      arrReassignUnsafeReasons.length === 0 &&
      eligibleArrReassignments.length > 0 &&
      commonReassignCandidates.size > 0
    ? ('resolved' as const)
    : arrReassignErrors.length > 0
    ? ('error' as const)
    : ('unavailable' as const);
  const arrReassignReason = arrReassignStatus === 'error'
    ? arrReassignErrors.join('; ')
    : arrReassignStatus === 'unavailable'
    ? (arrReassignUnsafeReasons[0] ??
      `The selected deletion does not include a ${
        mediaType === 'movie' ? 'Radarr' : 'Sonarr'
      }-managed copy`)
    : undefined;
  const arrOwnershipValid = arrReassignErrors.length === 0 && arrReassignUnsafeReasons.length === 0;
  const arrOwnershipReason = arrReassignErrors[0] ?? arrReassignUnsafeReasons[0];
  if (arrReassignStatus === 'resolved') decisionCodes.push('ordinary_reassignment_available');

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
    radarrPathAdoption: arrReassignStatus === 'resolved' ? radarrPathAdoption : {
      ...radarrPathAdoption,
      mode: 'unavailable',
      reason: arrReassignReason,
    },
  };
}
