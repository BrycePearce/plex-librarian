import {
  configuredStoragePath,
  storageContains,
  storagePath,
} from '../../../../shared/serviceStorage.ts';
import type { OrdinaryDeletionPlan } from './ordinaryPlanning.ts';
import type { PlexClient } from '../../integrations/plex/client.ts';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import {
  type DownloadClientTarget,
  downloadJobManifestFingerprint,
  downloadJobSummaryFingerprint,
} from './downloadClient.ts';
import { appendRemotePath } from './ownership.ts';
import {
  assertRetainedPlexScope,
  type OrdinaryStorageScope,
  type RetainedPlexCheck,
} from './ordinaryScope.ts';

/** Recheck vetoes before each service mutation, including after earlier successful steps. */
export async function assertCurrentOrdinaryProtection(
  plan: OrdinaryDeletionPlan,
  plex: PlexClient,
  arrTargets: readonly ArrDeleteTarget[],
  downloadTargets: readonly DownloadClientTarget[],
  completed: ReadonlySet<string>,
  retainedCheck: RetainedPlexCheck = assertRetainedPlexScope,
): Promise<void> {
  const map = (key: string, path: string) => configuredStoragePath(plan.roots, key, path);
  const mapped = plan.arrSelected || downloadTargets.length > 0;
  const scopes: OrdinaryStorageScope[] = [
    ...plan.plexFiles.map((file) => ({
      path: mapped ? map(`plex:${plan.libraryKey}`, file.path) : file.path,
      directory: false,
    })),
    ...plan.arr.flatMap((scope) =>
      scope.directory
        ? [{ path: map(scope.serviceKey, scope.path), directory: true }]
        : scope.files.map((file) => ({ path: map(scope.serviceKey, file.path), directory: false }))
    ),
    ...plan.jobs.flatMap((selected) =>
      selected.job.manifestFiles.map((file) => ({
        path: map(selected.serviceKey, appendRemotePath(selected.job.savePath, file.path)!),
        directory: false,
      }))
    ),
  ];
  await retainedCheck({
    plex,
    libraryKey: plan.libraryKey,
    selection: plan.selection,
    roots: plan.roots,
    scopes,
    mapped,
  });
  for (const target of downloadTargets) {
    if (!target.client.scanJobSummaries) {
      throw new Error('Current download inventory is unavailable');
    }
    await target.client.scanJobSummaries(async (summary) => {
      const folder = map(`qb:${target.instanceKey}`, summary.contentPath);
      if (
        !scopes.some((scope) =>
          storageContains(folder, scope.path, false) ||
          scope.directory && storageContains(scope.path, folder, false)
        )
      ) return;
      const current = await target.client.findJob(summary.id);
      if (
        !current || current.filesTruncated || current.fileCount !== current.manifestFiles.length
      ) throw new Error('Current download manifest is incomplete');
      const selected = plan.jobs.find((entry) =>
        entry.instanceKey === target.instanceKey && entry.job.id === summary.id
      );
      if (selected) {
        if (
          await downloadJobSummaryFingerprint(current) !== selected.summaryFingerprint ||
          await downloadJobManifestFingerprint(current) !== selected.manifestFingerprint
        ) throw new Error('The accepted download was moved or changed');
        return;
      }
      if (
        current.manifestFiles.some((file) => {
          const path = map(
            `qb:${target.instanceKey}`,
            appendRemotePath(current.savePath, file.path)!,
          );
          return scopes.some((scope) =>
            scope.path.toLowerCase() === path.toLowerCase() ||
            scope.directory && storageContains(scope.path, path, false)
          );
        })
      ) throw new Error('A retained download now owns a selected file or directory entry');
    });
  }
  const inventories = new Map<number, Array<{ id: number; path: string }>>();
  for (const target of plan.arrSelected ? arrTargets : []) {
    const inventory = await target.client.managedScopes();
    inventories.set(target.instanceId, inventory);
    for (const other of inventory) {
      if (
        plan.arr.some((selected) =>
          selected.instanceId === target.instanceId && selected.recordId === other.id
        )
      ) continue;
      const path = map(`arr:${target.instanceId}`, other.path);
      if (
        scopes.some((scope) =>
          scope.directory && storageContains(scope.path, path, false) ||
          storageContains(path, scope.path, false)
        )
      ) throw new Error('A managed directory overlaps a retained title');
    }
  }
  for (const selected of plan.arr) {
    const target = arrTargets.find((target) => target.instanceId === selected.instanceId);
    if (!target) throw new Error('An accepted media manager is missing');
    const inventory = inventories.get(target.instanceId)!;
    if (completed.has(`arr:${selected.instanceId}:${selected.recordId}`)) continue;
    if (
      !selected.directory && selected.files.every((file) =>
        completed.has(`arr-file:${selected.instanceId}:${file.id}`)
      ) && selected.episodes.every((episode) =>
        !episode.monitored || completed.has(`arr-monitor:${selected.instanceId}:${episode.id}`)
      )
    ) continue;
    const current = inventory.find((entry) => entry.id === selected.recordId);
    if (!current || storagePath(current.path) !== storagePath(selected.path)) {
      throw new Error('The selected managed title was moved or removed');
    }
    if (selected.type === 'sonarr') {
      if (!(await target.client.sonarrSeriesActivity(selected.recordId)).quiet) {
        throw new Error('Sonarr is updating the selected title');
      }
      const state = await target.client.sonarrSeriesSnapshot(selected.recordId);
      const ids = new Set(selected.episodes.map((episode) => episode.id));
      const currentEpisodes = state.episodes.filter((episode) =>
        plan.selection.type !== 'season' || episode.seasonNumber === plan.selection.seasonIndex
      );
      if (
        currentEpisodes.length !== ids.size ||
        currentEpisodes.some((episode) =>
          !selected.episodes.some((expected) =>
            expected.id === episode.id && expected.seasonNumber === episode.seasonNumber &&
            expected.episodeNumber === episode.episodeNumber
          )
        )
      ) throw new Error('The managed episode scope changed');
      for (const file of state.files) {
        if (file.episodeIds.some((id) => ids.has(id))) {
          if (
            !selected.files.some((expected) =>
              expected.id === file.id && storagePath(expected.path) === storagePath(file.path) &&
              expected.size === file.size &&
              expected.episodeIds.length === file.episodeIds.length && file.episodeIds.every((id) =>
                expected.episodeIds.includes(id)
              )
            )
          ) throw new Error('A selected managed file changed or now contains retained episodes');
        } else {
          const path = map(selected.serviceKey, file.path);
          if (
            scopes.some((scope) =>
              scope.path.toLowerCase() === path.toLowerCase() ||
              scope.directory && storageContains(scope.path, path, false)
            )
          ) throw new Error('Selected deletion overlaps a retained managed episode');
        }
      }
    } else {
      const file = await target.client.radarrManagedFile(selected.recordId);
      if (
        file &&
        !selected.files.some((expected) =>
          expected.id === file.id && file.path !== null &&
          storagePath(expected.path) === storagePath(file.path) &&
          expected.size === file.size
        )
      ) throw new Error('Radarr selected file scope changed');
    }
  }
}
