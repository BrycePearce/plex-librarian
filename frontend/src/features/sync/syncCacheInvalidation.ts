import type { QueryClient } from "@tanstack/react-query";
import { invalidateSyncDerivedQueries } from "../../lib/queryCache.ts";

type Invalidation = { syncId: number; promise: Promise<void> };
type ClientInvalidations = { completed?: Invalidation; streamError?: Invalidation };

// Dashboard and the root coordinator can observe the same SSE completion. Remember
// only the latest completion/error per client, so their fallback coverage does not
// cancel and restart each other's refetches or retain every historical sync id.
const invalidations = new WeakMap<QueryClient, ClientInvalidations>();

export function invalidateGlobalSyncQueries(
  client: QueryClient,
  syncId: number,
  completed: boolean,
): Promise<void> {
  const state = invalidations.get(client) ?? {};
  if (state.completed?.syncId === syncId) return state.completed.promise;
  if (!completed && state.streamError?.syncId === syncId) return state.streamError.promise;

  // Store the claim before notifying query observers, including synchronous subscribers.
  const promise = Promise.resolve().then(() => invalidateSyncDerivedQueries(client));
  state[completed ? "completed" : "streamError"] = { syncId, promise };
  invalidations.set(client, state);
  return promise;
}
