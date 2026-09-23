import type {
  HistoricalImport,
  HistoricalImportEvidence,
} from '../../integrations/arr/historicalImports.ts';
import type {
  ArrClient,
  RadarrMovieSnapshot,
  SonarrSeriesSnapshot,
} from '../../integrations/arr/client.ts';
import type { ServiceOwnedPlan } from './serviceOwnedPlanning.ts';

/** Absence of a discriminator is legacy Sonarr evidence only. */
export type HistoricalOwner =
  | { service?: 'sonarr'; seriesId: number; movieId?: never }
  | { service: 'radarr'; movieId: number; seriesId?: never };

export const historicalOwnerId = (owner: HistoricalOwner) =>
  owner.service === 'radarr' ? owner.movieId : owner.seriesId;

/** Historical permission follows the requested, eligible native file action. */
export function selectedRadarrHistoricalFiles(
  plans: readonly ServiceOwnedPlan[],
  instanceId: number,
  current: RadarrMovieSnapshot,
) {
  return new Set(
    plans.flatMap((p) =>
      p.actions.filter((a) =>
        p.arrSelected && a.service === 'radarr' && a.instanceId === instanceId &&
        a.recordId === current.movieId && a.presence === 'current' && a.effectsComplete &&
        !a.retainedOwnership && p.retention.decisions.some((d) =>
          d.actionId === a.id && d.requested && d.state === 'delete_candidate'
        ) && current.files.some((f) =>
          f.id === a.fileId &&
          a.files.some((e) =>
            e.path === f.path && e.size === f.size
          )
        )
      ).map((a) => a.fileId!)
    ),
  );
}

export function radarrHistoricalDownloadLineage(
  evidence: HistoricalImportEvidence,
  current: RadarrMovieSnapshot,
  selectedFileIds: ReadonlySet<number>,
) {
  const candidates: HistoricalLineageCandidate[] = [];
  const skipped: Array<{ source: string; reason: string }> = [];
  const groups = new Map<string, HistoricalImport[]>();
  for (const row of evidence.records) {
    const group = groups.get(row.droppedPath) ?? [];
    group.push(row);
    groups.set(row.droppedPath, group);
  }
  for (const [source, imports] of groups) {
    const valid = imports.every((r) => {
      const file = current.files.find((f) => f.id === r.fileId);
      return r.service === 'radarr' && r.movieId === current.movieId &&
        current.movieFileId === r.fileId && file?.movieId === current.movieId &&
        file.path === r.importedPath && source !== file.path && selectedFileIds.has(file.id);
    });
    // A problem with a known, different source cannot invalidate an independent import.
    const conflict = evidence.problems.some((p) => !p.droppedPath || p.droppedPath === source);
    if (!valid || conflict) {
      skipped.push({
        source,
        reason: 'Exact current movie import lineage or selected ownership could not be verified',
      });
    } else {candidates.push({
        source,
        imports,
        owners: [current.movieId],
        fileIds: [current.movieFileId],
      });}
  }
  for (const p of evidence.problems) {
    if (!skipped.some((s) => s.source === p.droppedPath)) {
      skipped.push({ source: p.droppedPath ?? '(exact source unavailable)', reason: p.reason });
    }
  }
  return { candidates, skipped };
}

export interface HistoricalLineageCandidate {
  source: string;
  imports: HistoricalImport[];
  owners: number[];
  fileIds: number[];
}

/** Refresh the exact imported file as well as its complete owners before unlink. */
export async function historicalSelectedFilesUnchanged(
  client: Pick<ArrClient, 'sonarrEpisodeFileOwnerIds' | 'sonarrEpisodeFile'>,
  seriesId: number,
  lineage: HistoricalLineageCandidate,
): Promise<boolean> {
  for (const fileId of lineage.fileIds) {
    const [owners, file] = await Promise.all([
      client.sonarrEpisodeFileOwnerIds(fileId, seriesId),
      client.sonarrEpisodeFile(fileId),
    ]);
    const imports = lineage.imports.filter((r) => r.fileId === fileId);
    const expected = new Set(imports.map((r) => r.episodeId));
    if (
      !file || file.id !== fileId || file.seriesId !== seriesId ||
      imports.some((r) => r.importedPath !== file.path) ||
      owners.length !== expected.size || owners.some((o) => !expected.has(o))
    ) return false;
  }
  return true;
}

/** Operates on one bounded, complete series inventory shared by the whole selection. */
export function historicalDownloadLineage(
  evidence: HistoricalImportEvidence,
  current: SonarrSeriesSnapshot,
  selectedEpisodeIds: ReadonlySet<number>,
) {
  const candidates: HistoricalLineageCandidate[] = [];
  const skipped: Array<{ source: string; reason: string }> = [];
  const groups = new Map<string, HistoricalImport[]>();
  for (const record of evidence.records) {
    if (record.service === 'radarr') continue;
    const group = groups.get(record.droppedPath) ?? [];
    group.push(record);
    groups.set(record.droppedPath, group);
  }
  for (const [source, imports] of groups) {
    if (!imports.some((r) => r.episodeId !== undefined && selectedEpisodeIds.has(r.episodeId))) {
      continue;
    }
    const owners = new Set<number>();
    let reason = '';
    for (const row of imports) {
      const file = current.files.find((f) => f.id === row.fileId);
      const episode = current.episodes.find((e) => e.id === row.episodeId);
      const actualOwners = current.episodes.filter((e) => e.episodeFileId === row.fileId).map((e) =>
        e.id
      );
      actualOwners.forEach((id) => owners.add(id));
      if (
        !file || !episode || episode.seriesId !== row.seriesId ||
        episode.episodeFileId !== row.fileId || file.seriesId !== row.seriesId ||
        file.path !== row.importedPath ||
        !actualOwners.length || actualOwners.length !== new Set(file.episodeIds).size ||
        !actualOwners.every((id) => file.episodeIds.includes(id)) ||
        actualOwners.some((id) =>
          !imports.some((r) => r.episodeId === id && r.fileId === row.fileId)
        )
      ) reason = 'Exact current import lineage or complete ownership could not be verified';
    }
    if ([...owners].some((id) => !selectedEpisodeIds.has(id))) {
      reason = 'A shared episode owner is outside the selected scope';
    }
    if (evidence.problems.some((p) => p.episodeId === null || owners.has(p.episodeId))) {
      reason = 'Import history contains missing or conflicting evidence';
    }
    if (reason) skipped.push({ source, reason });
    else {candidates.push({
        source,
        imports,
        owners: [...owners].sort((a, b) => a - b),
        fileIds: [...new Set(imports.map((r) => r.fileId))],
      });}
  }
  for (const problem of evidence.problems) {
    if (problem.episodeId === null || selectedEpisodeIds.has(problem.episodeId)) {
      skipped.push({
        source: problem.droppedPath ?? '(exact source unavailable)',
        reason: problem.reason,
      });
    }
  }
  const unique = new Map<string, { source: string; reason: string }>();
  for (const entry of skipped) {
    // Unknown sources remain record-level problems; they cannot be file-deduplicated.
    const key = entry.source === '(exact source unavailable)'
      ? `unknown:${unique.size}`
      : entry.source;
    const previous = unique.get(key);
    if (!previous) unique.set(key, { ...entry });
    else if (!previous.reason.includes(entry.reason)) previous.reason += '; ' + entry.reason;
  }
  return { candidates, skipped: [...unique.values()] };
}
