import type {
  ArrPathMapping,
  RadarrMovieRelocationGuidanceV1 as SharedRadarrGuidance,
  RelocationGuidance as SharedRelocationGuidance,
} from '@plex-librarian/shared/types.ts';
import { arrBasename, arrDirname, resolveArrPath } from '../../mediaDeletion/arrPaths.ts';
import { normalizeRemoteAbsolute } from '../../mediaDeletion/hardlinks.ts';

export const RELOCATION_SUPERSEDED_REASON =
  'Superseded after guided retained-version relocation; no deletion was attempted for this target';

const MAX_PATH_LENGTH = 4096;
const MAX_MAPPING_IDENTITY_LENGTH = 4096;
const MAX_INSTANCE_NAME_LENGTH = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface RadarrMovieRelocationCandidate {
  service: 'radarr';
  mediaType: 'movie';
  reason: 'retained_parent_mismatch';
  selectedMediaId: number;
  selectedPlexPath: string;
  selectedArrPath: string;
  retainedMediaId: number;
  retainedPlexPath: string;
  retainedFileSize: number;
  managedDirectoryPath: string;
  sourceArrPath: string;
  destinationArrPath: string;
  destinationPlexPath: string;
  arrInstanceId: number;
  arrInstanceName: string;
  arrRecordId: number;
  arrManagedFileId: number;
  mappingIdentity: string;
}

export type RelocationCandidate = RadarrMovieRelocationCandidate;

export interface RadarrMovieRelocationGuidanceV1 extends RadarrMovieRelocationCandidate {
  schemaVersion: 1;
  workflow: 'retained_version_relocation';
  guidanceId: string;
  observedAt: number;
}

export type RelocationGuidance = RadarrMovieRelocationGuidanceV1;

export function relocationManualReason(
  value: RelocationCandidate | RelocationGuidance,
): string {
  switch (value.service) {
    case 'radarr':
      return 'Radarr can adopt the retained version only after the guided manual relocation';
  }
}

export interface IncompleteRelocationSyncBarrier {
  guidanceId: string;
  supersededAt: number;
  syncId?: never;
  finishedAt?: never;
}

export interface CompletedRelocationSyncBarrier {
  guidanceId: string;
  supersededAt: number;
  syncId: number;
  finishedAt: number;
}

export type RelocationSyncBarrier =
  | IncompleteRelocationSyncBarrier
  | CompletedRelocationSyncBarrier;

export interface RelocationTargetIdentity {
  targetKind: 'whole_item' | 'movie_version' | 'episode_version';
  mediaId?: unknown;
  type?: unknown;
  selectedMediaIds?: unknown;
  operationMediaIds?: unknown;
  arrReassignmentMappings?: unknown;
  expectedRetainedVersion?: unknown;
}

// Compiler-checked agreement between the backend's curated contract and the public API.
const _backendToShared: RelocationGuidance extends SharedRelocationGuidance ? true : never = true;
const _sharedToBackend: SharedRadarrGuidance extends RadarrMovieRelocationGuidanceV1 ? true
  : never = true;
void _backendToShared;
void _sharedToBackend;

export function workflowKeyPresent(snapshot: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(snapshot, key);
}

export function relocationSupersededPredicateSql(alias = ''): string {
  const prefix = alias ? `${alias}.` : '';
  const reason = RELOCATION_SUPERSEDED_REASON.replaceAll("'", "''");
  return `${prefix}status = 'cancelled' AND ${prefix}error = '${reason}' AND json_type(${prefix}snapshot, '$.relocationSyncBarrier') IS NOT NULL`;
}

export function isRelocationSupersededTarget(value: {
  status: unknown;
  error: unknown;
  snapshot: Record<string, unknown>;
}): boolean {
  return value.status === 'cancelled' && value.error === RELOCATION_SUPERSEDED_REASON &&
    workflowKeyPresent(value.snapshot, 'relocationSyncBarrier');
}

export function assertFiniteJson(value: unknown): void {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('The deletion snapshot contains an invalid number');
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertFiniteJson(entry);
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) assertFiniteJson(entry);
  }
}

export function canonicalJson(value: unknown): string {
  assertFiniteJson(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    ).join(',') + '}';
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('The deletion snapshot is invalid');
  return encoded;
}

export function relocationProjection(snapshot: Record<string, unknown>): string {
  const copy = { ...snapshot };
  delete copy.relocationGuidance;
  delete copy.relocationSyncBarrier;
  return canonicalJson(copy);
}

export function assertOnlyRelocationDelta(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): void {
  if (relocationProjection(before) !== relocationProjection(after)) {
    throw new Error('The accepted deletion evidence changed unexpectedly');
  }
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function canonicalPath(value: unknown): value is string {
  if (!boundedString(value, MAX_PATH_LENGTH)) return false;
  const normalized = normalizeRemoteAbsolute(value);
  return normalized !== null && normalized.path === value;
}

function boundedAbsolutePath(value: unknown): value is string {
  return boundedString(value, MAX_PATH_LENGTH) && normalizeRemoteAbsolute(value) !== null;
}

function samePath(left: string, right: string): boolean {
  const a = normalizeRemoteAbsolute(left);
  const b = normalizeRemoteAbsolute(right);
  return a !== null && b !== null && a.separator === b.separator && a.comparison === b.comparison;
}

function parseMappingIdentity(value: string): ArrPathMapping[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (!exactKeys(parsed, ['addImportExclusion', 'pathMappings'])) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.addImportExclusion !== 'boolean' || !Array.isArray(record.pathMappings)) {
      return null;
    }
    if (record.pathMappings.length > 100) return null;
    const mappings: ArrPathMapping[] = [];
    for (const entry of record.pathMappings) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      if (!exactKeys(entry, ['kind', 'arrPath', 'localPath'])) return null;
      const mapping = entry as Record<string, unknown>;
      if (
        (mapping.kind !== 'library' && mapping.kind !== 'download') ||
        !boundedString(mapping.arrPath, MAX_PATH_LENGTH) ||
        !boundedString(mapping.localPath, MAX_PATH_LENGTH) ||
        normalizeRemoteAbsolute(mapping.arrPath) === null ||
        normalizeLocalAbsolute(mapping.localPath) === null
      ) return null;
      mappings.push({
        kind: mapping.kind,
        arrPath: mapping.arrPath,
        localPath: mapping.localPath,
      });
    }
    if (
      JSON.stringify({ addImportExclusion: record.addImportExclusion, pathMappings: mappings }) !==
        value
    ) {
      return null;
    }
    return mappings;
  } catch {
    return null;
  }
}

function normalizeLocalAbsolute(input: string): string | null {
  const raw = input.trim();
  if (!raw.startsWith('/') || raw.includes('\\')) return null;
  const segments = raw.split('/').filter((part) => part && part !== '.');
  if (segments.includes('..')) return null;
  return `/${segments.join('/')}`;
}

function localWithin(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function remoteWithin(root: string, path: string): boolean {
  const normalizedRoot = normalizeRemoteAbsolute(root);
  const normalizedPath = normalizeRemoteAbsolute(path);
  return normalizedRoot !== null && normalizedPath !== null &&
    normalizedRoot.separator === normalizedPath.separator &&
    (normalizedPath.comparison === normalizedRoot.comparison ||
      normalizedPath.comparison.startsWith(
        `${normalizedRoot.comparison}${normalizedRoot.separator}`,
      ));
}

/** Reproduces both Arr source translations and the Plex destination provenance. */
export function deriveRelocationNamespace(
  mappingIdentity: string,
  selectedPlexPath: string,
  retainedPlexPath: string,
  destinationArrPath: string,
): { selectedArrPath: string; sourceArrPath: string; destinationPlexPath: string } | null {
  const mappings = parseMappingIdentity(mappingIdentity);
  if (!mappings) return null;
  const selectedArrPath = resolveArrPath(selectedPlexPath, 'library', mappings);
  const sourceArrPath = resolveArrPath(retainedPlexPath, 'library', mappings);
  const normalizedDestination = normalizeRemoteAbsolute(destinationArrPath);
  if (!selectedArrPath || !sourceArrPath || !normalizedDestination) return null;

  const directSelected = samePath(selectedPlexPath, selectedArrPath);
  const destinations = new Map<string, string>();
  let provenanceCount = 0;
  if (directSelected) {
    destinations.set(normalizedDestination.comparison, normalizedDestination.path);
    provenanceCount++;
  }

  const selectedLocal = normalizeLocalAbsolute(selectedPlexPath);
  for (const mapping of mappings) {
    if (mapping.kind !== 'library') continue;
    const localRoot = normalizeLocalAbsolute(mapping.localPath);
    const arrRoot = normalizeRemoteAbsolute(mapping.arrPath);
    if (!selectedLocal || !localRoot || !arrRoot || !localWithin(localRoot, selectedLocal)) {
      continue;
    }
    if (
      !remoteWithin(arrRoot.path, selectedArrPath) ||
      !remoteWithin(arrRoot.path, destinationArrPath)
    ) {
      continue;
    }
    const selectedRelative = selectedLocal.slice(localRoot.length).replace(/^\/+/, '');
    const resolvedSelected = selectedRelative
      ? `${arrRoot.path}${arrRoot.separator}${selectedRelative.replaceAll('/', arrRoot.separator)}`
      : arrRoot.path;
    if (!samePath(resolvedSelected, selectedArrPath)) continue;
    const relative = normalizedDestination.path.slice(arrRoot.path.length).replace(/^[\\/]+/, '')
      .replaceAll('\\', '/');
    const plexDestination = normalizeRemoteAbsolute(
      relative ? `${localRoot}/${relative}` : localRoot,
    );
    if (plexDestination) {
      destinations.set(plexDestination.comparison, plexDestination.path);
      provenanceCount++;
    }
  }
  if (destinations.size !== 1 || provenanceCount !== 1) return null;
  return {
    selectedArrPath: normalizeRemoteAbsolute(selectedArrPath)!.path,
    sourceArrPath: normalizeRemoteAbsolute(sourceArrPath)!.path,
    destinationPlexPath: [...destinations.values()][0]!,
  };
}

export function createRelocationGuidance(
  candidate: RelocationCandidate,
  now = Math.floor(Date.now() / 1000),
): RelocationGuidance {
  const namespace = deriveRelocationNamespace(
    candidate.mappingIdentity,
    candidate.selectedPlexPath,
    candidate.retainedPlexPath,
    candidate.destinationArrPath,
  );
  if (
    !namespace || !samePath(namespace.selectedArrPath, candidate.selectedArrPath) ||
    !samePath(namespace.sourceArrPath, candidate.sourceArrPath) ||
    !samePath(namespace.destinationPlexPath, candidate.destinationPlexPath)
  ) {
    throw new Error('Relocation candidate path evidence is inconsistent');
  }
  return {
    schemaVersion: 1,
    workflow: 'retained_version_relocation',
    service: candidate.service,
    mediaType: candidate.mediaType,
    reason: candidate.reason,
    guidanceId: crypto.randomUUID(),
    selectedMediaId: candidate.selectedMediaId,
    selectedPlexPath: candidate.selectedPlexPath,
    selectedArrPath: normalizeRemoteAbsolute(candidate.selectedArrPath)!.path,
    retainedMediaId: candidate.retainedMediaId,
    retainedPlexPath: candidate.retainedPlexPath,
    retainedFileSize: candidate.retainedFileSize,
    managedDirectoryPath: normalizeRemoteAbsolute(candidate.managedDirectoryPath)!.path,
    sourceArrPath: normalizeRemoteAbsolute(candidate.sourceArrPath)!.path,
    destinationArrPath: normalizeRemoteAbsolute(candidate.destinationArrPath)!.path,
    destinationPlexPath: normalizeRemoteAbsolute(candidate.destinationPlexPath)!.path,
    arrInstanceId: candidate.arrInstanceId,
    arrInstanceName: candidate.arrInstanceName.slice(0, MAX_INSTANCE_NAME_LENGTH),
    arrRecordId: candidate.arrRecordId,
    arrManagedFileId: candidate.arrManagedFileId,
    mappingIdentity: candidate.mappingIdentity,
    observedAt: now,
  };
}

function validSelectionIdentity(
  guidance: RelocationGuidance,
  target: RelocationTargetIdentity,
): boolean {
  if (
    target.targetKind !== 'movie_version' || target.type !== 'movie' ||
    target.mediaId !== guidance.selectedMediaId
  ) return false;
  if (
    !Array.isArray(target.selectedMediaIds) || target.selectedMediaIds.length !== 1 ||
    target.selectedMediaIds[0] !== guidance.selectedMediaId
  ) return false;
  if (!Array.isArray(target.operationMediaIds) || target.operationMediaIds.length === 0) {
    return false;
  }
  const operationIds = target.operationMediaIds;
  if (
    !operationIds.every(positiveSafeInteger) ||
    new Set(operationIds).size !== operationIds.length ||
    !operationIds.includes(guidance.selectedMediaId) ||
    operationIds.includes(guidance.retainedMediaId)
  ) {
    return false;
  }
  if (!Array.isArray(target.arrReassignmentMappings)) return false;
  const matches = target.arrReassignmentMappings.filter((entry) =>
    !!entry && typeof entry === 'object' &&
    (entry as Record<string, unknown>).instanceId === guidance.arrInstanceId
  ) as Record<string, unknown>[];
  if (
    matches.length !== 1 || matches[0]!.instanceType !== 'radarr' ||
    matches[0]!.mappingIdentity !== guidance.mappingIdentity
  ) return false;
  if (target.expectedRetainedVersion !== undefined) {
    const expected = target.expectedRetainedVersion;
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return false;
    const record = expected as Record<string, unknown>;
    if (record.mediaId !== guidance.retainedMediaId) return false;
    if (record.fileSize !== null && record.fileSize !== guidance.retainedFileSize) return false;
  }
  return true;
}

export function validateRelocationGuidance(
  value: unknown,
  target: RelocationTargetIdentity,
): RelocationGuidance | null {
  try {
    assertFiniteJson(value);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const guidance = value as Record<string, unknown>;
  if (
    !exactKeys(guidance, [
      'schemaVersion',
      'workflow',
      'service',
      'mediaType',
      'reason',
      'guidanceId',
      'selectedMediaId',
      'selectedPlexPath',
      'selectedArrPath',
      'retainedMediaId',
      'retainedPlexPath',
      'retainedFileSize',
      'managedDirectoryPath',
      'sourceArrPath',
      'destinationArrPath',
      'destinationPlexPath',
      'arrInstanceId',
      'arrInstanceName',
      'arrRecordId',
      'arrManagedFileId',
      'mappingIdentity',
      'observedAt',
    ])
  ) return null;
  if (
    guidance.schemaVersion !== 1 || guidance.workflow !== 'retained_version_relocation' ||
    guidance.service !== 'radarr' || guidance.mediaType !== 'movie' ||
    guidance.reason !== 'retained_parent_mismatch' ||
    typeof guidance.guidanceId !== 'string' || !UUID.test(guidance.guidanceId) ||
    !positiveSafeInteger(guidance.selectedMediaId) ||
    !positiveSafeInteger(guidance.retainedMediaId) ||
    guidance.selectedMediaId === guidance.retainedMediaId ||
    !positiveSafeInteger(guidance.retainedFileSize) ||
    !positiveSafeInteger(guidance.arrInstanceId) || !positiveSafeInteger(guidance.arrRecordId) ||
    !positiveSafeInteger(guidance.arrManagedFileId) || !positiveSafeInteger(guidance.observedAt) ||
    !boundedString(guidance.arrInstanceName, MAX_INSTANCE_NAME_LENGTH) ||
    !boundedString(guidance.mappingIdentity, MAX_MAPPING_IDENTITY_LENGTH) ||
    !boundedAbsolutePath(guidance.selectedPlexPath) ||
    !boundedAbsolutePath(guidance.retainedPlexPath) ||
    !canonicalPath(guidance.selectedArrPath) || !canonicalPath(guidance.managedDirectoryPath) ||
    !canonicalPath(guidance.sourceArrPath) || !canonicalPath(guidance.destinationArrPath) ||
    !canonicalPath(guidance.destinationPlexPath)
  ) return null;
  const typed = guidance as unknown as RelocationGuidance;
  if (!validSelectionIdentity(typed, target)) return null;
  const namespace = deriveRelocationNamespace(
    typed.mappingIdentity,
    typed.selectedPlexPath,
    typed.retainedPlexPath,
    typed.destinationArrPath,
  );
  if (
    !namespace || !samePath(namespace.selectedArrPath, typed.selectedArrPath) ||
    !samePath(namespace.sourceArrPath, typed.sourceArrPath) ||
    !samePath(namespace.destinationPlexPath, typed.destinationPlexPath)
  ) return null;
  const selectedArr = normalizeRemoteAbsolute(typed.selectedArrPath)!;
  const managedDirectory = normalizeRemoteAbsolute(typed.managedDirectoryPath)!;
  const sourceArr = normalizeRemoteAbsolute(typed.sourceArrPath)!;
  const destinationArr = normalizeRemoteAbsolute(typed.destinationArrPath)!;
  if (
    selectedArr.separator !== managedDirectory.separator ||
    sourceArr.separator !== managedDirectory.separator ||
    destinationArr.separator !== managedDirectory.separator ||
    arrDirname(typed.selectedArrPath) === null ||
    !samePath(arrDirname(typed.selectedArrPath)!, typed.managedDirectoryPath) ||
    arrDirname(typed.destinationArrPath) === null ||
    !samePath(arrDirname(typed.destinationArrPath)!, typed.managedDirectoryPath) ||
    arrDirname(typed.sourceArrPath) === null ||
    samePath(arrDirname(typed.sourceArrPath)!, typed.managedDirectoryPath) ||
    arrBasename(typed.sourceArrPath) !== arrBasename(typed.destinationArrPath) ||
    arrBasename(typed.destinationPlexPath) !== arrBasename(typed.destinationArrPath) ||
    samePath(typed.selectedArrPath, typed.sourceArrPath) ||
    samePath(typed.selectedArrPath, typed.destinationArrPath) ||
    samePath(typed.sourceArrPath, typed.destinationArrPath) ||
    samePath(typed.selectedPlexPath, typed.retainedPlexPath) ||
    samePath(typed.destinationPlexPath, typed.selectedPlexPath) ||
    samePath(typed.destinationPlexPath, typed.retainedPlexPath)
  ) return null;
  return { ...typed };
}

export function validateRelocationBarrier(value: unknown): RelocationSyncBarrier | null {
  try {
    assertFiniteJson(value);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const barrier = value as Record<string, unknown>;
  const incomplete = exactKeys(barrier, ['guidanceId', 'supersededAt']);
  const completed = exactKeys(barrier, ['guidanceId', 'supersededAt', 'syncId', 'finishedAt']);
  if (!incomplete && !completed) return null;
  if (
    typeof barrier.guidanceId !== 'string' || !UUID.test(barrier.guidanceId) ||
    !positiveSafeInteger(barrier.supersededAt)
  ) return null;
  if (
    completed && (!positiveSafeInteger(barrier.syncId) ||
      !positiveSafeInteger(barrier.finishedAt) || barrier.finishedAt < barrier.supersededAt)
  ) {
    return null;
  }
  if (completed) {
    return {
      guidanceId: barrier.guidanceId,
      supersededAt: barrier.supersededAt,
      syncId: barrier.syncId as number,
      finishedAt: barrier.finishedAt as number,
    };
  }
  return { guidanceId: barrier.guidanceId, supersededAt: barrier.supersededAt };
}

export function relocationReservationKind(guidance: RelocationGuidance): 'movie' | 'episode' {
  switch (guidance.service) {
    case 'radarr':
      return 'movie';
  }
}
