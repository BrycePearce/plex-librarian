import type { DownloadCleanupPreviewItem } from '../../../../shared/types.ts';
import { buildOrdinaryDeletionPlan, type OrdinaryDeletionPlan } from './ordinaryPlanning.ts';
import { retainedPlexScopeErrors, type RetainedPlexScopeInput } from './ordinaryScope.ts';
type Input = Omit<
  Parameters<typeof buildOrdinaryDeletionPlan>[0],
  'arrSelected' | 'qbSelected' | 'retainedPlexCheck' | 'onPlexFiles'
>;
type Scope = {
  plan?: OrdinaryDeletionPlan;
  error?: string;
  discoveredPlexFiles?: OrdinaryDeletionPlan['plexFiles'];
};

export async function ordinaryPreview(input: Input): Promise<DownloadCleanupPreviewItem> {
  return (await ordinaryPreviews([input]))[0];
}
/** Prepare bounded selections, then inspect retained entries once for every choice.
 * No deferred plan is exposed until its retained-media check has completed. */
export async function ordinaryPreviews(
  inputs: readonly Input[],
): Promise<DownloadCleanupPreviewItem[]> {
  const all: Scope[][] = [];
  const pending: Array<{ scope: Scope; check: RetainedPlexScopeInput }> = [];
  for (const input of inputs) {
    const scopes: Scope[] = [];
    all.push(scopes);
    for (
      const [arrSelected, qbSelected] of [[false, false], [true, false], [false, true], [
        true,
        true,
      ]]
    ) {
      const scope: Scope = {};
      scopes.push(scope);
      try {
        let check: RetainedPlexScopeInput | undefined;
        scope.plan = await buildOrdinaryDeletionPlan({
          ...input,
          arrSelected,
          qbSelected,
          onPlexFiles: (files) => {
            scope.discoveredPlexFiles = files;
          },
          retainedPlexCheck: (value) => {
            check = value;
            return Promise.resolve();
          },
        });
        if (!check) throw new Error('Retained Plex scope was not prepared');
        pending.push({ scope, check });
      } catch (error) {
        scope.plan = undefined;
        scope.error = error instanceof Error
          ? error.message
          : 'Current service scope could not be verified';
      }
    }
  }
  try {
    const errors = await retainedPlexScopeErrors(pending.map((entry) => entry.check));
    for (const [index, error] of errors.entries()) {
      if (error) {
        pending[index].scope.plan = undefined;
        pending[index].scope.error = error;
      }
    }
  } catch (error) {
    for (const { scope } of pending) {
      scope.plan = undefined;
      scope.error = error instanceof Error ? error.message : 'Retained Plex scope is unavailable';
    }
  }
  return inputs.map((input, index) => presentPreview(input, all[index]));
}
function presentPreview(input: Input, scopes: Scope[]): DownloadCleanupPreviewItem {
  const [plex, arr, qb, both] = scopes;
  const cleanup = input.arrTargets.length ? both : qb;
  const shown = both.plan ?? qb.plan ?? arr.plan ?? plex.plan;
  const managed = both.plan ?? arr.plan;
  const downloads = both.plan ?? qb.plan;
  const plexFiles = shown?.plexFiles ?? plex.discoveredPlexFiles;
  return {
    ratingKey: input.selection.ratingKey,
    plexPaths: plexFiles?.map((file) => file.path) ?? [],
    plexPathStatus: plexFiles ? 'resolved' : 'error',
    plexPathsTruncated: false,
    plexPathReason: plexFiles ? undefined : plex.error,
    status: cleanup.plan ? 'resolved' : 'error',
    reason: cleanup.error,
    arrStatus: managed ? 'resolved' : 'unavailable',
    arrReason: arr.error,
    arrTargets: managed?.arr.map((scope) => ({
      instanceName: scope.instanceName,
      type: scope.type,
      title: input.selection.title,
      path: scope.path,
      seasons: null,
      mediaFiles: scope.files.map((file) => ({ relativePath: file.path, size: file.size })),
      extraFiles: null,
    })) ?? [],
    downloadJobs: downloads?.jobs.map(({ job, instanceKey }) => ({
      ...job,
      provider: 'qbittorrent',
      instanceKey,
      instanceName: input.downloadTargets.find((target) =>
        target.instanceKey === instanceKey
      )!.instanceName,
      jobId: job.id,
      sourcePath: null,
    })) ?? [],
    sources: [],
    orphanFiles: [],
    retainedPaths: [],
    plexOnlyStatus: plex.plan ? 'resolved' : 'error',
    plexOnlyReason: plex.error,
    plexOnlyFingerprint: plex.plan?.fingerprint,
    sonarrCleanupStatus: arr.plan ? 'resolved' : 'error',
    sonarrCleanupReason: arr.error,
    sonarrCleanupFingerprint: arr.plan?.fingerprint,
    qbittorrentOnlyStatus: qb.plan ? 'resolved' : 'error',
    qbittorrentOnlyReason: qb.error,
    qbittorrentOnlyFingerprint: qb.plan?.fingerprint,
    cleanupFingerprint: cleanup.plan?.fingerprint,
    noJobReason: downloads?.noJobReason,
  };
}
