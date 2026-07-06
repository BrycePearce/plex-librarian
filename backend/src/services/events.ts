import { db } from '../db/index.ts';
import { LOG_RETENTION_DAYS, pruneOlderThan } from '../db/prune.ts';
import { events } from '../db/schema.ts';
import type {
  ItemsDeletedPayload,
  SyncCompletedPayload,
  SyncFailedPayload,
} from '@plex-librarian/shared/types.ts';

// Discriminated on `type` so a caller can't attach a payload shape that doesn't match
// what the frontend expects to find for that EventType (see ActivityEvent in shared/types.ts).
// No `summary` field: the human-readable line is rendered from `type` + `payload` at
// display time (frontend), not persisted — see the `events` table comment in schema.ts.
export type LogEventInput =
  | { serverId: number; type: 'sync.completed'; payload?: SyncCompletedPayload }
  | { serverId: number; type: 'sync.failed'; payload?: SyncFailedPayload }
  | { serverId: number; type: 'items.deleted'; payload?: ItemsDeletedPayload };

// Never lets a logging failure fail the caller — recording that a sync/deletion
// happened is secondary to the action itself actually succeeding. Takes an array (not
// a single event) since crash-recovery sweeps can touch several sync_log rows at once
// and callers with just one event pass a single-element array.
export async function logEvents(inputs: LogEventInput[]): Promise<void> {
  if (inputs.length === 0) return;
  try {
    await db.insert(events).values(
      inputs.map((input) => ({
        serverId: input.serverId,
        type: input.type,
        payload: input.payload ? JSON.stringify(input.payload) : null,
        createdAt: Math.floor(Date.now() / 1000),
      })),
    );
  } catch (err) {
    console.error('Failed to record activity event(s):', err);
  }
}

export async function pruneOldEvents(): Promise<void> {
  await pruneOlderThan(events, events.createdAt, LOG_RETENTION_DAYS);
}
