import { isNotFoundError } from "./api.ts";

// A 404 on a per-library/per-item query only means "not synced yet" while a sync that
// could plausibly produce this row is still running or hasn't been checked yet
// (`resolvable`) — the backend returns the same 404 for that as it does for "this was
// deleted from Plex" / "this link is stale", so without `resolvable` a genuinely gone
// item would show "will resolve automatically" forever instead of a real error.
export function useNotSyncedYet(
  isError: boolean,
  error: unknown,
  resolvable: boolean,
): boolean {
  return isError && isNotFoundError(error) && resolvable;
}
