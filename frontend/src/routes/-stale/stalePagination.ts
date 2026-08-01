import type { StaleResponse } from "@shared/types";

// The HTTP response permits total=null for count=false, but every stale-page cache entry
// is normalized to this shape before it reaches the UI. Keeping that invariant here means
// the existing exact-total UI never needs nullable branches.
export type CountedStaleResponse = Omit<StaleResponse, "total"> & { total: number };

export function requireStaleTotal(response: StaleResponse): CountedStaleResponse {
  if (response.total === null) {
    throw new Error("stale response did not include the requested total");
  }
  return response as CountedStaleResponse;
}

export function reuseStaleTotal(
  response: StaleResponse,
  knownTotal: number,
): CountedStaleResponse {
  return { ...response, total: response.total ?? knownTotal };
}

export function lastStalePageOffset(total: number, pageSize: number): number {
  if (total <= 0) return 0;
  return Math.floor((total - 1) / pageSize) * pageSize;
}
