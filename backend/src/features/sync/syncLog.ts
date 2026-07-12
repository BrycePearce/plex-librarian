import { and, eq, lt, notInArray, type SQL } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import { syncLog } from '../../db/schema.ts';
import { type LogEventInput, logEvents } from '../events/service.ts';

export async function finalizeSyncLog(
  syncId: number,
  serverId: number,
  libraryKey: string | null,
  result: { ok: true; itemsProcessed: number } | { ok: false; error: string },
): Promise<void> {
  const finishedAt = Math.floor(Date.now() / 1000);
  const setPayload = result.ok
    ? { status: 'success' as const, finishedAt, itemsProcessed: result.itemsProcessed }
    : { status: 'error' as const, finishedAt, error: result.error };
  const where = and(eq(syncLog.id, syncId), eq(syncLog.status, 'pending'));
  const rows = await db.update(syncLog).set(setPayload).where(where).returning({ id: syncLog.id });

  if (rows.length === 0) return;

  await logEvents([
    result.ok
      ? {
        serverId,
        type: 'sync.completed',
        payload: { syncId, libraryKey, itemsProcessed: result.itemsProcessed },
      }
      : {
        serverId,
        type: 'sync.failed',
        payload: { syncId, libraryKey, error: result.error },
      },
  ]);
}

function formatRoughDuration(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

async function failPendingSyncsMatching(extraWhere: SQL, reason: string): Promise<void> {
  const finishedAt = Math.floor(Date.now() / 1000);
  const error = `interrupted — ${reason}`;
  const rows = await db.update(syncLog)
    .set({ status: 'error', finishedAt, error })
    .where(and(eq(syncLog.status, 'pending'), extraWhere))
    .returning({ id: syncLog.id, serverId: syncLog.serverId, libraryKey: syncLog.libraryKey });

  if (rows.length === 0) return;

  const eventInputs: LogEventInput[] = [];
  for (const row of rows) {
    if (row.serverId === null) continue;
    eventInputs.push({
      serverId: row.serverId,
      type: 'sync.failed',
      payload: { syncId: row.id, libraryKey: row.libraryKey, error },
    });
  }
  await logEvents(eventInputs);
}

export async function failAllPendingSyncs(): Promise<void> {
  await failPendingSyncsMatching(eq(syncLog.status, 'pending'), 'server restarted');
}

export async function failStalePendingSyncs(
  olderThanSeconds: number,
  excludeSyncIds: number[] = [],
): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds;
  const where = excludeSyncIds.length > 0
    ? and(lt(syncLog.startedAt, cutoff), notInArray(syncLog.id, excludeSyncIds))!
    : lt(syncLog.startedAt, cutoff);
  await failPendingSyncsMatching(
    where,
    `no progress for over ${formatRoughDuration(olderThanSeconds)}`,
  );
}
