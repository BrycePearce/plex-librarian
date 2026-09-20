import { type DurableTargetSnapshot } from '../core/validation.ts';

export function persistedRetainedMediaId(snapshot: DurableTargetSnapshot): number | null {
  if (snapshot.radarrRemovalFallback) return snapshot.radarrRemovalFallback.retainedMediaId;
  if (snapshot.seasonCoordinationOutcome === 'removed_and_unmonitored') return null;
  const retained = new Set(
    (snapshot.arrReassignments ?? []).map((entry) => entry.retainedMediaId),
  );
  if (retained.size === 0) return null;
  if (retained.size !== 1) throw new Error('The persisted Arr reassignment target is inconsistent');
  return [...retained][0]!;
}
