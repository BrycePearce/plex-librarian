import { withTransaction } from '../db/index.ts';
import { finalizeSyncLog, runSync, runLibrarySync } from './sync.ts';
import type { SyncReporter } from './sync.ts';
import type { LibrarySyncProgress } from '@plex-librarian/shared/types.ts';

interface SSEWriter {
  writeSSE(message: { event: string; data: string }): Promise<void>;
}

// In-memory progress for active syncs. Outer key: syncId; inner key: libraryKey.
const syncProgress = new Map<number, Map<string, LibrarySyncProgress>>();

// Active sync IDs — added at trigger time, removed in cleanupSync.
const activeSyncs = new Set<number>();

// Per-syncId SSE streams: writer → resolve-function for the "done" promise.
const syncStreams = new Map<number, Map<SSEWriter, () => void>>();

// Per-library item-phase start time. Keyed by the entry object so entries are
// automatically eligible for GC once the progress map is cleared.
const itemStartTimes = new WeakMap<LibrarySyncProgress, number>();

export function getSyncProgress(syncId: number): LibrarySyncProgress[] | undefined {
  const entries = syncProgress.get(syncId);
  return entries ? [...entries.values()] : undefined;
}

export function isSyncActive(syncId: number): boolean {
  return activeSyncs.has(syncId);
}

export function registerStream(syncId: number, stream: SSEWriter): Promise<void> {
  let streams = syncStreams.get(syncId);
  if (!streams) {
    streams = new Map();
    syncStreams.set(syncId, streams);
  }
  return new Promise<void>((resolve) => {
    streams!.set(stream, resolve);
  });
}

export function unregisterStream(syncId: number, stream: SSEWriter): void {
  const streams = syncStreams.get(syncId);
  if (!streams) return;
  const resolve = streams.get(stream);
  streams.delete(stream);
  resolve?.();
}

function getEntry(syncId: number, libraryKey: string): LibrarySyncProgress | undefined {
  return syncProgress.get(syncId)?.get(libraryKey);
}

async function pushEvent(syncId: number, event: string, data: object): Promise<void> {
  const streams = syncStreams.get(syncId);
  if (!streams || streams.size === 0) return;
  const msg = { event, data: JSON.stringify(data) };
  await Promise.all([...streams.keys()].map((s) => s.writeSSE(msg)));
}

function makeReporter(syncId: number): SyncReporter {
  return {
    onLibraries: (libs) => {
      syncProgress.set(
        syncId,
        new Map(libs.map((lib) => [lib.key, { key: lib.key, title: lib.title, phase: 'pending', count: 0 }])),
      );
      void pushEvent(syncId, 'libraries', { libraries: libs });
    },
    onPhase: (libraryKey, phase) => {
      const entry = getEntry(syncId, libraryKey);
      if (!entry) return;
      entry.phase = phase;
      if (phase === 'items') {
        itemStartTimes.set(entry, performance.now());
      } else if (phase === 'done') {
        const startedAt = itemStartTimes.get(entry);
        if (startedAt !== undefined) {
          entry.elapsedSeconds = Math.max(1, Math.round((performance.now() - startedAt) / 1000));
        }
      }
      void pushEvent(syncId, 'phase', {
        libraryKey,
        phase,
        ...(entry.elapsedSeconds !== undefined ? { elapsedSeconds: entry.elapsedSeconds } : {}),
      });
    },
    onCount: (libraryKey, delta) => {
      const entry = getEntry(syncId, libraryKey);
      if (entry) entry.count += delta;
      void pushEvent(syncId, 'count', { libraryKey, delta });
    },
  };
}

async function cleanupSync(
  syncId: number,
  result: { ok: true; itemsProcessed: number } | { ok: false; error: string } | null,
): Promise<void> {
  activeSyncs.delete(syncId);
  syncProgress.delete(syncId);

  const streams = syncStreams.get(syncId);
  syncStreams.delete(syncId);

  if (!streams || streams.size === 0) return;

  const msg = result?.ok === true
    ? { event: 'complete', data: JSON.stringify({ itemsProcessed: result.itemsProcessed }) }
    : { event: 'sync-error', data: JSON.stringify({ error: result?.error ?? 'unknown error' }) };

  await Promise.all([...streams.keys()].map((s) => s.writeSSE(msg)));
  for (const resolve of streams.values()) resolve();
}

async function runSyncTask(
  syncId: number,
  task: () => Promise<number>,
): Promise<void> {
  let result: { ok: true; itemsProcessed: number } | { ok: false; error: string } | null = null;
  try {
    const itemsProcessed = await task();
    await finalizeSyncLog(syncId, { ok: true, itemsProcessed });
    result = { ok: true, itemsProcessed };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`Sync ${syncId} failed:`, err);
    await finalizeSyncLog(syncId, { ok: false, error });
    result = { ok: false, error };
  } finally {
    await cleanupSync(syncId, result);
  }
}

export function triggerFullSync(): { syncId: number } | { conflict: number } {
  const startedAt = Math.floor(Date.now() / 1000);
  const result = withTransaction((client): { conflict: number } | { id: number } => {
    const existing = client
      .prepare("SELECT id FROM sync_log WHERE status = 'pending' LIMIT 1")
      .value<[number]>();
    if (existing) return { conflict: existing[0] };
    const row = client
      .prepare("INSERT INTO sync_log (started_at, status, items_processed) VALUES (?, 'pending', 0) RETURNING id")
      .value<[number]>(startedAt);
    if (!row) throw new Error('sync_log insert returned no id');
    return { id: row[0] };
  });
  if ('conflict' in result) return { conflict: result.conflict };
  const { id: syncId } = result;
  activeSyncs.add(syncId);
  void runSyncTask(syncId, () => runSync(makeReporter(syncId)));
  return { syncId };
}

export function triggerLibrarySync(libraryKey: string): { syncId: number } | { conflict: number } {
  const startedAt = Math.floor(Date.now() / 1000);
  const result = withTransaction((client): { conflict: number } | { id: number } => {
    const existing = client
      .prepare("SELECT id FROM sync_log WHERE status = 'pending' AND (library_key IS NULL OR library_key = ?) LIMIT 1")
      .value<[number]>(libraryKey);
    if (existing) return { conflict: existing[0] };
    const row = client
      .prepare("INSERT INTO sync_log (library_key, started_at, status, items_processed) VALUES (?, ?, 'pending', 0) RETURNING id")
      .value<[number]>(libraryKey, startedAt);
    if (!row) throw new Error('sync_log insert returned no id');
    return { id: row[0] };
  });
  if ('conflict' in result) return { conflict: result.conflict };
  const { id: syncId } = result;
  activeSyncs.add(syncId);
  void runSyncTask(syncId, () => runLibrarySync(libraryKey, makeReporter(syncId)));
  return { syncId };
}
