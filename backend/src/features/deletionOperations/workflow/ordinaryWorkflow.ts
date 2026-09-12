import { withTransaction } from '../../../db/index.ts';
import {
  configuredStoragePath,
  type ServiceDeletionResponse,
  storageContains,
  storagePath,
} from '../../../../../shared/serviceStorage.ts';
import {
  assertArrDeleteIsUnambiguous,
  findAmbiguousExternalIds,
  getArrDeleteTargets,
} from '../../arr/delete.ts';
import { getDownloadClientTargets } from '../../mediaDeletion/targets.ts';
import { buildOrdinaryDeletionPlan } from '../../mediaDeletion/ordinaryPlanning.ts';
import {
  evidenceFingerprint,
  loadServiceRoots,
  serviceEndpoints,
} from '../../mediaDeletion/serviceStorage.ts';
import {
  downloadJobManifestFingerprint,
  downloadJobSummaryFingerprint,
} from '../../mediaDeletion/downloadClient.ts';
import { activeWholeItemRatingKeys } from '../../mediaDeletion/activePlayback.ts';
import { advancePhase } from '../core/deletionState.ts';
import { type DurableTargetSnapshot, validateDeletionTarget } from '../core/validation.ts';
import type { DeletionWorkTarget } from '../core/types.ts';
import { finalizeTarget } from './plexReconciliation.ts';
import { refreshDeletionOperation } from '../core/state.ts';
import { assertCurrentOrdinaryProtection } from '../../mediaDeletion/ordinaryProtection.ts';
import { appendRemotePath } from '../../mediaDeletion/ownership.ts';
import { retainedPlexBatchCheck } from '../../mediaDeletion/ordinaryScope.ts';

/** Service-owned branch of the existing durable worker. Every request has durable intent
 * and its actual response. A lost response is held; neither absence nor retry implies success. */
export async function ensureOrdinaryDeletion(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
): Promise<void> {
  const plan = snapshot.ordinaryPlan!;
  if (
    plan.policyVersion !== 2 || plan.serverId !== target.serverId ||
    plan.libraryKey !== snapshot.libraryKey || plan.selection.ratingKey !== snapshot.ratingKey
  ) throw new Error('Invalid accepted service scope');
  const attempts = snapshot.ordinaryAttempts ?? {};
  const reconciliations = snapshot.ordinaryReconciliations ?? {};
  const plexKey = `plex:${snapshot.ratingKey}`;
  let phase = 'downloads';
  const retainedCheck = retainedPlexBatchCheck(() => phase);
  if (
    !Object.keys(attempts).length && (target.plexAttemptCount > 0 || target.phase !== 'validating')
  ) {
    throw new Error(
      'An earlier service attempt lacks current response evidence; automatic replay is held',
    );
  }
  const plexNotFound = () => attempts[plexKey]?.failure?.httpStatus === 404;
  if (
    Object.entries(attempts).some(([key, attempt]) =>
      !attempt.response && !(key === plexKey && plexNotFound())
    )
  ) {
    throw new Error(
      'A service request has an uncertain or failed outcome. Automatic replay is disabled; retain this operation for recovery.',
    );
  }
  const validation = await validateDeletionTarget(target.serverId, target);
  const plex = validation.client;
  const [arrTargets, downloadTargets] = await Promise.all([
    getArrDeleteTargets(target.serverId, snapshot.libraryKey),
    getDownloadClientTargets(target.serverId),
  ]);
  async function guard() {
    const [roots, connections] = await Promise.all([
      loadServiceRoots(target.serverId),
      serviceEndpoints(target.serverId),
    ]);
    const keys = new Set(plan.connections.map((entry) => entry.key));
    const requiresArr = plan.connections.some((entry) => entry.key.startsWith('arr:'));
    if (
      connections.some((entry) =>
        !keys.has(entry.key) &&
        (entry.key.startsWith('qb:') ||
          requiresArr && entry.key.startsWith('arr:') &&
            entry.libraryKeys.includes(plan.libraryKey))
      )
    ) throw new Error('The applicable service destinations changed after confirmation');
    const current = connections.filter((entry) => keys.has(entry.key)).map((entry) => ({
      ...entry,
      roots: [],
      discoveryError: undefined,
    })).sort((a, b) => a.key.localeCompare(b.key));
    if (
      evidenceFingerprint(current) !== evidenceFingerprint(plan.connections) ||
      evidenceFingerprint(
          roots.filter((root) => keys.has(root.serviceKey)).sort((a, b) => a.id - b.id),
        ) !== evidenceFingerprint(plan.roots)
    ) throw new Error('Accepted service configuration or storage relationships changed');
    await assertCurrentOrdinaryProtection(
      plan,
      plex,
      arrTargets,
      downloadTargets,
      new Set([
        ...Object.keys(attempts).filter((key) => attempts[key].response),
        ...Object.keys(reconciliations),
      ]),
      phase === 'monitoring' ? async () => {} : retainedCheck,
    );
    await checkCurrentPlexScope();
    // Inspections can stream a large library. Playback evidence must be newer than
    // those reads, immediately before the caller checkpoints and sends its request.
    if (
      activeWholeItemRatingKeys(
        new Set([snapshot.ratingKey, snapshot.showRatingKey ?? snapshot.ratingKey]),
        await plex.activeSessions(),
      ).size
    ) throw new Error('The selected media is playing');
    return { roots, connections };
  }
  const config = await guard();
  if (!Object.keys(attempts).length) {
    if (!validation.live) {
      throw new Error('The selected Plex item disappeared before any service request');
    }
    const current = await buildOrdinaryDeletionPlan({
      serverId: target.serverId,
      libraryKey: plan.libraryKey,
      selection: plan.selection,
      arrSelected: plan.arrSelected,
      qbSelected: plan.qbSelected,
      plex,
      arrTargets,
      downloadTargets,
      ...config,
      retainedPlexCheck: retainedCheck,
    });
    if (current.fingerprint !== plan.fingerprint) {
      throw new Error('Current service scope differs from the confirmed preview');
    }
  }
  function save() {
    snapshot.ordinaryAttempts = attempts;
    snapshot.ordinaryReconciliations = reconciliations;
    const next = JSON.stringify(snapshot);
    const changed = withTransaction((client) =>
      client.prepare(
        "UPDATE deletion_targets SET snapshot = ?, updated_at = ? WHERE id = ? AND status = 'running' AND snapshot = ?",
      ).run(next, Math.floor(Date.now() / 1000), target.id, target.snapshot)
    );
    if (changed !== 1) throw new Error('Could not checkpoint service request evidence');
    target.snapshot = next;
  }
  async function request(
    key: string,
    service: string,
    action: string,
    mutate: (record: (response: ServiceDeletionResponse) => void) => Promise<void>,
  ) {
    if (attempts[key]?.response) return;
    if (plexNotFound()) {
      throw new Error(
        'A rejected Plex deletion can only be rechecked; further service requests are held',
      );
    }
    await guard();
    attempts[key] = { service, action, startedAt: Date.now() };
    save();
    try {
      await mutate((response) => {
        attempts[key].response = response;
        save();
      });
      if (!attempts[key].response) {
        throw new Error('Service did not provide a recognized success response');
      }
    } catch (error) {
      // Do not serialize service URLs or raw bodies into public errors.
      if (!attempts[key].response) {
        const status = (error as { status?: unknown })?.status;
        const rejected = typeof status === 'number' && status >= 400 && status <= 599 ||
          (error as { deletionRejected?: unknown })?.deletionRejected === true;
        if (rejected) {
          attempts[key].failure = { httpStatus: typeof status === 'number' ? status : undefined };
        }
        attempts[key].error = rejected
          ? 'The service rejected the deletion request'
          : 'The service response was lost or ambiguous';
        save();
      }
      throw error;
    }
  }
  for (const selected of plan.jobs) {
    const key = `qb:${selected.instanceKey}:${selected.job.id}`;
    if (attempts[key]?.response) continue;
    const destination = downloadTargets.find((entry) => entry.instanceKey === selected.instanceKey);
    if (!destination) throw new Error('The accepted qBittorrent destination changed');
    const current = await destination.client.findJob(selected.job.id);
    if (
      !current || await downloadJobSummaryFingerprint(current) !== selected.summaryFingerprint ||
      await downloadJobManifestFingerprint(current) !== selected.manifestFingerprint
    ) throw new Error('The accepted download manifest or location changed');
    await request(
      key,
      destination.instanceName,
      'Delete torrent and data',
      (record) =>
        destination.client.deleteJob(selected.job.id, { deleteData: true, onResponse: record }),
    );
  }
  for (const selected of plan.arr) {
    const destination = arrTargets.find((entry) => entry.instanceId === selected.instanceId);
    if (!destination || destination.mappingIdentity !== selected.mappingIdentity) {
      throw new Error('The accepted Arr destination changed');
    }
    const key = `arr:${selected.instanceId}:${selected.recordId}`;
    phase = `arr:${selected.instanceId}`;
    if (selected.directory) {
      if (attempts[key]?.response) continue;
      assertArrDeleteIsUnambiguous(
        plan.selection,
        withTransaction((client) =>
          findAmbiguousExternalIds(
            client,
            target.serverId,
            plan.selection.type === 'movie' ? 'movie' : 'show',
            [plan.selection.type === 'movie' ? plan.selection.tmdbId! : plan.selection.tvdbId!],
          )
        ),
      );
      const current = await destination.client.lookup(
        plan.selection.type === 'movie' ? plan.selection.tmdbId! : plan.selection.tvdbId!,
      );
      if (
        !current || current.id !== selected.recordId || !current.path ||
        storagePath(current.path) !== storagePath(selected.path)
      ) {
        throw new Error('The managed title identity or folder changed');
      }
      for (const other of await destination.client.managedScopes()) {
        if (
          other.id !== selected.recordId &&
          (storageContains(selected.path, other.path, false) ||
            storageContains(other.path, selected.path, false))
        ) throw new Error('A retained title shares the selected managed folder');
      }
      await request(
        key,
        destination.instanceName,
        'Delete managed title and files',
        (record) =>
          destination.client.deleteMedia(selected.recordId, destination.addImportExclusion, record),
      );
    } else {
      phase = 'monitoring';
      for (const episode of selected.episodes) {
        const monitorKey = `arr-monitor:${selected.instanceId}:${episode.id}`;
        if (attempts[monitorKey]?.response || !episode.monitored) continue;
        await request(
          monitorKey,
          destination.instanceName,
          'Unmonitor selected episode',
          async (record) => {
            await destination.client.setSonarrEpisodeMonitored({
              seriesId: selected.recordId,
              episodeId: episode.id,
              seasonNumber: episode.seasonNumber,
              episodeNumber: episode.episodeNumber,
            }, false);
            record({ status: 'succeeded', httpStatus: 200 });
          },
        );
      }
      phase = `arr-files:${selected.instanceId}`;
      for (const file of selected.files) {
        const fileKey = `arr-file:${selected.instanceId}:${file.id}`;
        if (attempts[fileKey]?.response || reconciliations[fileKey]) continue;
        const state = await destination.client.sonarrSeriesSnapshot(selected.recordId);
        const current = state.files.find((entry) => entry.id === file.id);
        if (!current) {
          await guard();
          const sourceKeys = responseSourceKeys(file, selected.serviceKey);
          if (!sourceKeys.length) {
            throw new Error(
              'The selected managed file disappeared without a recorded covering service response',
            );
          }
          reconciliations[fileKey] = {
            service: destination.instanceName,
            action: 'Selected file absence reconciled',
            path: file.path,
            size: file.size,
            sourceKeys,
            reconciledAt: Date.now(),
          };
          save();
          continue;
        }
        if (
          !current || storagePath(current.path) !== storagePath(file.path) ||
          current.size !== file.size ||
          evidenceFingerprint(current.episodeIds) !== evidenceFingerprint(file.episodeIds)
        ) throw new Error('The selected managed file identity changed');
        await request(
          fileKey,
          destination.instanceName,
          'Delete selected episode file',
          (record) => destination.client.deleteManagedFile(file.id, record),
        );
      }
    }
  }
  function responseSourceKeys(
    file: { path: string; size: number },
    serviceKey = `plex:${plan.libraryKey}`,
  ): string[] {
    if (!Object.values(attempts).some((attempt) => attempt.response)) return [];
    const map = (key: string, path: string) => configuredStoragePath(plan.roots, key, path);
    const path = map(serviceKey, file.path), sources: string[] = [];
    for (const scope of plan.arr) {
      const key = `arr:${scope.instanceId}:${scope.recordId}`;
      if (
        scope.directory && attempts[key]?.response &&
        storageContains(map(scope.serviceKey, scope.path), path)
      ) sources.push(key);
      for (const managed of scope.files) {
        const fileKey = `arr-file:${scope.instanceId}:${managed.id}`;
        if (
          attempts[fileKey]?.response && map(scope.serviceKey, managed.path) === path &&
          managed.size === file.size
        ) sources.push(fileKey);
      }
    }
    for (const selected of plan.jobs) {
      const key = `qb:${selected.instanceKey}:${selected.job.id}`;
      if (
        attempts[key]?.response &&
        selected.job.manifestFiles.some((part) =>
          map(selected.serviceKey, appendRemotePath(selected.job.savePath, part.path)!) === path &&
          part.size === file.size
        )
      ) sources.push(key);
    }
    return sources;
  }
  async function checkCurrentPlexScope(): Promise<boolean> {
    if (attempts[plexKey]?.response) return false;
    const live = await validateDeletionTarget(target.serverId, target);
    if (!live.live) {
      if (!plan.plexFiles.every((file) => responseSourceKeys(file).length > 0)) {
        throw new Error(
          'Plex disappeared without a recorded service response covering the accepted files',
        );
      }
      return false;
    }
    const paths = plan.selection.type === 'season'
      ? (await plex.seasonDeletionEpisodes(snapshot.ratingKey)).flatMap((episode) =>
        episode.media.flatMap((media) =>
          media.paths.map((part) => ({
            ratingKey: episode.ratingKey,
            mediaId: media.mediaId,
            path: storagePath(part.path),
            size: part.byteSize,
          }))
        )
      )
      : await plex.mediaPathPreview(
        snapshot.ratingKey,
        plan.selection.type,
        undefined,
        undefined,
        true,
        true,
      ).then((result) => {
        if (result.truncated) throw new Error('Plex file scope is incomplete');
        if (plan.plexVersionFiles) {
          if (!result.versionFiles) throw new Error('Plex version scope is incomplete');
          return result.versionFiles.map((file) => ({ ...file, path: storagePath(file.path) }));
        }
        return result.paths.map((path) => ({
          path: storagePath(path),
          size: result.fileSizes?.[path] ?? 0,
        }));
      });
    if (
      plan.plexVersionFiles &&
      paths.some((file) =>
        !plan.plexVersionFiles!.some((accepted) =>
          'mediaId' in file && 'ratingKey' in file && accepted.mediaId === file.mediaId &&
          accepted.ratingKey === file.ratingKey && accepted.path === file.path &&
          accepted.size === file.size
        )
      )
    ) throw new Error('New or changed Plex versions are outside the accepted scope');
    if (
      paths.some((file) =>
        !plan.plexFiles.some((accepted) =>
          accepted.path === file.path && accepted.size === file.size
        )
      )
    ) throw new Error('New or changed Plex files are outside the accepted scope');
    if (
      plan.plexFiles.some((file) =>
        !paths.some((current) => current.path === file.path && current.size === file.size) &&
        responseSourceKeys(file).length === 0
      )
    ) throw new Error('A Plex entry disappeared outside the recorded successful service scope');
    return true;
  }
  phase = 'plex';
  let plexPresent = await checkCurrentPlexScope();
  if (plexPresent) {
    if (plexNotFound()) {
      throw new Error(
        'Plex still exists after a rejected deletion request; automatic replay is held',
      );
    }
    try {
      await request(
        plexKey,
        'Plex',
        'Delete selected media',
        (record) => plex.deleteItem(snapshot.ratingKey, record),
      );
    } catch (error) {
      if (!plexNotFound()) throw error;
      // Arr may remove the item while Plex's request is in flight. Preserve the
      // actual 404 and reconcile only fresh absence with covering service evidence.
      await guard();
      plexPresent = await checkCurrentPlexScope();
      if (plexPresent) throw error;
    }
  }
  if (!plexPresent && !attempts[plexKey]?.response && !reconciliations[plexKey]) {
    // checkCurrentPlexScope required covering durable responses for every accepted file.
    reconciliations[plexKey] = {
      service: 'Plex',
      action: 'Selected Plex absence reconciled',
      size: plan.plexFiles.reduce((sum, file) => sum + file.size, 0),
      sourceKeys: [...new Set(plan.plexFiles.flatMap((file) => responseSourceKeys(file)))],
      reconciledAt: Date.now(),
    };
    save();
  }
  advancePhase(target, 'plex_reconciliation');
  withTransaction((client) => {
    client.prepare(
      "UPDATE deletion_targets SET storage_outcome = 'unknown', unknown_file_count = ?, storage_outcome_reasons = ? WHERE id = ?",
    ).run(
      plan.plexFiles.length,
      JSON.stringify(['Service-reported deletion; physical disk reclamation is not measured']),
      target.id,
    );
    finalizeTarget(client, target, snapshot, true);
    refreshDeletionOperation(client, target.operationId);
  });
}
