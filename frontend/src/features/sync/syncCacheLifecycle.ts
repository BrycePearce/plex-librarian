export type GlobalSyncObservation = {
  id: number;
  status: "pending" | "success" | "error";
};

export type SyncCacheLifecycleState = {
  historyReady: boolean;
  completedInvalidationId: number | null;
  streamErrorInvalidationId: number | null;
};

export type SyncCacheLifecycleTransition = {
  state: SyncCacheLifecycleState;
  shouldInvalidate: boolean;
};

export const initialSyncCacheLifecycleState: SyncCacheLifecycleState = {
  historyReady: false,
  completedInvalidationId: null,
  streamErrorInvalidationId: null,
};

// `undefined` means the history cache is loading or was reset during a server switch;
// `null` means history loaded successfully but contains no global sync row.
export function observeGlobalSyncHistory(
  state: SyncCacheLifecycleState,
  latest: GlobalSyncObservation | null | undefined,
): SyncCacheLifecycleTransition {
  if (latest === undefined) {
    return {
      state: { ...state, historyReady: false },
      shouldInvalidate: false,
    };
  }

  if (!state.historyReady) {
    return {
      state: {
        ...state,
        historyReady: true,
        completedInvalidationId: latest !== null && latest.status !== "pending"
          ? latest.id
          : state.completedInvalidationId,
      },
      shouldInvalidate: false,
    };
  }

  if (
    latest === null || latest.status === "pending" ||
    state.completedInvalidationId === latest.id
  ) {
    return { state, shouldInvalidate: false };
  }

  return {
    state: { ...state, completedInvalidationId: latest.id },
    shouldInvalidate: true,
  };
}

export function observeGlobalSyncStream(
  state: SyncCacheLifecycleState,
  syncId: number | null,
  isDone: boolean,
  error: string | null,
): SyncCacheLifecycleTransition {
  if (syncId === null) return { state, shouldInvalidate: false };

  if (isDone) {
    if (state.completedInvalidationId === syncId) {
      return { state, shouldInvalidate: false };
    }
    return {
      state: { ...state, completedInvalidationId: syncId },
      shouldInvalidate: true,
    };
  }

  if (error !== null && state.streamErrorInvalidationId !== syncId) {
    // Do not mark this sync completed: a dropped stream can later resolve successfully
    // through history polling, in which case its final data should be invalidated again.
    return {
      state: { ...state, streamErrorInvalidationId: syncId },
      shouldInvalidate: true,
    };
  }

  return { state, shouldInvalidate: false };
}
