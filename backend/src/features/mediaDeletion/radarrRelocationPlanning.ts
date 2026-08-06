import type { RadarrMovieRelocationCandidate } from '../deletionOperations/relocationModel.ts';
import { deriveRelocationNamespace } from '../deletionOperations/relocationModel.ts';
import { arrBasename, arrDirname } from './arrPaths.ts';
import { normalizeRemoteAbsolute } from './hardlinks.ts';
import { appendRemotePath } from './ownership.ts';

export type ArrReassignmentDecisionCode =
  | 'retained_parent_mismatch'
  | 'external_error'
  | 'ordinary_reassignment_available'
  | 'other_unsafe';

export type RadarrRelocationDecision =
  | {
    outcome: 'eligible';
    candidate: RadarrMovieRelocationCandidate;
    decisionCodes: readonly ['retained_parent_mismatch'];
  }
  | {
    outcome: 'ineligible';
    candidate?: never;
    decisionCodes: ArrReassignmentDecisionCode[];
  };

function samePath(left: string, right: string): boolean {
  const a = normalizeRemoteAbsolute(left);
  const b = normalizeRemoteAbsolute(right);
  return a !== null && b !== null && a.separator === b.separator &&
    a.comparison === b.comparison;
}

/**
 * Converts already-resolved Radarr/Plex evidence into the single supported
 * relocation candidate. All Radarr placement policy stays on this side of the
 * reusable relocation contract.
 */
export async function planRadarrMovieRelocation(input: {
  selectedMediaId: number;
  selectedPlexPath: string;
  selectedArrPath: string;
  retainedMediaId: number;
  retainedPlexPath: string;
  retainedArrPath: string;
  retainedFileSize: number | null;
  managedDirectoryPath: string;
  occupiedArrPaths: readonly string[];
  arrInstanceId: number;
  arrInstanceName: string;
  arrRecordId: number;
  arrManagedFileId: number;
  mappingIdentity: string;
  destinationVisibility: (path: string) => Promise<'folder' | 'file' | 'missing'>;
}): Promise<RadarrMovieRelocationCandidate | null> {
  if (
    !Number.isSafeInteger(input.retainedFileSize) || input.retainedFileSize! <= 0 ||
    !samePath(arrDirname(input.selectedArrPath) ?? '', input.managedDirectoryPath) ||
    samePath(arrDirname(input.retainedArrPath) ?? '', input.managedDirectoryPath)
  ) return null;

  const basename = arrBasename(input.retainedArrPath);
  const destinationArrPath = basename
    ? appendRemotePath(input.managedDirectoryPath, basename)
    : null;
  if (!destinationArrPath) return null;
  const destination = normalizeRemoteAbsolute(destinationArrPath);
  if (
    !destination || samePath(destinationArrPath, input.selectedArrPath) ||
    samePath(destinationArrPath, input.retainedArrPath) ||
    input.occupiedArrPaths.some((path) => samePath(path, destinationArrPath)) ||
    await input.destinationVisibility(destinationArrPath) !== 'folder'
  ) return null;

  const namespace = deriveRelocationNamespace(
    input.mappingIdentity,
    input.selectedPlexPath,
    input.retainedPlexPath,
    destination.path,
  );
  if (
    !namespace || !samePath(namespace.selectedArrPath, input.selectedArrPath) ||
    !samePath(namespace.sourceArrPath, input.retainedArrPath)
  ) return null;

  return {
    service: 'radarr',
    mediaType: 'movie',
    reason: 'retained_parent_mismatch',
    selectedMediaId: input.selectedMediaId,
    selectedPlexPath: input.selectedPlexPath,
    selectedArrPath: input.selectedArrPath,
    retainedMediaId: input.retainedMediaId,
    retainedPlexPath: input.retainedPlexPath,
    retainedFileSize: input.retainedFileSize!,
    managedDirectoryPath: input.managedDirectoryPath,
    sourceArrPath: input.retainedArrPath,
    destinationArrPath: destination.path,
    destinationPlexPath: namespace.destinationPlexPath,
    arrInstanceId: input.arrInstanceId,
    arrInstanceName: input.arrInstanceName,
    arrRecordId: input.arrRecordId,
    arrManagedFileId: input.arrManagedFileId,
    mappingIdentity: input.mappingIdentity,
  };
}

export function decideRadarrRelocation(input: {
  mediaType: 'movie' | 'episode';
  decisionCodes: readonly ArrReassignmentDecisionCode[];
  candidates: readonly RadarrMovieRelocationCandidate[];
  managedMediaCount: number;
  managedOwnerCount: number;
}): RadarrRelocationDecision {
  const codes = [...input.decisionCodes];
  if (
    input.mediaType === 'movie' && codes.length === 1 &&
    codes[0] === 'retained_parent_mismatch' && input.candidates.length === 1 &&
    input.managedMediaCount === 1 && input.managedOwnerCount === 1
  ) {
    return {
      outcome: 'eligible',
      candidate: input.candidates[0]!,
      decisionCodes: ['retained_parent_mismatch'],
    };
  }
  return { outcome: 'ineligible', decisionCodes: codes };
}
