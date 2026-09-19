import type { ServiceDeletionResponse } from '../../../../../shared/serviceStorage.ts';
import { withTransaction } from '../../../db/index.ts';
import { getArrDeleteTargets } from '../../arr/delete.ts';
import { getDownloadClientTargets } from '../../mediaDeletion/targets.ts';
import { serviceEndpoints } from '../../mediaDeletion/serviceStorage.ts';
import { relatedServiceOwnedPlexItems } from '../../mediaDeletion/serviceOwnedPlexScope.ts';
import { activeWholeItemRatingKeys } from '../../mediaDeletion/activePlayback.ts';
import {
  buildServiceOwnedPlan,
  serviceOwnedActionEvidence,
  serviceOwnedFingerprint,
  type ServiceOwnedPlan,
  type ServiceOwnedPlannedAction,
} from '../../mediaDeletion/serviceOwnedPlanning.ts';
import { type DurableTargetSnapshot, validateDeletionTarget } from '../core/validation.ts';
import type { DeletionWorkTarget } from '../core/types.ts';
import { ServiceOwnedVerificationPending } from '../core/types.ts';
import { isRetryableDeletionFailure } from '../core/policy.ts';

import { advancePhase } from '../core/deletionState.ts';
import {
  assertRetainedVersionPostcondition,
  finalizeRetainedPlexTarget,
  finalizeTarget,
  markHeldServiceTarget,
} from './plexReconciliation.ts';
import { refreshDeletionOperation } from '../core/state.ts';
import type {
  ServiceOwnedAction,
  ServiceOwnedRetentionPlan,
} from '../../mediaDeletion/serviceOwnedRetention.ts';

/** Wrap only reads: request failures must retain their uncertain-outcome hold. */
async function verificationRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const status = (error as { status?: number })?.status ?? null;
    if (
      isRetryableDeletionFailure(
        status,
        error instanceof Error ? error.message : '',
        error instanceof TypeError,
      ) ||
      error instanceof Error &&
        error.message === 'Sonarr episode snapshot references a missing EpisodeFile'
    ) {
      throw new ServiceOwnedVerificationPending('Waiting for service inventory verification');
    }
    throw error;
  }
}

export interface ServiceOwnedAttempt {
  startedAt: number;
  response?: ServiceDeletionResponse;
  error?: string;
  failure?: { httpStatus?: number };
  monitoring?: Record<string, {
    startedAt: number;
    response?: ServiceDeletionResponse;
    noRequest?: true;
    observedAt?: number;
  }>;
  /** Service record absence is not evidence of physical disk reclamation. */
  outcome?: { status: 'target_absent'; observedAt: number };
  /** No request was sent; exact prior service effects plus fresh catalog absence. */
  reconciliation?: { sourceActionIds: string[] };
  recordCleanup?: { startedAt: number; response?: ServiceDeletionResponse; observedAt?: number };
}

type MonitoredEpisode = NonNullable<ServiceOwnedPlannedAction['episodes']>[number];

/** File completion does not authorize dropping management of newly imported files. */
export async function assertServiceOwnedCatalogEmpty(
  read: () => Promise<{
    files: readonly unknown[];
    episodes: readonly { episodeFileId: number }[];
  }>,
): Promise<void> {
  const current = await read();
  if (current.files.length || current.episodes.some((episode) => episode.episodeFileId !== 0)) {
    throw new Error('Managed files appeared before catalog cleanup');
  }
}

/** Unmonitor only a successfully deleted file's accepted episodes, with separate durable evidence. */
export async function ensureServiceOwnedEpisodeMonitoring(
  action: ServiceOwnedPlannedAction,
  attempt: ServiceOwnedAttempt,
  runtime: {
    save(): void;
    revalidate(): Promise<void>;
    monitored(episode: MonitoredEpisode): Promise<boolean>;
    unmonitor(
      episode: MonitoredEpisode,
      record: (response: ServiceDeletionResponse) => void,
    ): Promise<boolean>;
  },
): Promise<void> {
  if (action.service !== 'sonarr' || action.catalogOnly || action.recordCleanup) return;
  if ((!attempt.response && !attempt.reconciliation?.sourceActionIds.length) || !attempt.outcome) {
    throw new Error('File deletion is not confirmed; monitoring is held');
  }
  const monitoring = attempt.monitoring ??= {};
  for (const episode of action.episodes ?? []) {
    const key = String(episode.id);
    const previous = monitoring[key];
    if (previous && !previous.response && !previous.noRequest) {
      throw new Error('Episode monitoring response is uncertain; replay is held');
    }
    const monitored = await verificationRead(() => runtime.monitored(episode));
    if (previous) {
      if (monitored) {
        if (previous.observedAt) throw new Error('Episode monitoring changed after verification');
        throw new ServiceOwnedVerificationPending('Waiting for episode monitoring verification');
      }
      previous.observedAt = Date.now();
      runtime.save();
      continue;
    }
    if (!episode.monitored && monitored) throw new Error('Originally unmonitored episode changed');
    if (!monitored) {
      monitoring[key] = { startedAt: Date.now(), noRequest: true, observedAt: Date.now() };
      runtime.save();
      continue;
    }
    await runtime.revalidate();
    monitoring[key] = { startedAt: Date.now() };
    runtime.save();
    let requested: boolean;
    try {
      requested = await runtime.unmonitor(episode, (response) => {
        monitoring[key].response = response;
        runtime.save();
      });
    } catch (error) {
      // The client may fail its read-back after recording an accepted update.
      // Resume by reading monitoring state, never by sending the update again.
      if (monitoring[key].response) {
        throw new ServiceOwnedVerificationPending('Waiting for episode monitoring verification');
      }
      throw error;
    }
    if (!requested) monitoring[key].noRequest = true;
    runtime.save();
    if (!monitoring[key].response && !monitoring[key].noRequest) {
      throw new Error('Episode monitoring response was not recorded; replay is held');
    }
    if (await verificationRead(() => runtime.monitored(episode))) {
      throw new ServiceOwnedVerificationPending('Waiting for episode monitoring verification');
    }
    monitoring[key].observedAt = Date.now();
    runtime.save();
  }
}

export interface ServiceOwnedExecutionRuntime {
  /** Must persist synchronously before returning, including before every request. */
  save(): void;
  /** Rebuild ownership/configuration/scope and playback protection before mutation. */
  revalidate(completed: ReadonlySet<string>, pending?: ServiceOwnedAction): Promise<void>;
  /** Errors must propagate; only an error-free service read can report absence. */
  present(action: ServiceOwnedAction): Promise<boolean>;
  mutate(
    action: ServiceOwnedAction,
    record: (response: ServiceDeletionResponse) => void,
  ): Promise<void>;
  afterObserved?(action: ServiceOwnedAction, completed: ReadonlySet<string>): Promise<void>;
  reconcileAbsent?(
    action: ServiceOwnedAction,
    completed: ReadonlySet<string>,
  ): Promise<string[] | undefined>;
}

/** Exact accepted file effects can explain another service's fresh catalog absence.
 * Differently named hardlinks, unknown sizes and catalog-only actions cannot.
 */
export function serviceOwnedAbsenceSources(
  action: ServiceOwnedPlannedAction,
  actions: readonly ServiceOwnedPlannedAction[],
  attempts: Readonly<Record<string, ServiceOwnedAttempt>>,
  completed: ReadonlySet<string>,
): string[] | undefined {
  if (action.catalogOnly || action.service === 'qb' || !action.files.length) return;
  const sources = new Set<string>();
  for (const file of action.files) {
    if (file.size === null) return;
    const covering = actions.filter((source) =>
      source.id !== action.id && !source.catalogOnly && completed.has(source.id) &&
      attempts[source.id]?.response && attempts[source.id]?.outcome &&
      source.files.some((entry) => entry.path === file.path && entry.size === file.size)
    );
    if (!covering.length) return;
    for (const source of covering) sources.add(source.id);
  }
  return [...sources].sort();
}

/** The service-owned branch's durable action loop. It never interprets retention as deletion. */
export async function executeServiceOwnedActions(
  plan: { actions: readonly ServiceOwnedAction[]; retention: ServiceOwnedRetentionPlan },
  attempts: Record<string, ServiceOwnedAttempt>,
  runtime: ServiceOwnedExecutionRuntime,
): Promise<void> {
  const rank = { qb: 0, sonarr: 1, radarr: 1, plex: 2 };
  const candidates = plan.retention.decisions.filter((d) => d.state === 'delete_candidate')
    .sort((a, b) => rank[a.service] - rank[b.service] || a.actionId.localeCompare(b.actionId));
  const ids = new Set(candidates.map((d) => d.actionId));
  if (
    Object.keys(attempts).some((id) =>
      !ids.has(id) ||
      !attempts[id].response && (!attempts[id].reconciliation?.sourceActionIds.length ||
          attempts[id].reconciliation!.sourceActionIds.some((source) =>
            !attempts[source]?.response || !attempts[source]?.outcome
          ))
    )
  ) {
    throw new Error('A service request has an uncertain outcome; destructive replay is held');
  }
  const completed = new Set<string>();
  async function observe(action: ServiceOwnedAction) {
    if (await verificationRead(() => runtime.present(action))) {
      if (attempts[action.id].outcome) throw new Error('A completed service target reappeared');
      throw new ServiceOwnedVerificationPending(
        'Service accepted deletion; waiting for inventory verification',
      );
    }
    attempts[action.id].outcome = { status: 'target_absent', observedAt: Date.now() };
    runtime.save();
    completed.add(action.id);
  }
  // Re-observe persisted accepted actions on every resumed run. Never trust a stale
  // postcondition to authorize further mutation or synthesize a missing response.
  for (const decision of candidates) {
    const action = plan.actions.find((entry) => entry.id === decision.actionId);
    if (!action) throw new Error('Missing accepted service action');
    if (attempts[action.id]?.response || attempts[action.id]?.reconciliation) await observe(action);
  }
  async function reconcileCoveredAbsences() {
    const observed: ServiceOwnedAction[] = [];
    if (!runtime.reconcileAbsent) return observed;
    for (const decision of candidates) {
      if (attempts[decision.actionId]) continue;
      const action = plan.actions.find((a) => a.id === decision.actionId)!;
      const sourceActionIds = await runtime.reconcileAbsent(action, completed);
      if (!sourceActionIds?.length) continue;
      if (sourceActionIds.some((id) => !completed.has(id) || !attempts[id]?.response)) {
        throw new Error('Absence reconciliation lacks confirmed service effects');
      }
      attempts[action.id] = { startedAt: Date.now(), reconciliation: { sourceActionIds } };
      runtime.save();
      await observe(action);
      observed.push(action);
    }
    return observed;
  }
  await reconcileCoveredAbsences();
  for (const action of plan.actions) {
    if (completed.has(action.id)) await runtime.afterObserved?.(action, completed);
  }
  await runtime.revalidate(completed);
  for (const decision of candidates) {
    const action = plan.actions.find((a) => a.id === decision.actionId);
    if (!action || action.targetId !== decision.targetId || action.service !== decision.service) {
      throw new Error('Accepted action identity is inconsistent');
    }
    if (completed.has(action.id)) continue;
    await runtime.revalidate(completed, action);
    if (!await runtime.present(action)) {
      throw new Error('Service target disappeared without its own recorded deletion response');
    }
    attempts[action.id] = { startedAt: Date.now() };
    runtime.save();
    try {
      await runtime.mutate(action, (response) => {
        attempts[action.id].response = response;
        runtime.save();
      });
      if (!attempts[action.id].response) throw new Error('Service response was not recorded');
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      if (typeof status === 'number' && status >= 400 && status <= 599) {
        attempts[action.id].failure = { httpStatus: status };
      }
      attempts[action.id].error = attempts[action.id].failure
        ? 'The service rejected the deletion request'
        : 'The service request failed or its response was lost';
      runtime.save();
      throw new Error('Service deletion outcome is uncertain; destructive replay is held');
    }
    await observe(action);
    const reconciled = await reconcileCoveredAbsences();
    await runtime.afterObserved?.(action, completed);
    for (const other of reconciled) await runtime.afterObserved?.(other, completed);
  }
}

/** Adapter into the existing durable worker; all deletion calls carry service-local IDs. */
export async function ensureServiceOwnedDeletion(
  target: DeletionWorkTarget,
  snapshot: DurableTargetSnapshot,
): Promise<void> {
  const plan = snapshot.serviceOwnedPlan!;
  if (
    !plan || plan.policyVersion !== 4 || plan.confidencePolicy !== 'service-owned-reasonable-v1' ||
    plan.serverId !== target.serverId ||
    plan.libraryKey !== snapshot.libraryKey || plan.selection.ratingKey !== snapshot.ratingKey
  ) {
    throw new Error('Invalid accepted service-owned scope');
  }
  const { fingerprint, ...evidence } = plan;
  if (
    fingerprint !==
      await serviceOwnedFingerprint({
        ...evidence,
        actions: plan.actions.map(serviceOwnedActionEvidence),
      })
  ) {
    throw new Error('Accepted service-owned evidence is corrupt');
  }
  const attempts = snapshot.serviceOwnedAttempts ?? {};
  if (
    !Object.keys(attempts).length && (target.plexAttemptCount > 0 || target.phase !== 'validating')
  ) {
    throw new Error('Earlier work lacks service-owned request evidence; automatic replay is held');
  }
  const { client: plex } = await verificationRead(() =>
    validateDeletionTarget(target.serverId, target)
  );
  let [arrTargets, downloadTargets] = await Promise.all([
    getArrDeleteTargets(target.serverId, plan.libraryKey),
    getDownloadClientTargets(target.serverId),
  ]);
  const actionFor = (action: ServiceOwnedAction) => {
    const found = plan.actions.find((entry) => entry.id === action.id);
    if (!found) throw new Error('Unaccepted service action');
    return found;
  };
  const arrFor = (action: ServiceOwnedPlannedAction) => {
    const found = arrTargets.find((entry) => entry.instanceId === action.instanceId);
    if (!found) throw new Error('Accepted Arr destination is unavailable');
    return found.client;
  };
  function save() {
    snapshot.serviceOwnedAttempts = attempts;
    const next = JSON.stringify(snapshot);
    const changed = withTransaction((client) =>
      client.prepare(
        "UPDATE deletion_targets SET snapshot = ?, updated_at = ? WHERE id = ? AND status = 'running' AND snapshot = ?",
      ).run(next, Math.floor(Date.now() / 1000), target.id, target.snapshot)
    );
    if (changed !== 1) throw new Error('Could not checkpoint service-owned action');
    target.snapshot = next;
  }
  async function present(base: ServiceOwnedAction) {
    const action = actionFor(base);
    if (action.service === 'qb') {
      const destination = downloadTargets.find((entry) => entry.instanceKey === action.instanceKey);
      if (!destination || !action.hash) throw new Error('Accepted QB destination is unavailable');
      return await destination.client.findJob(action.hash) !== null;
    }
    if (action.service === 'plex') {
      const live = await plex.metadataIdentity(action.ratingKey!);
      return live !== null &&
        (action.mediaId === undefined || live.media.some((m) => m.mediaId === action.mediaId));
    }
    const client = arrFor(action);
    if (action.catalogOnly) {
      const record = await client.lookup(
        action.service === 'radarr' ? plan.selection.tmdbId! : plan.selection.tvdbId!,
      );
      if (record && record.id !== action.recordId) {
        throw new Error('Managed catalog identity changed');
      }
      return record !== null;
    }
    if (action.service === 'sonarr') {
      return await client.sonarrEpisodeFile(action.fileId!) !== null;
    }
    const file = await client.radarrManagedFile(action.recordId!);
    if (file && file.id !== action.fileId) throw new Error('Managed file identity changed');
    return file !== null;
  }
  async function revalidate(completed: ReadonlySet<string>, pending?: ServiceOwnedAction) {
    await validateDeletionTarget(target.serverId, target);
    [arrTargets, downloadTargets] = await Promise.all([
      getArrDeleteTargets(target.serverId, plan.libraryKey),
      getDownloadClientTargets(target.serverId),
    ]);
    // A prior version in this operation was part of this target's accepted
    // retained inventory. Keep those exact names in the conservative evidence
    // after their recorded service removal; all other fingerprint checks still apply.
    const completedSiblingRetainedEntries: Array<{ serviceKey: string; path: string }> = [];
    const siblingRows = withTransaction((db) =>
      db.prepare(
        "SELECT snapshot FROM deletion_targets WHERE operation_id=? AND id<>? AND status IN ('completed','completed_with_warning')",
      ).values<[string]>(target.operationId, target.id)
    );
    for (const [raw] of siblingRows) {
      const sibling = JSON.parse(raw) as DurableTargetSnapshot;
      const other = sibling.serviceOwnedPlan;
      if (
        !other || other.serverId !== plan.serverId || other.libraryKey !== plan.libraryKey ||
        other.selection.mediaId === undefined ||
        !(other.selection.ratingKey === plan.selection.ratingKey ||
          other.selection.showRatingKey &&
            other.selection.showRatingKey === plan.selection.showRatingKey)
      ) continue;
      for (const action of other.actions) {
        const attempt = sibling.serviceOwnedAttempts?.[action.id];
        if (
          !['plex', 'sonarr'].includes(action.service) || !attempt?.response || !attempt.outcome ||
          !other.retention.decisions.some((d) =>
            d.actionId === action.id && d.state === 'delete_candidate'
          )
        ) continue;
        if (action.service === 'plex') {
          const siblingLive = await plex.metadataIdentity(action.ratingKey!);
          if (siblingLive?.media.some((media) => media.mediaId === action.mediaId)) {
            throw new Error('Completed sibling Plex target reappeared');
          }
        } else {
          if (action.catalogOnly || !action.fileId) continue;
          const destination = arrTargets.find((entry) => entry.instanceId === action.instanceId);
          if (!destination || await destination.client.sonarrEpisodeFile(action.fileId)) {
            throw new Error('Completed sibling Sonarr target is unavailable or reappeared');
          }
        }
        completedSiblingRetainedEntries.push(
          ...action.files.map((file) => ({ serviceKey: action.serviceKey, path: file.path })),
        );
      }
    }
    const current = await collectStableServiceOwnedScope(async () =>
      buildServiceOwnedPlan({
        // Only a Sonarr file boundary can use focused individual reads. Plex/QB,
        // resume, catalog cleanup and service transitions keep full collection.
        ...(pending?.service === 'sonarr' && !actionFor(pending).catalogOnly
          ? {
            focus: {
              action: actionFor(pending),
              acceptedPlexParts: plan.actions.find((a) => a.service === 'plex')?.plexParts ?? [],
            },
          }
          : {}),
        completedSiblingRetainedEntries,
        relatedPlexItems: () => relatedServiceOwnedPlexItems(target.serverId, plan.selection),
        serverId: target.serverId,
        libraryKey: plan.libraryKey,
        selection: plan.selection,
        arrSelected: plan.arrSelected,
        qbSelected: plan.qbSelected,
        knownJobIds: plan.actions.flatMap((action) => action.hash ? [action.hash] : []),
        plex,
        arrTargets,
        downloadTargets,
        connections: await serviceEndpoints(target.serverId),
      })
    );
    if (
      plan.retention.decisions.every((d) =>
        d.state === 'delete_candidate' && completed.has(d.actionId) || d.state === 'not_applicable'
      )
    ) {
      if (
        await serviceOwnedFingerprint(plan.connections) !==
          await serviceOwnedFingerprint(current.connections)
      ) {
        throw new Error('Service configuration changed after confirmation');
      }
    } else {
      // Partial Plex catalog changes may be explained only by still-absent native
      // targets with recorded responses, never a stale checkpoint alone.
      for (const action of plan.actions) {
        if (
          completed.has(action.id) &&
          (pending?.service === 'sonarr'
            ? current.actions.some((entry) =>
              entry.id === action.id && entry.presence === 'current'
            )
            : await present(action))
        ) {
          throw new Error('A completed service target reappeared');
        }
      }
      await assertServiceOwnedContinuation(plan, current, completed, attempts);
    }
    if (
      activeWholeItemRatingKeys(
        new Set([snapshot.ratingKey, snapshot.showRatingKey ?? snapshot.ratingKey]),
        await plex.activeSessions(),
      ).size
    ) throw new Error('Selected media is playing');
  }
  const cleanedRecords = new Set<string>();
  async function cleanRecord(base: ServiceOwnedAction, completed: ReadonlySet<string>) {
    let action = actionFor(base);
    if (action.catalogOnly || !action.recordCleanup || !completed.has(action.id)) return;
    const recordActions = plan.actions.filter((other) =>
      other.serviceKey === action.serviceKey && other.recordId === action.recordId
    ).sort((a, b) => a.id.localeCompare(b.id));
    action = recordActions[0];
    if (cleanedRecords.has(action.id)) return;
    if (
      recordActions.some((other) => !completed.has(other.id))
    ) return;
    const attempt = attempts[action.id];
    if (attempt.recordCleanup && !attempt.recordCleanup.response) {
      throw new Error('Managed catalog removal has an uncertain response; replay is held');
    }
    const client = arrFor(action);
    const externalId = action.service === 'radarr' ? plan.selection.tmdbId : plan.selection.tvdbId;
    const record = await verificationRead(() => client.lookup(externalId!));
    if (attempt.recordCleanup?.response) {
      if (record) {
        if (record.id !== action.recordId || attempt.recordCleanup.observedAt) {
          throw new Error('Managed catalog identity changed');
        }
        throw new ServiceOwnedVerificationPending(
          'Waiting for managed catalog removal verification',
        );
      }
    } else {
      if (!record || record.id !== action.recordId) {
        throw new Error('Managed catalog identity changed');
      }
      if (await verificationRead(() => present(action))) {
        throw new Error('A managed file reappeared before catalog cleanup');
      }
      await verificationRead(() => revalidate(completed));
      if (action.service === 'sonarr') {
        // The generic collector can lose Arr scope after Plex disappears. Check the
        // entire native record, not only the former leading file ID, before removal.
        await assertServiceOwnedCatalogEmpty(() =>
          verificationRead(() => client.sonarrSeriesSnapshot(action.recordId!))
        );
      }
      attempt.recordCleanup = { startedAt: Date.now() };
      save();
      await client.deleteManagedRecord(
        action.recordId!,
        action.recordCleanup!.addImportExclusion,
        (response) => {
          attempt.recordCleanup!.response = response;
          save();
        },
      );
      if (await verificationRead(() => client.lookup(externalId!))) {
        throw new ServiceOwnedVerificationPending(
          'Waiting for managed catalog removal verification',
        );
      }
    }
    attempt.recordCleanup!.observedAt = Date.now();
    save();
    cleanedRecords.add(action.id);
  }
  await executeServiceOwnedActions(plan, attempts, {
    save,
    present: (action) => verificationRead(() => present(action)),
    revalidate: (completed, pending) => verificationRead(() => revalidate(completed, pending)),
    async reconcileAbsent(base, completed) {
      const action = actionFor(base);
      const sources = serviceOwnedAbsenceSources(action, plan.actions, attempts, completed);
      if (!sources || await verificationRead(() => present(action))) return;
      // A cached completion can only explain fresh absence after its native
      // sources are re-observed. Never synthesize success from stale effects.
      for (const id of sources) {
        if (await verificationRead(() => present(plan.actions.find((a) => a.id === id)!))) {
          throw new Error('A completed service target reappeared');
        }
      }
      return sources;
    },
    async afterObserved(base, completed) {
      const action = actionFor(base);
      await ensureServiceOwnedEpisodeMonitoring(action, attempts[action.id], {
        save,
        revalidate: () => verificationRead(() => revalidate(completed, action)),
        async monitored(episode) {
          return (await arrFor(action).sonarrEpisodeMonitorTarget({
            seriesId: action.recordId!,
            episodeId: episode.id,
            seasonNumber: episode.seasonNumber,
            episodeNumber: episode.episodeNumber,
          }, true)).monitored;
        },
        unmonitor: (episode, record) =>
          arrFor(action).setSonarrEpisodeMonitored(
            {
              seriesId: action.recordId!,
              episodeId: episode.id,
              seasonNumber: episode.seasonNumber,
              episodeNumber: episode.episodeNumber,
            },
            false,
            record,
            true,
          ),
      });
      await cleanRecord(base, completed);
    },
    async mutate(base, record) {
      const action = actionFor(base);
      advancePhase(
        target,
        action.service === 'qb'
          ? 'download_cleanup'
          : action.service === 'plex'
          ? 'plex_reconciliation'
          : 'arr_coordination',
      );
      if (action.service === 'qb') {
        const destination = downloadTargets.find((entry) =>
          entry.instanceKey === action.instanceKey
        )!;
        await destination.client.deleteJob(action.hash!, { deleteData: true, onResponse: record });
      } else if (action.service === 'plex') {
        if (action.mediaId === undefined) await plex.deleteItem(action.ratingKey!, record);
        else await plex.deleteMedia(action.ratingKey!, action.mediaId, record);
      } else if (action.catalogOnly) {
        await arrFor(action).deleteManagedRecord(
          action.recordId!,
          action.recordCleanup!.addImportExclusion,
          record,
        );
      } else await arrFor(action).deleteManagedFile(action.fileId!, record);
    },
  });
  const plexDecision = plan.retention.decisions.find((decision) => decision.service === 'plex');
  if (!plexDecision) {
    throw new Error('No accepted Plex outcome');
  }
  if (plexDecision.state === 'delete_candidate' && target.targetKind !== 'whole_item') {
    const live = await verificationRead(() => plex.metadataIdentity(snapshot.ratingKey));
    if (!live) throw new Error('The retained Plex item disappeared');
    assertRetainedVersionPostcondition(target, snapshot, live);
  }
  if (plexDecision.state === 'delete_candidate') advancePhase(target, 'plex_reconciliation');
  withTransaction((client) => {
    if (plexDecision.state === 'kept') finalizeRetainedPlexTarget(client, target);
    else if (plexDecision.state === 'not_applicable') {
      finalizeRetainedPlexTarget(
        client,
        target,
        'No current Plex target; no Plex removal was recorded',
      );
    } else if (plexDecision.state === 'delete_candidate') {
      client.prepare(
        "UPDATE deletion_targets SET storage_outcome='unknown', storage_outcome_reasons=? WHERE id=?",
      )
        .run(
          JSON.stringify([
            'Service record absence observed; physical disk reclamation is not measured',
          ]),
          target.id,
        );
      finalizeTarget(client, target, snapshot, true);
      if (plan.retention.decisions.some((d) => d.requested && d.state === 'kept')) {
        client.prepare(
          "UPDATE deletion_targets SET status='completed_with_warning', warning='Completed with intentionally retained service targets' WHERE id=?",
        )
          .run(target.id);
      }
    }
    if (plan.retention.decisions.some((d) => d.state === 'held')) {
      markHeldServiceTarget(client, target);
    }
    refreshDeletionOperation(client, target.operationId);
  });
}

/** Briefly retry unavailable read evidence while native service inventories settle. */
export async function collectStableServiceOwnedScope<
  T extends {
    actions: readonly { presence: string }[];
  },
>(
  collect: () => Promise<T>,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  // Native deletions can trigger scans while the collector compares two reads.
  // Retry only unavailable evidence, never accepted mutations or actual scope drift.
  for (let attempt = 0;; attempt++) {
    const current = await collect();
    if (!current.actions.some((action) => action.presence === 'unknown') || attempt === 2) {
      return current;
    }
    await pause(attempt === 0 ? 500 : 1500);
  }
}

/** Prior recorded effects may disappear; every pending action remains exactly accepted. */
export async function assertServiceOwnedContinuation(
  accepted: ServiceOwnedPlan,
  current: ServiceOwnedPlan,
  completed: ReadonlySet<string>,
  attempts: Readonly<Record<string, ServiceOwnedAttempt>> = {},
) {
  if (
    await serviceOwnedFingerprint(accepted.connections) !==
      await serviceOwnedFingerprint(current.connections)
  ) {
    throw new Error('Service configuration changed after confirmation');
  }
  const unavailable = current.actions.find((action) => action.presence === 'unknown');
  if (unavailable) {
    throw new ServiceOwnedVerificationPending(
      `${unavailable.service} inventory could not be verified after confirmation: ${
        unavailable.unavailableReason ?? 'Current service evidence is unavailable'
      }`,
    );
  }
  if (!completed.size && accepted.fingerprint !== current.fingerprint) {
    throw new Error('Accepted service evidence changed before execution');
  }
  for (const action of current.actions) {
    if (
      !accepted.actions.some((entry) => entry.id === action.id) &&
      !((action.presence === 'absent' || action.catalogOnly && action.entries.length === 0) &&
        accepted.actions.some((entry) =>
          entry.serviceKey === action.serviceKey && completed.has(entry.id) &&
          (!action.catalogOnly || entry.recordId === action.recordId && entry.recordCleanup)
        ))
    ) {
      throw new Error('New service scope appeared after confirmation');
    }
  }
  for (const action of accepted.actions) {
    if (completed.has(action.id)) continue;
    const decision = accepted.retention.decisions.find((entry) => entry.actionId === action.id)!;
    const keptDownloadAfterArr = action.service === 'qb' && decision.state === 'kept' &&
      accepted.actions.some((entry) =>
        (entry.service === 'sonarr' || entry.service === 'radarr') && completed.has(entry.id)
      );
    const now = current.actions.find((entry) => entry.id === action.id);
    const comparable = (value: ServiceOwnedPlannedAction) => {
      const evidence = serviceOwnedActionEvidence(value);
      // A season/show can remain in Plex after a scan removes individual files
      // deleted by an earlier native action. Normalize only the accepted side,
      // only for exact recorded effects. New files, renames, sizes and ownership
      // must still match the immutable consent below.
      if (
        value === action && action.service === 'plex' &&
        decision.state === 'delete_candidate' && now?.presence === 'current' &&
        now.effectsComplete
      ) {
        const explained = new Set(
          action.files.filter((file) =>
            !now.files.some((entry) => entry.path === file.path && entry.size === file.size) &&
            serviceOwnedAbsenceSources(
              { ...action, files: [file] },
              accepted.actions,
              attempts,
              completed,
            )
          ).map((file) => file.path),
        );
        evidence.files = evidence.files.filter((file) => !explained.has(file.path));
        evidence.entries = evidence.entries.filter((entry) => !explained.has(entry.path));
        if (evidence.plexParts) {
          evidence.plexParts = evidence.plexParts.filter((part) => !explained.has(part.path));
        }
      }
      if (keptDownloadAfterArr) {
        // Deleting the imported file can remove its current lineage. Keeping this
        // job still binds its exact live manifest, location and service identity.
        delete evidence.provenanceFingerprint;
        delete evidence.selected;
        delete evidence.retainedOwnership;
        delete evidence.unavailableReason;
      }
      return evidence;
    };
    if (
      !now || await serviceOwnedFingerprint(comparable(now)) !==
        await serviceOwnedFingerprint(comparable(action))
    ) throw new Error('Accepted service effects changed');
    const next = current.retention.decisions.find((entry) => entry.actionId === action.id);
    // Empty metadata is still a native Plex target, not a completed deletion.
    // A fresh preview must hold it, but an already accepted season/show can finish
    // its own DELETE once every former file is explained by recorded, re-observed
    // native effects. The exact comparison above still rejects additions/drift.
    const explainedEmptyPlex = action.service === 'plex' &&
      action.mediaId === undefined &&
      (accepted.selection.type === 'season' || accepted.selection.type === 'show') &&
      now.presence === 'current' && now.effectsComplete && !now.files.length &&
      !now.entries.length &&
      next?.state === 'held' && next.reason === 'effects_incomplete' &&
      !!serviceOwnedAbsenceSources(action, accepted.actions, attempts, completed);
    if (
      !next || !explainedEmptyPlex && ((decision.state !== 'held' && next.state === 'held') ||
          decision.state === 'delete_candidate' && next.state !== 'delete_candidate')
    ) {
      throw new Error('Current retained ownership changed the accepted deletion decision');
    }
  }
}
