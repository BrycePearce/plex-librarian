import { HistoricalUnlinkNotAttempted } from '../../mediaDeletion/historicalDownloadErrors.ts';
/** Optional attempts deliberately never enter serviceOwnedAttempts. */
export type HistoricalDownloadOutcome =
  | 'success'
  | 'already_absent'
  | 'changed'
  | 'skipped'
  | 'failed'
  | 'uncertain';
export interface HistoricalDownloadAttempt {
  version: 1;
  id: string;
  entry: string;
  status: 'pending' | 'intent' | HistoricalDownloadOutcome;
  reason?: string;
}

export interface HistoricalJournalStore {
  get(id: string): HistoricalDownloadAttempt;
  /** Synchronous durable transaction; must complete before returning. */
  save(attempt: HistoricalDownloadAttempt): void;
}

/** Injected boundary used by the disposable gate; the caller owns operation locks,
 * transactional reservations and service checks. Never resumes an uncertain intent. */
export async function runHistoricalDownloadAttempt(
  store: HistoricalJournalStore,
  id: string,
  hooks: {
    cancelled(): boolean;
    validate(): Promise<'ready' | 'already_absent' | 'changed' | 'skipped'>;
    unlink(): Promise<void>;
  },
) {
  const attempt = store.get(id);
  if (attempt.version !== 1) throw new Error('Unsupported optional journal version');
  if (attempt.status === 'intent') {
    store.save({
      ...attempt,
      status: 'uncertain',
      reason: 'Interrupted after persisted unlink intent; never replayed',
    });
    return;
  }
  if (attempt.status !== 'pending') return;
  if (hooks.cancelled()) {
    store.save({ ...attempt, status: 'skipped', reason: 'Cancelled before optional cleanup' });
    return;
  }
  let validation;
  try {
    validation = await hooks.validate();
  } catch (error) {
    store.save({
      ...attempt,
      status: 'skipped',
      reason: `Verification unavailable: ${String(error)}`,
    });
    return;
  }
  if (hooks.cancelled() || validation !== 'ready') {
    store.save({
      ...attempt,
      status: hooks.cancelled() ? 'skipped' : validation as HistoricalDownloadOutcome,
      reason: hooks.cancelled() ? 'Cancelled before optional cleanup' : validation,
    });
    return;
  }
  store.save({ ...attempt, status: 'intent' });
  try {
    await hooks.unlink();
  } catch (error) {
    // Permission/capability rejection is definite. EIO, network filesystem errors,
    // and unclassified errors can follow a lost unlink outcome; retain their hold.
    const status = error instanceof HistoricalUnlinkNotAttempted
      ? error.outcome
      : error instanceof Deno.errors.PermissionDenied || error instanceof Deno.errors.NotCapable
      ? 'failed'
      : 'uncertain';
    store.save({ ...attempt, status, reason: String(error) });
    return;
  }
  // A failed completion write must leave intent, not overwrite it as a definite failure.
  store.save({ ...attempt, status: 'success' });
}
