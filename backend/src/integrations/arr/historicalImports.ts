/** Exact import evidence. Invalid import rows are retained as explicit problems,
 * never silently dropped in favour of a convenient conflicting record. */
export interface HistoricalImport {
  historyId: number;
  seriesId: number;
  episodeId: number;
  fileId: number;
  droppedPath: string;
  importedPath: string;
  size: number;
  date: string;
  downloadId: string | null;
}

export interface HistoricalImportEvidence {
  records: HistoricalImport[];
  problems: Array<{ episodeId: number | null; reason: string }>;
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
  if (
    !present.length || !present.every((v) =>
      typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v) &&
      Number.isSafeInteger(Number(v)) && v === present[0]
    )
  ) throw new Error(`Missing, malformed or conflicting ${label}`);
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

export function parseHistoricalImports(
  payload: unknown,
  seriesId: number,
): HistoricalImportEvidence {
  positive(seriesId);
  if (!Array.isArray(payload) || payload.length > 50_000) {
    throw new Error('Unsupported or oversized historical import evidence');
  }
  const result: HistoricalImportEvidence = { records: [], problems: [] };
  for (const raw of payload) {
    let episodeId: number | null = null;
    try {
      const row = object(raw);
      if (typeof row.eventType !== 'string') throw new Error('Malformed history event');
      if (row.eventType.toLowerCase() !== 'downloadfolderimported') continue;
      episodeId = positive(row.episodeId);
      if (positive(row.seriesId) !== seriesId) throw new Error('Conflicting import series');
      const data = object(row.data);
      const fileId = decimal([data.fileId, data.FileId], 'imported file ID');
      positive(fileId);
      if (typeof row.date !== 'string' || !Number.isFinite(Date.parse(row.date))) {
        throw new Error('Missing import date');
      }
      result.records.push({
        historyId: positive(row.id),
        seriesId,
        episodeId,
        fileId,
        droppedPath: path(data.droppedPath),
        importedPath: path(data.importedPath),
        size: decimal([data.size, data.Size], 'recorded byte size'),
        date: row.date,
        downloadId: typeof row.downloadId === 'string' ? row.downloadId : null,
      });
    } catch (error) {
      result.problems.push({ episodeId, reason: (error as Error).message });
    }
  }
  return result;
}
