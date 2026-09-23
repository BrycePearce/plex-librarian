import { posix } from 'node:path';
import type { HistoricalImportEvidence } from '../../integrations/arr/historicalImports.ts';
import type {
  HistoricalAccessStatus,
  HistoricalDownloadPreview,
} from '../../../../shared/historicalDownloads.ts';
import type { ArrDeleteTarget } from '../arr/delete.ts';
import type { DownloadClientTarget, DownloadJob } from './downloadClient.ts';
import type { ServiceOwnedPlan } from './serviceOwnedPlanning.ts';
import {
  type HistoricalQbMapping,
  historicalQbTranslations,
  type HistoricalQbWitnessCache,
} from './historicalQbTranslation.ts';

export function exactHistoricalTranslation(path: string, mappings: readonly HistoricalQbMapping[]) {
  const applicable = mappings.filter((m) => path.startsWith(m.remote + '/'));
  const preferred = applicable.some((m) => m.explicit)
    ? applicable.filter((m) => m.explicit)
    : applicable;
  const paths = new Set(preferred.map((m) => m.local + path.slice(m.remote.length)));
  return paths.size === 1 ? [...paths][0] : undefined;
}

/** Presentation evidence only. Never authorizes an unlink or makes a held job eligible.
 * Historical metadata failures do not erase an independently proven service effect.
 * Compare exact names through verified translations, not hashes, basenames or inodes.
 */
export async function historicalDownloadCoverage(
  history: HistoricalImportEvidence,
  selected: ReadonlySet<number>,
  service: ArrDeleteTarget,
  plans: readonly ServiceOwnedPlan[],
  qb: readonly DownloadClientTarget[],
  access: readonly HistoricalAccessStatus[],
  manifests: Map<string, DownloadJob>,
  witnesses: HistoricalQbWitnessCache = new Map(),
): Promise<NonNullable<HistoricalDownloadPreview['handled']>> {
  const sources = new Set([
    ...history.records.filter((r) => selected.has(r.service === 'radarr' ? r.movieId : r.episodeId))
      .map((r) => r.droppedPath),
    ...history.problems.filter((
      p,
    ) => ((p.movieId ?? p.episodeId) !== null && selected.has((p.movieId ?? p.episodeId)!)))
      .flatMap((p) => p.droppedPath ? [p.droppedPath] : []),
  ]);
  if (!sources.size) return [];
  const roots = access.filter((a) =>
    a.instanceId === service.instanceId &&
    a.configuration.enabled && a.status === 'available'
  );
  const contexts = roots.filter((a) =>
    [...sources].some((s) => s.startsWith(a.configuration.remoteRoot + '/'))
  )
    .map((a) => ({
      accessId: a.id,
      accessRevision: a.revision,
      lineage: {
        imports: history.records.filter((r) =>
          r.droppedPath.startsWith(a.configuration.remoteRoot + '/')
        ),
      },
    }));
  const handled = new Map<string, NonNullable<HistoricalDownloadPreview['handled']>[number]>();
  const eligible = new Map<string, ServiceOwnedPlan['actions'][number]>();
  const blocked = new Set<string>();
  const identity = (a: ServiceOwnedPlan['actions'][number]) =>
    JSON.stringify([
      a.instanceKey,
      a.job?.id,
      a.job?.savePath,
      a.job?.manifestFiles,
      a.files,
    ]);
  for (const plan of plans) {
    const decisions = new Map(plan.retention.decisions.map((d) => [d.actionId, d]));
    for (const action of plan.actions) {
      if (action.service !== 'qb') continue;
      const decision = decisions.get(action.id);
      const previous = eligible.get(action.id);
      if (
        !plan.qbSelected || !decision?.requested || decision.state !== 'delete_candidate' ||
        action.presence !== 'current' || !action.effectsComplete || action.retainedOwnership ||
        !action.job || (previous && identity(previous) !== identity(action))
      ) {
        blocked.add(action.id);
      } else eligible.set(action.id, action);
    }
  }
  let comparisons = 0;
  for (const target of qb) {
    const actions = [...eligible.values()].filter((a) =>
      a.instanceKey === target.instanceKey && !blocked.has(a.id)
    );
    if (!actions.length) continue;
    const jobs = actions.map((a) => a.job!);
    for (const job of jobs) manifests.set(`${target.instanceKey}:${job.id}`, job);
    const mappings = await historicalQbTranslations(
      target,
      [service],
      roots,
      contexts,
      jobs,
      manifests,
      witnesses,
    );
    for (const action of actions) {
      const job = action.job!;
      if (job.filesTruncated || job.fileCount !== job.manifestFiles.length) continue;
      const payload = new Set<string>();
      const plannedFiles = new Set(action.files.map((f) => JSON.stringify([f.path, f.size])));
      for (const file of job.manifestFiles) {
        if (++comparisons > 200_000) {
          throw new Error('Historical coverage exceeds its evidence budget');
        }
        if (
          !file.path || file.path.startsWith('/') || file.path.includes('\\') ||
          file.path.split('/').some((s) => !s || s === '.' || s === '..')
        ) continue;
        const remote = posix.join(job.savePath, file.path);
        // Require the same complete manifest represented in the planned atomic effects.
        if (!plannedFiles.has(JSON.stringify([remote, file.size]))) continue;
        const local = exactHistoricalTranslation(remote, mappings);
        if (local) payload.add(local);
      }
      for (const source of sources) {
        if (++comparisons > 200_000) {
          throw new Error('Historical coverage exceeds its evidence budget');
        }
        const local = exactHistoricalTranslation(
          source,
          roots.map((r) => ({
            remote: r.configuration.remoteRoot,
            local: r.configuration.localRoot,
          })),
        );
        if (!local || !payload.has(local)) continue;
        const row = handled.get(source) ?? { source, service: 'qb' as const, actionIds: [] };
        row.actionIds.push(action.id);
        handled.set(source, row);
      }
    }
  }
  return [...handled.values()];
}
