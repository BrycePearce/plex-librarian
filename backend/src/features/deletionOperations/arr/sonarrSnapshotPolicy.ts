// Pure comparisons for Sonarr candidate allowlists and whole-series rescan snapshots.
import type {
  SonarrSeriesEpisodeFile,
  SonarrSeriesSnapshot,
  SonarrUntrackedImportCandidate,
} from '../../../integrations/arr/client.ts';
import { normalizeRemoteAbsolute } from '../../mediaDeletion/hardlinks.ts';
import type { PersistedArrReassignment } from '../../mediaDeletion/arrReassignmentPlanning/types.ts';

export type SonarrRescanAuthorizedChange = NonNullable<
  NonNullable<PersistedArrReassignment['sonarrTransition']>['rescanAuthorizedChanges']
>[number];

function sameRemotePath(left: string | null, right: string): boolean {
  const normalizedLeft = left ? normalizeRemoteAbsolute(left)?.comparison : null;
  const normalizedRight = normalizeRemoteAbsolute(right)?.comparison;
  return normalizedLeft !== null && normalizedLeft !== undefined &&
    normalizedLeft === normalizedRight;
}

export function findAuthorizedSonarrCandidate(
  file: Pick<SonarrSeriesEpisodeFile, 'path' | 'size'>,
  candidates: readonly SonarrRescanAuthorizedChange['candidates'][number][],
): SonarrRescanAuthorizedChange['candidates'][number] | undefined {
  return candidates.find((candidate) =>
    sameRemotePath(file.path, candidate.path) && file.size === candidate.size
  );
}

export function sonarrInventoryHasOnlyAuthorizedCandidates(
  inventory: readonly SonarrUntrackedImportCandidate[],
  authorized: readonly SonarrRescanAuthorizedChange[],
): boolean {
  return !inventory.some((candidate) =>
    candidate.rejectionReasons.length === 0 &&
    (candidate.episodeIds.length !== 1 ||
      !authorized.some((change) =>
        change.episodeId === candidate.episodeIds[0] &&
        findAuthorizedSonarrCandidate(candidate, change.candidates) !== undefined
      ))
  );
}

export function sonarrRescanHasOnlyAuthorizedChange(
  before: SonarrSeriesSnapshot,
  after: SonarrSeriesSnapshot,
  episodeId: number,
  adoptedFileId: number | null,
): boolean {
  const episode = before.episodes.find((entry) => entry.id === episodeId);
  if (!episode) return false;
  const adopted = adoptedFileId === null
    ? []
    : after.files.flatMap((file) =>
      file.id === adoptedFileId ? [{ mediaId: 0, path: file.path, size: file.size }] : []
    );
  return sonarrRescanHasOnlyAuthorizedChanges(before, after, [{
    targetId: 0,
    episodeId,
    oldFileId: episode.episodeFileId,
    candidates: adopted,
  }]);
}

export function sonarrRescanHasOnlyAuthorizedChanges(
  before: SonarrSeriesSnapshot,
  after: SonarrSeriesSnapshot,
  authorized: readonly SonarrRescanAuthorizedChange[],
): boolean {
  const byId = <T extends { id: number }>(values: readonly T[]) =>
    [...values].sort((left, right) => left.id - right.id);
  const authorization = new Map(authorized.map((change) => [change.episodeId, change]));
  if (authorization.size !== authorized.length) return false;
  const beforeEpisodes = new Map(before.episodes.map((episode) => [episode.id, episode]));
  const beforeFiles = new Map(before.files.map((file) => [file.id, file]));
  const adoptedFileIds = new Set<number>();
  const replacedOldFileIds = new Set<number>();
  const normalizedAfterEpisodes = after.episodes.map((episode) => {
    const change = authorization.get(episode.id);
    if (!change) return episode;
    const previous = beforeEpisodes.get(episode.id);
    if (!previous || previous.episodeFileId !== change.oldFileId) return episode;
    const normalizedMonitoring = change.restoredMonitored !== undefined &&
        episode.monitored === change.restoredMonitored
      ? { ...episode, monitored: previous.monitored }
      : episode;
    if (episode.episodeFileId === previous.episodeFileId) return normalizedMonitoring;
    if (episode.episodeFileId === 0) return episode;
    const file = after.files.find((candidate) => candidate.id === episode.episodeFileId);
    if (
      !file || file.id === change.oldFileId || file.episodeIds.length !== 1 ||
      file.episodeIds[0] !== episode.id ||
      findAuthorizedSonarrCandidate(file, change.candidates) === undefined
    ) {
      return episode;
    }
    adoptedFileIds.add(file.id);
    if (change.oldFileId > 0) {
      replacedOldFileIds.add(change.oldFileId);
    }
    return { ...normalizedMonitoring, episodeFileId: previous.episodeFileId };
  });
  const normalizedAfterFiles = after.files.filter((file) => !adoptedFileIds.has(file.id));
  for (const oldFileId of replacedOldFileIds) {
    if (after.files.some((file) => file.id === oldFileId)) return false;
    const oldFile = beforeFiles.get(oldFileId);
    if (!oldFile) return false;
    normalizedAfterFiles.push(oldFile);
  }
  return JSON.stringify(byId(before.episodes)) ===
      JSON.stringify(byId(normalizedAfterEpisodes)) &&
    JSON.stringify(byId(before.files)) === JSON.stringify(byId(normalizedAfterFiles));
}
