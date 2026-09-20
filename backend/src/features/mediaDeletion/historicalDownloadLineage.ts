import type {
  HistoricalImport,
  HistoricalImportEvidence,
} from '../../integrations/arr/historicalImports.ts';
import type { ArrClient, SonarrSeriesSnapshot } from '../../integrations/arr/client.ts';

export interface HistoricalLineageCandidate {
  source: string;
  imports: HistoricalImport[];
  owners: number[];
  fileIds: number[];
  size: number;
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
      imports.some((r) => r.importedPath !== file.path || r.size !== file.size) ||
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
    const group = groups.get(record.droppedPath) ?? [];
    group.push(record);
    groups.set(record.droppedPath, group);
  }
  for (const [source, imports] of groups) {
    if (!imports.some((r) => selectedEpisodeIds.has(r.episodeId))) continue;
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
        file.path !== row.importedPath || file.size !== row.size || row.size !== imports[0].size ||
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
        size: imports[0].size,
      });}
  }
  for (const problem of evidence.problems) {
    if (problem.episodeId === null || selectedEpisodeIds.has(problem.episodeId)) {
      skipped.push({ source: '(exact source unavailable)', reason: problem.reason });
    }
  }
  return { candidates, skipped };
}
