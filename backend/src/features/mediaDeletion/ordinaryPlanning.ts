import type { PlexClient } from '../../integrations/plex/client.ts';
import type { PlexSeasonDeletionEpisode } from '../../integrations/plex/types.ts';
import type { ArrDeleteTarget, CoordinatedDeleteItem } from '../arr/delete.ts';
import type { DownloadClientTarget, DownloadJob } from './downloadClient.ts';
import { downloadJobManifestFingerprint, downloadJobSummaryFingerprint } from './downloadClient.ts';
import {
  configuredStoragePath,
  type ServicePathRoot,
  type ServiceStorageEndpoint,
  storageContains,
  storagePath,
} from '../../../../shared/serviceStorage.ts';
import {
  assertRootConfigurations,
  evidenceFingerprint,
  loadServiceRoots,
} from './serviceStorage.ts';
import { appendRemotePath } from './ownership.ts';
import { activeWholeItemRatingKeys } from './activePlayback.ts';
import { withTransaction } from '../../db/index.ts';
import { assertArrDeleteIsUnambiguous, findAmbiguousExternalIds } from '../arr/delete.ts';
import { assertCurrentOrdinaryProtection } from './ordinaryProtection.ts';
import type { RetainedPlexCheck } from './ordinaryScope.ts';

export interface OrdinarySelection extends CoordinatedDeleteItem {
  ratingKey: string;
  showRatingKey?: string;
  seasonIndex?: number;
}
export interface OrdinaryArrScope {
  instanceId: number;
  serviceKey: string;
  instanceName: string;
  type: 'sonarr' | 'radarr';
  recordId: number;
  path: string;
  mappingIdentity: string;
  configurationUpdatedAt: number;
  version?: string;
  files: Array<{ id: number; path: string; size: number; episodeIds: number[] }>;
  episodes: Array<
    {
      id: number;
      seasonNumber: number;
      episodeNumber: number;
      monitored: boolean;
      episodeFileId: number;
    }
  >;
  directory: boolean;
}
export interface OrdinaryJob {
  instanceKey: string;
  serviceKey: string;
  job: DownloadJob;
  summaryFingerprint: string;
  manifestFingerprint: string;
}
export interface OrdinaryDeletionPlan {
  policyVersion: 2;
  serverId: number;
  libraryKey: string;
  selection: OrdinarySelection;
  arrSelected: boolean;
  qbSelected: boolean;
  connections: ServiceStorageEndpoint[];
  roots: ServicePathRoot[];
  plexFiles: Array<{ path: string; size: number }>;
  /** Absent only on previously accepted plans. Never infer IDs for legacy evidence. */
  plexVersionFiles?: Array<{ ratingKey: string; mediaId: number; path: string; size: number }>;
  arr: OrdinaryArrScope[];
  jobs: OrdinaryJob[];
  qbInventory: Array<{ serviceKey: string; fingerprint: string }>;
  noJobReason?: string;
  fingerprint: string;
}

export function ordinaryPlanFingerprint(plan: Omit<OrdinaryDeletionPlan, 'fingerprint'>): string {
  return evidenceFingerprint({
    ...plan,
    jobs: plan.jobs.map(({ job, ...evidence }) => ({ ...evidence, id: job.id })),
  });
}

/** One eligibility policy shared by preview, enqueue and the durable worker. No filesystem IO. */
interface OrdinaryPlanningInput {
  serverId: number;
  libraryKey: string;
  selection: OrdinarySelection;
  arrSelected: boolean;
  qbSelected: boolean;
  plex: PlexClient;
  arrTargets: readonly ArrDeleteTarget[];
  downloadTargets: readonly DownloadClientTarget[];
  roots: ServicePathRoot[];
  connections: ServiceStorageEndpoint[];
  seasonEpisodes?: readonly PlexSeasonDeletionEpisode[];
  retainedPlexCheck?: RetainedPlexCheck;
  /** Display-only discovery; it never grants eligibility or supplies accepted evidence. */
  onPlexFiles?: (files: OrdinaryDeletionPlan['plexFiles']) => void;
}

class MissingDownloadRoot extends Error {
  constructor(readonly serviceKey: string, readonly path: string) {
    super(
      `Current qBittorrent storage needs discovery refresh for ${serviceKey}. Review Media connections if it remains unavailable.`,
    );
  }
}

export async function buildOrdinaryDeletionPlan(
  input: OrdinaryPlanningInput,
): Promise<OrdinaryDeletionPlan> {
  try {
    return await prepareOrdinaryDeletionPlan(input);
  } catch (error) {
    if (!(error instanceof MissingDownloadRoot)) throw error;
    const { refreshMissingDownloadRoot } = await import('../settings/hostDiscovery.ts');
    await refreshMissingDownloadRoot(input.serverId, error.serviceKey);
    const roots = await loadServiceRoots(input.serverId);
    if (
      !roots.some((root) =>
        root.serviceKey === error.serviceKey &&
        storageContains(root.serviceRoot, error.path, root.caseSensitive)
      )
    ) throw error;
    // Rebuild all comparisons and the fingerprint; never patch an accepted plan or
    // reuse path comparisons made before discovery published a different mapping.
    return await prepareOrdinaryDeletionPlan({
      ...input,
      roots,
    });
  }
}

async function prepareOrdinaryDeletionPlan(
  input: OrdinaryPlanningInput,
): Promise<OrdinaryDeletionPlan> {
  const { selection, arrSelected, qbSelected } = input;
  if (qbSelected && input.downloadTargets.length === 0) {
    throw new Error('qBittorrent is not configured for the selected scope');
  }
  const live = await input.plex.metadataIdentity(selection.ratingKey);
  if (
    !live || live.type !== selection.type || live.title !== selection.title ||
    live.librarySectionId !== null && live.librarySectionId !== input.libraryKey ||
    selection.type === 'movie' && live.tmdbId !== selection.tmdbId ||
    selection.type === 'show' && live.tvdbId !== selection.tvdbId
  ) throw new Error('The current Plex identity no longer matches the selected media');
  if (
    activeWholeItemRatingKeys(
      new Set([selection.ratingKey, selection.showRatingKey ?? selection.ratingKey]),
      await input.plex.activeSessions(),
    ).size
  ) throw new Error('The selected media is playing');
  if (arrSelected) {
    assertArrDeleteIsUnambiguous(
      selection,
      withTransaction((client) =>
        findAmbiguousExternalIds(
          client,
          input.serverId,
          selection.type === 'movie' ? 'movie' : 'show',
          [selection.type === 'movie' ? selection.tmdbId! : selection.tvdbId!],
        )
      ),
    );
  }
  const serviceKeys = new Set([
    `plex:${input.libraryKey}`,
    ...input.connections.filter((entry) => entry.key.startsWith('plex:')).map((entry) => entry.key),
    ...input.downloadTargets.map((target) => `qb:${target.instanceKey}`),
    ...(arrSelected || qbSelected
      ? input.arrTargets.map((target) => `arr:${target.instanceId}`)
      : []),
  ]);
  const connections = input.connections.filter((entry) => serviceKeys.has(entry.key)).map((
    entry,
  ) => ({ ...entry, roots: [], discoveryError: undefined })).sort((a, b) =>
    a.key.localeCompare(b.key)
  );
  const roots = input.roots.filter((root) => serviceKeys.has(root.serviceKey)).sort((a, b) =>
    a.id - b.id
  );
  const mapped = (key: string, path: string) => {
    assertRootConfigurations(
      roots.filter((root) =>
        root.serviceKey === key && storageContains(root.serviceRoot, path, root.caseSensitive)
      ),
      connections,
    );
    return configuredStoragePath(roots, key, path);
  };
  const plexFiles: OrdinaryDeletionPlan['plexFiles'] = [];
  let plexVersionFiles: OrdinaryDeletionPlan['plexVersionFiles'];
  if (selection.type === 'season') {
    const episodes = input.seasonEpisodes ??
      await input.plex.seasonDeletionEpisodes(selection.ratingKey);
    if (
      !episodes.length ||
      episodes.some((episode) =>
        episode.showRatingKey !== selection.showRatingKey ||
        episode.seasonIndex !== selection.seasonIndex
      )
    ) throw new Error('The selected Plex season membership changed');
    plexVersionFiles = [];
    for (const episode of episodes) {
      for (const media of episode.media) {
        for (const part of media.paths) {
          plexFiles.push({ path: storagePath(part.path), size: part.byteSize });
          plexVersionFiles.push({
            ratingKey: episode.ratingKey,
            mediaId: media.mediaId,
            path: storagePath(part.path),
            size: part.byteSize,
          });
        }
      }
    }
  } else {
    const paths = await input.plex.mediaPathPreview(
      selection.ratingKey,
      selection.type,
      undefined,
      undefined,
      true,
      true,
    );
    plexVersionFiles = paths.versionFiles?.map((file) => ({
      ...file,
      path: storagePath(file.path),
    }));
    if (paths.truncated) {
      throw new Error('The complete current Plex file scope exceeds the preview limit');
    }
    for (const path of paths.paths) {
      plexFiles.push({ path: storagePath(path), size: paths.fileSizes?.[path] ?? 0 });
    }
  }
  if (
    !plexFiles.length ||
    plexFiles.some((file) => !Number.isSafeInteger(file.size) || file.size <= 0)
  ) throw new Error('Complete current Plex file paths and sizes are required');
  const uniquePlex = new Map<string, { path: string; size: number }>();
  for (const file of plexFiles) {
    if (uniquePlex.has(file.path) && uniquePlex.get(file.path)!.size !== file.size) {
      throw new Error('Conflicting Plex file sizes');
    }
    uniquePlex.set(file.path, file);
  }
  input.onPlexFiles?.([...uniquePlex.values()].map((file) => ({ ...file })));
  if (arrSelected) {
    assertRootConfigurations(
      roots.filter((root) => root.serviceKey.startsWith('plex:')),
      connections,
    );
  }
  const arr: OrdinaryArrScope[] = [];
  const retained: Array<{ serviceKey: string; path: string }> = [];
  const histories: Array<
    {
      serviceKey: string;
      instanceId: number;
      recordId: number;
      hash: string;
      sourcePath: string | null;
      importedPath: string | null;
    }
  > = [];
  const folderInventories: Array<{ serviceKey: string; id: number; path: string }> = [];
  let advisoryUnavailable = false;
  const externalId = selection.type === 'movie' ? selection.tmdbId : selection.tvdbId;
  for (const target of arrSelected || qbSelected ? input.arrTargets : []) {
    const checkpoint = [retained.length, histories.length, folderInventories.length];
    try {
      if (!Number.isSafeInteger(externalId) || externalId! <= 0) {
        throw new Error('No exact Arr external identity is available');
      }
      const record = await target.client.lookup(externalId!);
      if (!record) continue;
      if (!record.path) throw new Error('The managed record has no current folder');
      const scope: OrdinaryArrScope = {
        instanceId: target.instanceId,
        serviceKey: `arr:${target.instanceId}`,
        instanceName: target.instanceName,
        type: target.instanceType,
        recordId: record.id,
        path: storagePath(record.path),
        mappingIdentity: target.mappingIdentity,
        configurationUpdatedAt: target.configurationUpdatedAt,
        files: [],
        episodes: [],
        directory: selection.type !== 'season',
      };
      if (target.instanceType === 'sonarr') {
        const state = await target.client.sonarrSeriesSnapshot(record.id);
        if (arrSelected) {
          const capabilities = await target.client.sonarrSeasonCoordinationCapabilities();
          if (!capabilities.available || !capabilities.version) {
            throw new Error(capabilities.reason ?? 'Unsupported Sonarr version');
          }
          scope.version = capabilities.version;
          const activity = await target.client.sonarrSeriesActivity(record.id);
          if (!activity.quiet) {
            throw new Error(
              'Sonarr is updating or importing this selection. Try again when it finishes.',
            );
          }
        }
        scope.episodes = state.episodes.filter((episode) =>
          selection.type !== 'season' || episode.seasonNumber === selection.seasonIndex
        );
        const ids = new Set(scope.episodes.map((episode) => episode.id));
        scope.files = state.files.filter((file) => file.episodeIds.some((id) => ids.has(id)));
        if (
          scope.files.some((file) =>
            file.episodeIds.length === 0 || file.episodeIds.some((id) => !ids.has(id))
          )
        ) throw new Error('A managed multi-episode file contains an unselected episode');
        if (
          selection.type === 'season' &&
          input.seasonEpisodes?.some((episode) =>
            !scope.episodes.some((managed) => managed.episodeNumber === episode.episodeIndex)
          )
        ) throw new Error('Sonarr does not contain every selected season episode');
        for (
          const file of state.files.filter((file) =>
            !scope.files.some((selected) => selected.id === file.id)
          )
        ) retained.push({ serviceKey: scope.serviceKey, path: file.path });
      } else {
        const managedFile = await target.client.radarrManagedFile(record.id);
        const files = managedFile ? [managedFile] : [];
        if (files.some((file) => !file.id || !file.path || !file.size)) {
          throw new Error('Radarr current file identity is incomplete');
        }
        scope.files = files.map((file) => ({
          id: file.id!,
          path: file.path!,
          size: file.size!,
          episodeIds: [],
        }));
      }
      if (arrSelected && scope.directory) {
        for (const other of await target.client.managedScopes()) {
          folderInventories.push({ serviceKey: scope.serviceKey, ...other });
          if (
            other.id !== scope.recordId &&
            (storageContains(scope.path, other.path, false) ||
              storageContains(other.path, scope.path, false))
          ) {
            throw new Error(
              'The managed folder is shared with or nested inside another title. Broad folder deletion is blocked.',
            );
          }
        }
      }
      if (qbSelected) {
        for (const association of await target.client.torrentAssociations(record.id)) {
          histories.push({
            serviceKey: scope.serviceKey,
            instanceId: target.instanceId,
            recordId: record.id,
            ...association,
          });
        }
      }
      if (scope.files.some((file) => !storageContains(scope.path, file.path, false))) {
        throw new Error('A managed file lies outside its current title folder');
      }
      arr.push(scope);
    } catch (error) {
      if (arrSelected) throw error;
      advisoryUnavailable = true;
      retained.length = checkpoint[0];
      histories.length = checkpoint[1];
      folderInventories.length = checkpoint[2];
      // An unselected manager is advisory. Exact current Plex/QB entries can suffice.
    }
  }
  if (arrSelected && !arr.length) throw new Error('No exact current Arr destination was found');
  if (arrSelected) {
    for (const file of uniquePlex.values()) mapped(`plex:${input.libraryKey}`, file.path);
    for (const scope of arr) {
      mapped(scope.serviceKey, scope.path);
      for (const file of scope.files) mapped(scope.serviceKey, file.path);
    }
  }
  // Across instances, path strings carry no storage identity without configured roots.
  if (arrSelected && arr.length > 1) {
    for (const scope of arr) {
      for (const other of folderInventories) {
        if (scope.serviceKey === other.serviceKey && scope.recordId === other.id) continue;
        const a = mapped(scope.serviceKey, scope.path), b = mapped(other.serviceKey, other.path);
        if (storageContains(a, b, false) || storageContains(b, a, false)) {
          throw new Error('Managed folders overlap across service instances');
        }
      }
    }
  }
  const jobs: OrdinaryJob[] = [], qbInventory: OrdinaryDeletionPlan['qbInventory'] = [];
  let historyRequired = false;
  let currentJobCount = 0;
  if (input.downloadTargets.length) {
    // A complete empty inventory has no ownership dependency on storage mappings.
    // Resolve paths only when a current job actually needs to be compared.
    let selectedPaths: Array<{ path: string; size: number; storage: string }> = [];
    let deleteScopes: Array<{ path: string; directory: boolean }> = [];
    let retainedPaths: string[] = [];
    const preparePaths = () => {
      if (selectedPaths.length) return;
      assertRootConfigurations(
        roots.filter((root) => root.serviceKey.startsWith('plex:')),
        connections,
      );
      selectedPaths = [...uniquePlex.values()].map((file) => ({
        ...file,
        storage: mapped(`plex:${input.libraryKey}`, file.path),
      }));
      deleteScopes = [
        ...selectedPaths.map((file) => ({ path: file.storage, directory: false })),
        ...(arrSelected
          ? arr.flatMap((scope) =>
            scope.directory
              ? [{ path: mapped(scope.serviceKey, scope.path), directory: true }]
              : scope.files.map((file) => ({
                path: mapped(scope.serviceKey, file.path),
                directory: false,
              }))
          )
          : []),
      ];
      retainedPaths = retained.map((file) => mapped(file.serviceKey, file.path));
    };
    const selectedManaged = arr.flatMap((scope) =>
      scope.files.map((file) => ({ ...file, serviceKey: scope.serviceKey }))
    );
    for (const target of input.downloadTargets) {
      if (!target.client.scanJobSummaries) {
        throw new Error('Complete current qBittorrent inventory is unavailable');
      }
      const key = `qb:${target.instanceKey}`, relevant = new Set<string>();
      const associated = new Set(
        histories.filter((source) =>
          !source.importedPath || !retained.some((file) =>
            file.serviceKey === source.serviceKey &&
            storagePath(file.path) === storagePath(source.importedPath!)
          )
        ).map((source) => source.hash),
      );
      const first = await target.client.scanJobSummaries((summary) => {
        currentJobCount++;
        preparePaths();
        if (
          !roots.some((root) =>
            root.serviceKey === key &&
            storageContains(root.serviceRoot, summary.contentPath, root.caseSensitive)
          )
        ) {
          throw new MissingDownloadRoot(key, summary.contentPath);
        }
        const path = mapped(key, summary.contentPath);
        if (
          associated.has(summary.id) ||
          deleteScopes.some((scope) =>
            storageContains(path, scope.path, false) ||
            scope.directory && storageContains(scope.path, path, false)
          )
        ) relevant.add(summary.id);
        if (relevant.size > 500) throw new Error('Too many affected download jobs');
        return Promise.resolve();
      });
      for (const hash of relevant) {
        const job = await target.client.findJob(hash);
        if (
          !job || job.id !== hash || job.filesTruncated || !job.fileCount ||
          job.fileCount !== job.manifestFiles.length
        ) throw new Error('A current download changed or its complete manifest is unavailable');
        const payload = job.manifestFiles.map((file) => {
          const path = appendRemotePath(job.savePath, file.path);
          if (!path || !Number.isSafeInteger(file.size) || file.size! < 0) {
            throw new Error('Invalid current download manifest');
          }
          return { path, storage: mapped(key, path), size: file.size! };
        });
        const affected = payload.some((file) =>
          deleteScopes.some((scope) =>
            scope.path.toLowerCase() === file.storage.toLowerCase() ||
            scope.directory && storageContains(scope.path, file.storage, false)
          )
        );
        if (!qbSelected) {
          if (affected) {
            throw new Error(
              'A retained qBittorrent job owns an exact entry or folder selected for deletion. Select eligible qBittorrent cleanup or change the selection.',
            );
          }
          continue;
        }
        if (
          payload.some((file) =>
            retainedPaths.some((path) => path.toLowerCase() === file.storage.toLowerCase())
          )
        ) throw new Error('A download payload overlaps retained media');
        for (const file of payload) {
          const direct = selectedPaths.some((selected) =>
            selected.storage === file.storage && selected.size === file.size
          );
          const associatedFile = !direct && histories.some((source) => {
            if (source.hash !== hash || !source.sourcePath || !source.importedPath) return false;
            const managed = selectedManaged.find((selected) =>
              selected.serviceKey === source.serviceKey &&
              storagePath(selected.path) === storagePath(source.importedPath!)
            );
            return managed?.size === file.size &&
              mapped(source.serviceKey, source.sourcePath) === file.storage;
          });
          if (!direct && !associatedFile) {
            throw new Error(
              'A matching download contains unmatched files, extras, or unselected episodes. Its complete payload cannot be deleted.',
            );
          }
        }
        const usesHistory = payload.some((file) =>
          !selectedPaths.some((selected) =>
            selected.storage === file.storage && selected.size === file.size
          )
        );
        if (usesHistory) {
          historyRequired = true;
          assertArrDeleteIsUnambiguous(
            selection,
            withTransaction((client) =>
              findAmbiguousExternalIds(
                client,
                input.serverId,
                selection.type === 'movie' ? 'movie' : 'show',
                [externalId!],
              )
            ),
          );
        }
        for (const manager of input.arrTargets) {
          const record = arr.find((scope) => scope.instanceId === manager.instanceId);
          // Cross-series history is required when history supplied association evidence.
          if (
            usesHistory &&
            !await manager.client.downloadIdIsExclusiveTo(record?.recordId ?? null, hash)
          ) throw new Error('A shared download is associated with another title');
        }
        jobs.push({
          instanceKey: target.instanceKey,
          serviceKey: key,
          job,
          summaryFingerprint: await downloadJobSummaryFingerprint(job),
          manifestFingerprint: await downloadJobManifestFingerprint(job),
        });
      }
      const second = await target.client.scanJobSummaries(() => Promise.resolve());
      if (first !== second) {
        throw new Error('Current download scope changed during preview; refresh it');
      }
      qbInventory.push({ serviceKey: key, fingerprint: first });
    }
    const selectedPayload = jobs.flatMap((selected) =>
      selected.job.manifestFiles.map((file) =>
        mapped(selected.serviceKey, appendRemotePath(selected.job.savePath, file.path)!)
      )
    );
    if (
      qbSelected && advisoryUnavailable && currentJobCount > 0 &&
      !selectedPaths.every((file) => selectedPayload.includes(file.storage))
    ) {
      throw new Error(
        'Current download association is unknown while the media manager is unavailable',
      );
    }
    if (selectedPayload.length) {
      for (const target of input.downloadTargets) {
        const key = `qb:${target.instanceKey}`;
        const fingerprint = await target.client.scanJobSummaries!(async (summary) => {
          if (
            jobs.some((selected) =>
              selected.instanceKey === target.instanceKey && selected.job.id === summary.id
            )
          ) return;
          const folder = mapped(key, summary.contentPath);
          if (!selectedPayload.some((path) => storageContains(folder, path, false))) return;
          const retainedJob = await target.client.findJob(summary.id);
          if (
            !retainedJob || retainedJob.filesTruncated ||
            retainedJob.fileCount !== retainedJob.manifestFiles.length
          ) throw new Error('A retained download manifest could not be verified');
          if (
            retainedJob.manifestFiles.some((file) =>
              selectedPayload.some((path) =>
                path.toLowerCase() ===
                  mapped(key, appendRemotePath(retainedJob.savePath, file.path)!).toLowerCase()
              )
            )
          ) throw new Error('A selected payload shares an entry with a retained download');
        });
        if (
          fingerprint !== qbInventory.find((entry) => entry.serviceKey === key)!.fingerprint
        ) throw new Error('Download ownership changed during preview');
      }
    }
  }
  const plan: Omit<OrdinaryDeletionPlan, 'fingerprint'> = {
    policyVersion: 2,
    serverId: input.serverId,
    libraryKey: input.libraryKey,
    selection,
    arrSelected,
    qbSelected,
    connections: connections.filter((entry) =>
      arrSelected || historyRequired || retained.length > 0 || !entry.key.startsWith('arr:')
    ),
    roots: roots.filter((root) =>
      arrSelected || historyRequired || retained.length > 0 || !root.serviceKey.startsWith('arr:')
    ),
    plexFiles: [...uniquePlex.values()].sort((a, b) => a.path.localeCompare(b.path)),
    ...(plexVersionFiles
      ? {
        plexVersionFiles: plexVersionFiles.sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b))
        ),
      }
      : {}),
    arr: arrSelected ? arr : [],
    jobs,
    qbInventory,
    ...(qbSelected && !jobs.length
      ? {
        noJobReason:
          'No matching live qBittorrent job is in the selected current scope. No qBittorrent deletion will be requested.',
      }
      : {}),
  };
  const accepted = { ...plan, fingerprint: ordinaryPlanFingerprint(plan) };
  await assertCurrentOrdinaryProtection(
    accepted,
    input.plex,
    input.arrTargets,
    input.downloadTargets,
    new Set(),
    input.retainedPlexCheck,
  );
  return accepted;
}
