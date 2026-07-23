import { withTransaction } from '../../db/index.ts';
import type { PlexClient } from '../../integrations/plex/index.ts';
import { runLibrarySync, runSync } from './service.ts';
import type { SyncReporter } from './service.ts';
import { failStalePendingSyncs, finalizeSyncLog } from './syncLog.ts';
import type { LibrarySyncProgress } from '@plex-librarian/shared/types.ts';

type ActiveServer = { client: PlexClient; serverId: number };

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

// If a sync produces no progress (no phase transition, no item count increment) for
// this long, it's treated as stalled and failed outright. Every individual Plex request
// already has its own 30s timeout with limited retries (see PlexClient.get in
// integrations/plex), so a normal dead connection fails fast — this is a backstop for
// whatever lets a request evade that (observed once: a Plex host powered off mid-sync,
// which can leave a connection silently hanging rather than erroring, for 13+ hours).
// The orphaned task, if it ever does settle on its own after this fires, is a no-op:
// finalizeSyncLog's `status = 'pending'` guard discards a late result once the row has
// already been marked 'error'.
const SYNC_STALL_TIMEOUT_MS = Math.max(
  60_000,
  (parseInt(Deno.env.get('SYNC_STALL_TIMEOUT_MINUTES') ?? '', 10) || 15) * 60_000,
);

// Last time any progress was reported for a syncId. Populated at trigger time so a
// hang on the very first request (before onLibraries even fires) is still caught.
const lastProgressAt = new Map<number, number>();

function touchProgress(syncId: number): void {
  if (lastProgressAt.has(syncId)) lastProgressAt.set(syncId, Date.now());
}

// Races against the actual sync task in runSyncTask. Self-reschedules rather than
// firing once at a fixed delay, since progress events keep pushing the deadline out.
function watchdog(syncId: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    const check = () => {
      const idleMs = Date.now() - (lastProgressAt.get(syncId) ?? Date.now());
      if (idleMs >= SYNC_STALL_TIMEOUT_MS) {
        reject(new Error(`Sync stalled — no progress for ${Math.round(idleMs / 60_000)}m`));
        return;
      }
      timer = setTimeout(check, SYNC_STALL_TIMEOUT_MS - idleMs);
    };
    timer = setTimeout(check, SYNC_STALL_TIMEOUT_MS);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

export function getSyncProgress(syncId: number): LibrarySyncProgress[] | undefined {
  const entries = syncProgress.get(syncId);
  return entries ? [...entries.values()] : undefined;
}

export function isSyncActive(syncId: number): boolean {
  return activeSyncs.has(syncId);
}

// Marks stale (still-'pending') sync_log rows older than `olderThanSeconds` as 'error' —
// see failStalePendingSyncs in sync.ts. Excludes syncIds this process still considers
// active so a sync that's still genuinely in progress isn't second-guessed and marked
// 'error' just because it's been running a long time — that's the in-process watchdog's
// job, which keys off actual progress rather than total elapsed time. Called by
// scheduler.ts; kept here (rather than exporting activeSyncs) so callers never need to
// know its internal shape.
export async function sweepStalePendingSyncs(olderThanSeconds: number): Promise<void> {
  await failStalePendingSyncs(olderThanSeconds, [...activeSyncs]);
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
      touchProgress(syncId);
      syncProgress.set(
        syncId,
        new Map(
          libs.map((
            lib,
          ) => [lib.key, { key: lib.key, title: lib.title, phase: 'pending', count: 0 }]),
        ),
      );
      void pushEvent(syncId, 'libraries', { libraries: libs });
    },
    onPhase: (libraryKey, phase) => {
      touchProgress(syncId);
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
      touchProgress(syncId);
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
  lastProgressAt.delete(syncId);

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
  serverId: number,
  libraryKey: string | null,
  task: () => Promise<number>,
): Promise<void> {
  let result: { ok: true; itemsProcessed: number } | { ok: false; error: string } | null = null;
  const dog = watchdog(syncId);
  try {
    const itemsProcessed = await Promise.race([task(), dog.promise]);
    await finalizeSyncLog(syncId, serverId, libraryKey, { ok: true, itemsProcessed });
    result = { ok: true, itemsProcessed };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`Sync ${syncId} failed:`, err);
    await finalizeSyncLog(syncId, serverId, libraryKey, { ok: false, error });
    result = { ok: false, error };
  } finally {
    dog.cancel();
    await cleanupSync(syncId, result);
  }
}

// Takes the already-resolved active server (see resolveActiveServer() in integrations/plex)
// from the caller and threads the same {client, serverId} pair through to both the
// sync_log insert and the task that actually executes the sync — so a server switch
// racing with the caller's resolution can't log the row under one server while syncing
// another. Callers must resolve once (rather than re-resolving here) so the serverId a
// route validated against (e.g. a library lookup) can never diverge from the one a sync
// actually runs against. The pending-sync conflict check is scoped to this serverId: an
// in-flight sync for a different (e.g. previously active) server must never block this one.
export function triggerFullSync(
  active: ActiveServer,
): { syncId: number } | { conflict: number } {
  const { client: plex, serverId } = active;
  const startedAt = Math.floor(Date.now() / 1000);
  const result = withTransaction((client): { conflict: number } | { id: number } => {
    const existing = client
      .prepare("SELECT id FROM sync_log WHERE status = 'pending' AND server_id = ? LIMIT 1")
      .value<[number]>(serverId);
    if (existing) return { conflict: existing[0] };
    const deletion = client
      .prepare(
        "SELECT 1 FROM deletion_operations WHERE server_id = ? AND status IN ('queued','running','waiting_retry') LIMIT 1",
      )
      .value<[number]>(serverId);
    if (deletion) return { conflict: -1 };
    const row = client
      .prepare(
        "INSERT INTO sync_log (server_id, started_at, status, items_processed) VALUES (?, ?, 'pending', 0) RETURNING id",
      )
      .value<[number]>(serverId, startedAt);
    if (!row) throw new Error('sync_log insert returned no id');
    return { id: row[0] };
  });
  if ('conflict' in result) return { conflict: result.conflict };
  const { id: syncId } = result;
  activeSyncs.add(syncId);
  lastProgressAt.set(syncId, Date.now());
  void runSyncTask(
    syncId,
    serverId,
    null,
    () => runSync(plex, serverId, makeReporter(syncId)),
  );
  return { syncId };
}

export function triggerLibrarySync(
  active: ActiveServer,
  libraryKey: string,
): { syncId: number } | { conflict: number } {
  const { client: plex, serverId } = active;
  const startedAt = Math.floor(Date.now() / 1000);
  const result = withTransaction((client): { conflict: number } | { id: number } => {
    const existing = client
      .prepare(
        "SELECT id FROM sync_log WHERE status = 'pending' AND server_id = ? LIMIT 1",
      )
      .value<[number]>(serverId);
    if (existing) return { conflict: existing[0] };
    const deletion = client
      .prepare(
        "SELECT 1 FROM deletion_operations WHERE server_id = ? AND library_key = ? AND status IN ('queued','running','waiting_retry') LIMIT 1",
      )
      .value<[number]>(serverId, libraryKey);
    if (deletion) return { conflict: -1 };
    const row = client
      .prepare(
        "INSERT INTO sync_log (server_id, library_key, started_at, status, items_processed) VALUES (?, ?, ?, 'pending', 0) RETURNING id",
      )
      .value<[number]>(serverId, libraryKey, startedAt);
    if (!row) throw new Error('sync_log insert returned no id');
    return { id: row[0] };
  });
  if ('conflict' in result) return { conflict: result.conflict };
  const { id: syncId } = result;
  activeSyncs.add(syncId);
  lastProgressAt.set(syncId, Date.now());
  void runSyncTask(
    syncId,
    serverId,
    libraryKey,
    () => runLibrarySync(plex, serverId, libraryKey, makeReporter(syncId)),
  );
  return { syncId };
}
