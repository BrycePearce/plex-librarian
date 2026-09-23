/** Exact import evidence. Invalid import rows are retained as explicit problems,
 * never silently dropped in favour of a convenient conflicting record. */
export type HistoricalImport =
  & {
    historyId: number;
    fileId: number;
    droppedPath: string;
    importedPath: string;
    date: string;
    downloadId: string | null;
  }
  & (
    | { service?: 'sonarr'; seriesId: number; episodeId: number; movieId?: never }
    | { service: 'radarr'; movieId: number; seriesId?: never; episodeId?: never }
  );

export interface HistoricalImportEvidence {
  records: HistoricalImport[];
  problems: Array<{
    episodeId: number | null;
    movieId?: number | null;
    reason: string;
    /** Independently validated provenance, never standalone unlink authority. */
    droppedPath?: string;
    importedPath?: string;
    historyId?: number;
  }>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Malformed import record');
  }
  return value as Record<string, unknown>;
}

function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Missing or invalid import identity');
  }
  return value;
}

function decimal(values: unknown[], label: string): number {
  const present = values.filter((v) => v !== undefined);
  if (!present.length) throw new Error(`Missing ${label}`);
  if (
    !present.every((v) =>
      typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v) &&
      Number.isSafeInteger(Number(v))
    )
  ) throw new Error(`Malformed ${label}`);
  if (!present.every((v) => v === present[0])) throw new Error(`Conflicting ${label}`);
  return Number(present[0]);
}

function path(value: unknown): string {
  if (
    typeof value !== 'string' || value !== value.trim() ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    !(value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) ||
    value.split(/[\\/]/).some((s) => s === '..' || s === '.') || /[\\/]$/.test(value)
  ) throw new Error('Missing or invalid exact import path');
  return value;
}

function importPath(data: Record<string, unknown>, key: 'droppedPath' | 'importedPath') {
  const values = [data[key], data[key[0].toUpperCase() + key.slice(1)]].filter((v) =>
    v !== undefined
  );
  if (!values.length || !values.every((v) => v === values[0])) {
    throw new Error('Missing or conflicting exact import path');
  }
  return path(values[0]);
}

export function parseHistoricalImports(
  payload: unknown,
  seriesId: number,
  service: 'sonarr' | 'radarr' = 'sonarr',
): HistoricalImportEvidence {
  positive(seriesId);
  if (!Array.isArray(payload) || payload.length > 50_000) {
    throw new Error('Unsupported or oversized historical import evidence');
  }
  const result: HistoricalImportEvidence = { records: [], problems: [] };
  for (const raw of payload) {
    let episodeId: number | null = null;
    let movieId: number | null = null;
    const provenance: Pick<
      HistoricalImportEvidence['problems'][number],
      'droppedPath' | 'importedPath' | 'historyId'
    > = {};
    try {
      const row = object(raw);
      if (typeof row.eventType !== 'string') throw new Error('Malformed history event');
      if (row.eventType.toLowerCase() !== 'downloadfolderimported') continue;
      const data = object(row.data);
      // Parse independently: a bad file ID must not erase an exact source,
      // and a bad destination must not hide the separately valid source either.
      for (const key of ['droppedPath', 'importedPath'] as const) {
        try {
          provenance[key] = importPath(data, key);
        } catch { /* No guessed path. */ }
      }
      try {
        provenance.historyId = positive(row.id);
      } catch { /* Preserve other fields. */ }
      if (service === 'radarr') {
        movieId = positive(row.movieId);
        if (movieId !== seriesId) throw new Error('Conflicting import movie');
      } else {
        if (positive(row.seriesId) !== seriesId) throw new Error('Conflicting import series');
        episodeId = positive(row.episodeId);
      }
      const fileId = decimal([data.fileId, data.FileId], 'imported file ID');
      positive(fileId);
      if (typeof row.date !== 'string' || !Number.isFinite(Date.parse(row.date))) {
        throw new Error('Missing import date');
      }
      result.records.push({
        historyId: positive(row.id),
        ...(service === 'radarr'
          ? { service, movieId: movieId! }
          : { seriesId, episodeId: episodeId! }),
        fileId,
        droppedPath: importPath(data, 'droppedPath'),
        importedPath: importPath(data, 'importedPath'),
        date: row.date,
        downloadId: typeof row.downloadId === 'string' ? row.downloadId : null,
      });
    } catch (error) {
      result.problems.push({
        episodeId,
        ...(service === 'radarr' ? { movieId } : {}),
        reason: (error as Error).message,
        ...provenance,
      });
    }
  }
  return result;
}
