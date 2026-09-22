import { dirname, posix } from 'node:path';
import { historicalDownloadCoverage } from './historicalDownloadCoverage.ts';
import { type HistoricalQbMapping, historicalQbTranslations } from './historicalQbTranslation.ts';
import { HistoricalIdentityUnavailable } from './historicalNativeStat.ts';
import { withTransaction } from '../../db/index.ts';
import type { HistoricalImportEvidence } from '../../integrations/arr/historicalImports.ts';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import type { DownloadClientTarget, DownloadJob, DownloadJobSummary } from './downloadClient.ts';
import { serviceOwnedFingerprint, type ServiceOwnedPlan } from './serviceOwnedPlanning.ts';
import {
  historicalDownloadLineage,
  type HistoricalLineageCandidate,
} from './historicalDownloadLineage.ts';
import {
  type HistoricalFileSnapshot,
  historicalMountEntry,
  inspectHistoricalFile,
} from './historicalDownloadIdentity.ts';
import {
  historicalAppDataRoot,
  historicalTranslation,
  listHistoricalAccess,
  supplyHistoricalSample,
} from '../arr/historicalDownloadAccess.ts';
import type {
  HistoricalAccessStatus,
  HistoricalDownloadPreview,
} from '../../../../shared/historicalDownloads.ts';

export interface AcceptedHistoricalDownload {
  /** All contributing namespaces authorize one physical unlink. */
  contexts?: HistoricalDownloadOwnerContext[];
  version: 1;
  id: string;
  instanceId: number;
  seriesId: number;
  lineage: HistoricalLineageCandidate;
  filesystem: HistoricalFileSnapshot;
  accessId: string;
  accessRevision: string;
  connectionRevision: string;
  selectedEpisodeIds: number[];
}

export type HistoricalDownloadOwnerContext = Pick<
  AcceptedHistoricalDownload,
  'instanceId' | 'seriesId' | 'lineage' | 'accessId' | 'accessRevision' | 'selectedEpisodeIds'
>;

export function historicalOwnerContexts(
  value: AcceptedHistoricalDownload,
): HistoricalDownloadOwnerContext[] {
  return value.contexts ?? [value];
}

/** Immutable phase provenance; current ownership is never cached here. */
export type HistoricalHistoryCache = Map<string, Promise<HistoricalImportEvidence>>;
export type HistoricalJobClaimCache = Map<string, { remote: Set<string>; entries: Set<string> }>;

export function historicalConnectionRevision(
  arr: readonly ArrDeleteTarget[],
  qb: readonly DownloadClientTarget[],
) {
  return serviceOwnedFingerprint({
    arr: arr.map((a) => [a.instanceId, a.instanceUrl, a.configurationUpdatedAt, a.mappingIdentity]),
    qb: qb.map((q) => [q.instanceKey, q.configurationIdentity, q.pathMappings]),
  });
}

function overlap(left: string, right: string) {
  return left === right || left.startsWith(right + '/') || right.startsWith(left + '/');
}

function localTranslations(path: string, mappings: HistoricalQbMapping[]) {
  const applicable = mappings.filter((m) => path === m.remote || path.startsWith(m.remote + '/'));
  const preferred = applicable.some((m) => m.explicit)
    ? applicable.filter((m) => m.explicit)
    : applicable;
  const paths = new Set(
    preferred.map((m) => m.local + path.slice(m.remote.length)),
  );
  if (paths.size > 1) throw new Error('Conflicting path translations');
  return [...paths];
}

/** A bounded whole-summary read discovers new jobs; manifests are only read for
 * lineage/path/alias candidates. Current jobs always veto, irrespective of hash. */
export async function historicalJobClaims(
  candidates: readonly AcceptedHistoricalDownload[],
  targets: readonly DownloadClientTarget[],
  access: readonly HistoricalAccessStatus[],
  arr: readonly ArrDeleteTarget[],
  inventories = new Map<string, DownloadJobSummary[]>(),
  manifests = new Map<string, DownloadJob>(),
  signal?: AbortSignal,
  aliasCache = new Map<string, Promise<string | null>>(),
  claimCache: HistoricalJobClaimCache = new Map(),
): Promise<Set<string>> {
  const claimed = new Set<string>();
  const existingAlias = (path: string) => {
    let alias = aliasCache.get(path);
    if (!alias) {
      alias = Deno.realPath(path).catch((error) => {
        if (error instanceof Deno.errors.NotFound) return null;
        throw error;
      });
      aliasCache.set(path, alias);
    }
    return alias;
  };
  const mounts = Deno.build.os === 'linux' ? await Deno.readTextFile('/proc/self/mountinfo') : '';
  for (const target of targets) {
    signal?.throwIfAborted();
    const summaries: DownloadJobSummary[] = [];
    const visit = (summary: DownloadJobSummary) => {
      signal?.throwIfAborted();
      if (summaries.length >= 10_000) {
        throw new Error('Download inventory exceeds the optional cleanup budget');
      }
      summaries.push(summary);
      return Promise.resolve();
    };
    if (inventories.has(target.instanceKey)) {
      summaries.push(...inventories.get(target.instanceKey)!);
    } else if (target.client.scanJobSummaries) await target.client.scanJobSummaries(visit);
    else if (target.client.listJobSummaries) {
      for (const s of await target.client.listJobSummaries()) {
        await visit(s);
      }
    } else throw new Error('Configured download client cannot provide a complete inventory');
    inventories.set(target.instanceKey, summaries);
    const mappings = await historicalQbTranslations(
      target,
      arr,
      access,
      candidates,
      summaries,
      manifests,
    );
    for (const mapping of mappings) {
      mapping.local = await existingAlias(mapping.local) ?? mapping.local;
    }
    let manifestFiles = 0;
    for (const summary of summaries) {
      signal?.throwIfAborted();
      // Different container namespaces cannot establish non-overlap. Require an
      // evidenced translation before excluding any current job by its paths;
      // neither a missing history hash nor an unrelated-looking name is absence.
      if (
        candidates.length &&
        !localTranslations(summary.savePath, mappings).length &&
        !localTranslations(summary.contentPath, mappings).length
      ) {
        throw new Error(
          'Optional historical cleanup cannot verify qBittorrent ownership for ' +
            summary.contentPath +
            '. Check matching qBittorrent endpoints in Sonarr and Librarian, remote path mappings in Sonarr, and historical folder access in Librarian’s Media connections. A matching live import or applicable Sonarr path mapping is needed to infer this relationship. Ordinary service deletion is still available.',
        );
      }
      const translatedRoots = [...localTranslations(summary.savePath + '/placeholder', mappings)]
        .map(dirname);
      for (
        const path of [...translatedRoots, ...localTranslations(summary.contentPath, mappings)]
      ) {
        const alias = await existingAlias(path);
        if (alias) translatedRoots.push(alias);
      }
      const relevant = candidates.filter((c) =>
        historicalOwnerContexts(c).some((o) =>
          o.lineage.imports.some((r) => r.downloadId?.toLowerCase() === summary.id.toLowerCase()) ||
          overlap(o.lineage.source, summary.savePath) ||
          overlap(o.lineage.source, summary.contentPath)
        ) ||
        translatedRoots.some((root) =>
          overlap(c.filesystem.entry, historicalMountEntry(root, mounts).entry)
        )
      );
      if (!relevant.length) continue;
      const manifestKey = `${target.instanceKey}:${summary.id}`;
      const job = manifests.get(manifestKey) ?? await target.client.findJob(summary.id);
      if (!job) throw new Error('A relevant download job changed during inventory');
      if (job.filesTruncated || job.manifestFiles.length !== job.fileCount) {
        throw new Error('Relevant download manifest is incomplete');
      }
      manifests.set(manifestKey, job);
      manifestFiles += job.manifestFiles.length;
      if (manifestFiles > 100_000) {
        throw new Error('Relevant download manifests exceed the evidence budget');
      }
      const claimKey = manifestKey + ':' + serviceOwnedFingerprint(mappings);
      let jobClaims = claimCache.get(claimKey);
      if (!jobClaims) {
        jobClaims = { remote: new Set(), entries: new Set() };
        for (const file of job.manifestFiles) {
          signal?.throwIfAborted();
          if (
            !file.path || file.path.startsWith('/') || file.path.includes('\\') ||
            file.path.split('/').some((s) => !s || s === '..' || s === '.')
          ) throw new Error('Unsafe download manifest');
          const remote = posix.join(job.savePath, file.path);
          jobClaims.remote.add(remote);
          const local = localTranslations(remote, mappings);
          if (!local.length) {
            throw new Error('A relevant download manifest path has no qBittorrent translation');
          }
          for (const path of [...local]) {
            const parentAlias = await existingAlias(dirname(path));
            if (parentAlias) {
              local.push(posix.join(parentAlias, posix.basename(path)));
              const fileAlias = await existingAlias(path);
              if (fileAlias) local.push(fileAlias);
            }
          }
          for (const path of local) jobClaims.entries.add(historicalMountEntry(path, mounts).entry);
        }
        claimCache.set(claimKey, jobClaims);
      }
      for (const c of relevant) {
        if (
          historicalOwnerContexts(c).some((o) => jobClaims.remote.has(o.lineage.source)) ||
          jobClaims.entries.has(c.filesystem.entry)
        ) claimed.add(c.id);
      }
    }
  }
  if (!targets.length) {
    for (const c of candidates) {
      if (
        historicalOwnerContexts(c).some((o) =>
          !access.find((a) => a.id === o.accessId && a.revision === o.accessRevision)?.configuration
            .noRemainingClient
        )
      ) {
        claimed.add(c.id);
      }
    }
  }
  return claimed;
}

export async function collectHistoricalDownloads(
  serverId: number,
  plans: readonly ServiceOwnedPlan[],
  arr: readonly ArrDeleteTarget[],
  qb: readonly DownloadClientTarget[],
  inventories = new Map<string, DownloadJobSummary[]>(),
  deferJobClaims = false,
  historyCache: HistoricalHistoryCache = new Map(),
  signal?: AbortSignal,
): Promise<{ preview: HistoricalDownloadPreview; accepted: AcceptedHistoricalDownload[] }> {
  const access = listHistoricalAccess(serverId);
  const accepted: AcceptedHistoricalDownload[] = [];
  const skipped: HistoricalDownloadPreview['skipped'] = [];
  const handled: NonNullable<HistoricalDownloadPreview['handled']> = [];
  const manifests = new Map<string, DownloadJob>();
  const connectionRevision = historicalConnectionRevision(arr, qb);
  const contexts = new Map<
    string,
    {
      target: ArrDeleteTarget;
      seriesId: number;
      actions: ServiceOwnedPlan['actions'];
      plans: ServiceOwnedPlan[];
    }
  >();
  for (const plan of plans) {
    signal?.throwIfAborted();
    for (const action of plan.actions) {
      if (
        action.service !== 'sonarr' || !action.recordId || !action.fileId ||
        action.presence !== 'current'
      ) continue;
      const target = arr.find((a) => a.instanceId === action.instanceId);
      if (!target) continue;
      const key = `${target.instanceId}:${action.recordId}`;
      const context = contexts.get(key) ??
        { target, seriesId: action.recordId, actions: [], plans: [] };
      if (!context.actions.some((a) => a.id === action.id)) context.actions.push(action);
      if (!context.plans.includes(plan)) context.plans.push(plan);
      contexts.set(key, context);
    }
  }
  const blockedEntries = new Set<string>();
  let incompleteContext = false;
  let historyRecordCount = 0;
  const retained = plans.flatMap((p) => p.historicalRetainedEntries ?? []);
  const mappingCache = new Map<string, Array<{ remote: string; local: string }>>();
  const existingClaimAliases = new Map<string, Promise<string | null>>();
  const claimAlias = (path: string) => {
    let pending = existingClaimAliases.get(path);
    if (!pending) {
      pending = Deno.realPath(path).catch((error) => {
        if (error instanceof Deno.errors.NotFound) return null;
        throw error;
      });
      existingClaimAliases.set(path, pending);
    }
    return pending;
  };
  const mappingsFor = (serviceKey: string) => {
    let mappings = mappingCache.get(serviceKey);
    if (mappings) return mappings;
    mappings = arr.filter((a) => serviceKey === `arr:${a.instanceId}`)
      .flatMap((a) => a.pathMappings.map((m) => ({ remote: m.arrPath, local: m.localPath })));
    if (serviceKey.startsWith('plex:')) {
      const saved = withTransaction((db) =>
        db.prepare(
          'SELECT plex_path,local_path FROM plex_path_mappings WHERE server_id=? AND library_key=?',
        ).values<[string, string]>(serverId, serviceKey.slice(5))
      );
      mappings.push(...saved.map(([remote, local]) => ({ remote, local })));
    }
    mappingCache.set(serviceKey, mappings);
    return mappings;
  };
  for (const { target, seriesId, actions, plans: scoped } of contexts.values()) {
    signal?.throwIfAborted();
    try {
      const historyKey = `${target.instanceId}:${seriesId}:${connectionRevision}`;
      if (!historyCache.has(historyKey)) {
        historyCache.set(historyKey, target.client.historicalImports(seriesId));
      }
      const [history, current] = await Promise.all([
        historyCache.get(historyKey)!,
        target.client.sonarrSeriesSnapshot(seriesId),
      ]);
      historyRecordCount += history.records.length + history.problems.length;
      if (historyRecordCount > 50_000) {
        throw new Error(
          'Selected history exceeds the 50,000-record optional evidence budget; review a smaller selection',
        );
      }
      for (const record of history.records) {
        supplyHistoricalSample(
          serverId,
          target.instanceId,
          record.droppedPath,
          target.pathMappings,
        );
      }
      const selected = new Set<number>();
      const currentFiles = new Map(current.files.map((file) => [file.id, file]));
      for (const episode of current.episodes) {
        const file = currentFiles.get(episode.episodeFileId);
        if (!file) continue;
        const matched = scoped.some((p) => {
          const selection = p.selection;
          const inScope = selection.type === 'show' ||
            selection.type === 'season' && selection.seasonIndex === episode.seasonNumber ||
            selection.type === 'episode' && selection.seasonIndex === episode.seasonNumber &&
              selection.episodeIndex === episode.episodeNumber;
          return inScope &&
            p.actions.some((a) =>
              a.service === 'sonarr' && a.instanceId === target.instanceId &&
              a.recordId === seriesId && a.fileId === file.id && a.effectsComplete &&
              !a.retainedOwnership &&
              a.files.some((f) => f.path === file.path && f.size === file.size)
            );
        });
        if (matched) selected.add(episode.id);
      }
      const lineage = historicalDownloadLineage(history, current, selected);
      let covered: typeof handled = [];
      if (!deferJobClaims) {
        try {
          covered = await historicalDownloadCoverage(
            history,
            selected,
            target,
            plans,
            qb,
            access,
            manifests,
          );
          handled.push(...covered);
        } catch { /* Optional display evidence cannot invalidate ordinary deletion or cleanup. */ }
      }
      const coveredSources = new Set(covered.map((c) => c.source));
      skipped.push(...lineage.skipped.filter((s) => !coveredSources.has(s.source)));
      const uncoveredCandidates = lineage.candidates.filter((c) => !coveredSources.has(c.source));
      const verifiedSources = new Set(uncoveredCandidates.map((c) => c.source));
      const unverifiedSources = new Set(
        [
          ...history.records.map((r) => r.droppedPath),
          ...history.problems.flatMap((p) => p.droppedPath ? [p.droppedPath] : []),
        ]
          .filter((p) => !verifiedSources.has(p)),
      );
      const ownerMounts = Deno.build.os === 'linux'
        ? await Deno.readTextFile('/proc/self/mountinfo')
        : '';
      const claimedPaths = new Set<string>();
      const claimedEntries = new Set<string>();
      for (
        const entry of [
          ...retained,
          ...current.files.map((f) => ({
            id: `arr:${target.instanceId}:${f.path}`,
            path: f.path,
          })),
          ...actions.flatMap((a) => a.entries),
        ]
      ) {
        signal?.throwIfAborted();
        claimedPaths.add(entry.path);
        const serviceKey = entry.id.slice(0, -(entry.path.length + 1));
        for (const local of localTranslations(entry.path, mappingsFor(serviceKey))) {
          // Ownership claims protect names even when their files are temporarily absent.
          claimedEntries.add(historicalMountEntry(local, ownerMounts).entry);
          // Existing retained names may traverse a symlink even though cleanup
          // sources cannot. Resolve only these scoped claims, solely as veto
          // evidence; missing library mounts are not required for eligibility.
          const alias = await claimAlias(local);
          if (alias) claimedEntries.add(historicalMountEntry(alias, ownerMounts).entry);
        }
      }
      for (const source of unverifiedSources) {
        for (
          const root of access.filter((a) =>
            a.instanceId === target.instanceId &&
            a.configuration.localRoot && source.startsWith(a.configuration.remoteRoot + '/')
          )
        ) {
          // Disabling cleanup withdraws mutation permission, not the saved
          // translation's evidence that a retained owner claims this same entry.
          const local = historicalTranslation(source, root.configuration);
          blockedEntries.add(historicalMountEntry(local, ownerMounts).entry);
          // An unselected historical owner is a retained claim too. Its saved
          // translation may traverse a symlink even though mutation sources may
          // not. Failed alias reads must hold the context, never erase its veto.
          const alias = await claimAlias(local);
          if (alias) blockedEntries.add(historicalMountEntry(alias, ownerMounts).entry);
        }
      }
      for (const candidate of uncoveredCandidates) {
        signal?.throwIfAborted();
        if (accepted.length >= 10_000) {
          throw new Error(
            'Selected history exceeds the 10,000-file optional cleanup budget; review a smaller selection',
          );
        }
        let candidateEntry: string | undefined;
        try {
          const roots = listHistoricalAccess(serverId).filter((a) =>
            a.instanceId === target.instanceId && a.configuration.enabled &&
            a.configuration.localRoot &&
            candidate.source.startsWith(a.configuration.remoteRoot + '/')
          );
          if (roots.length !== 1) {
            throw new Error(
              'Allow access to completed downloads in Media connections; an unambiguous enabled root is required',
            );
          }
          const root = roots[0];
          const path = historicalTranslation(candidate.source, root.configuration);
          candidateEntry = historicalMountEntry(path, ownerMounts).entry;
          const filesystem = await inspectHistoricalFile(
            path,
            root.configuration.localRoot,
            historicalAppDataRoot(),
          );
          if (claimedPaths.has(candidate.source) || claimedEntries.has(filesystem.entry)) {
            throw new Error('A current or retained service owner claims this source or its alias');
          }
          const value = {
            version: 1 as const,
            instanceId: target.instanceId,
            seriesId,
            lineage: candidate,
            filesystem,
            accessId: root.id,
            accessRevision: root.revision,
            connectionRevision,
            selectedEpisodeIds: [...candidate.owners].sort((a, b) => a - b),
          };
          accepted.push({ ...value, id: serviceOwnedFingerprint(value) });
        } catch (error) {
          if (candidateEntry) blockedEntries.add(candidateEntry);
          skipped.push({
            source: candidate.source,
            reason: error instanceof HistoricalIdentityUnavailable ? error.message : String(error),
            ...(error instanceof HistoricalIdentityUnavailable ? { details: error.details } : {}),
          });
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      incompleteContext = true;
      skipped.push({
        source: `Sonarr series ${seriesId}`,
        reason: `History or ownership unavailable: ${String(error)}`,
      });
      break;
    }
  }
  if (incompleteContext) {
    // An unread context may own any source also supplied by another context.
    // Without its lineage there is no sound way to limit that uncertainty by path.
    skipped.push(...accepted.map((c) => ({
      source: c.lineage.source,
      reason: 'Another selected Sonarr context has unavailable history or ownership',
    })));
    accepted.length = 0;
  }
  if (!deferJobClaims && accepted.length) {
    try {
      const claims = await historicalJobClaims(
        accepted,
        qb,
        access,
        arr,
        inventories,
        new Map(),
        signal,
      );
      for (let i = accepted.length - 1; i >= 0; i--) {
        if (claims.has(accepted[i].id)) {
          blockedEntries.add(accepted[i].filesystem.entry);
          skipped.push({
            source: accepted[i].lineage.source,
            reason: qb.length
              ? 'A current download job owns this entry'
              : 'Declare that no remaining download client manages this root in Media connections',
          });
          accepted.splice(i, 1);
        }
      }
    } catch (error) {
      skipped.push(
        {
          source: 'Optional historical download cleanup',
          reason: `Download ownership unavailable: ${String(error)}`,
        },
      );
      accepted.length = 0;
    }
  }
  signal?.throwIfAborted();
  const unique = mergeHistoricalDownloadOwners(accepted, blockedEntries, skipped);
  const preview = {
    fingerprint: serviceOwnedFingerprint(unique),
    candidates: unique.map((c) => ({
      id: c.id,
      path: c.lineage.source,
      size: c.filesystem.size,
      ownerCount: historicalOwnerContexts(c).reduce((sum, o) => sum + o.lineage.owners.length, 0),
    })),
    skipped,
    handled,
  };
  return { preview, accepted: unique };
}

/** Preserve complete ownership while reserving and unlinking each physical name once. */
export function mergeHistoricalDownloadOwners(
  accepted: AcceptedHistoricalDownload[],
  blockedEntries: ReadonlySet<string>,
  skipped: HistoricalDownloadPreview['skipped'],
): AcceptedHistoricalDownload[] {
  const groups = new Map<string, AcceptedHistoricalDownload[]>();
  for (const candidate of accepted) {
    const group = groups.get(candidate.filesystem.entry) ?? [];
    group.push(candidate);
    groups.set(candidate.filesystem.entry, group);
  }
  const unique: AcceptedHistoricalDownload[] = [];
  for (const [entry, group] of groups) {
    if (blockedEntries.has(entry)) {
      skipped.push({
        source: group[0].lineage.source,
        reason: 'A physical source owner could not be completely selected and verified',
      });
      continue;
    }
    group.sort((a, b) => a.id.localeCompare(b.id));
    if (group.length === 1) {
      unique.push(group[0]);
      continue;
    }
    const first = group[0];
    if (
      group.some((c) =>
        c.filesystem.device !== first.filesystem.device ||
        c.filesystem.inode !== first.filesystem.inode ||
        c.filesystem.size !== first.filesystem.size ||
        c.filesystem.ctime !== first.filesystem.ctime ||
        c.filesystem.mtime !== first.filesystem.mtime
      )
    ) {
      skipped.push({
        source: first.lineage.source,
        reason: 'Shared source changed during inspection',
      });
      continue;
    }
    const contexts = group.flatMap(historicalOwnerContexts);
    const { id: _id, ...value } = first;
    const merged = { ...value, contexts };
    unique.push({ ...merged, id: serviceOwnedFingerprint(merged) });
  }
  return unique;
}
