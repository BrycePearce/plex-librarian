import { assertEquals } from "@std/assert";
import {
  initialSyncCacheLifecycleState,
  observeGlobalSyncHistory,
  observeGlobalSyncStream,
} from "./syncCacheLifecycle.ts";

Deno.test("initial terminal history is a baseline, not a completion signal", () => {
  const result = observeGlobalSyncHistory(initialSyncCacheLifecycleState, {
    id: 10,
    status: "success",
  });

  assertEquals(result.shouldInvalidate, false);
  assertEquals(result.state.historyReady, true);
  assertEquals(result.state.completedInvalidationId, 10);
});

Deno.test("pending history becoming terminal invalidates exactly once", () => {
  const pending = observeGlobalSyncHistory(initialSyncCacheLifecycleState, {
    id: 11,
    status: "pending",
  });
  const completed = observeGlobalSyncHistory(pending.state, {
    id: 11,
    status: "success",
  });
  const repeated = observeGlobalSyncHistory(completed.state, {
    id: 11,
    status: "success",
  });

  assertEquals(pending.shouldInvalidate, false);
  assertEquals(completed.shouldInvalidate, true);
  assertEquals(repeated.shouldInvalidate, false);
});

Deno.test("a fast sync first observed as a new terminal row invalidates", () => {
  const baseline = observeGlobalSyncHistory(initialSyncCacheLifecycleState, {
    id: 11,
    status: "success",
  });
  const completed = observeGlobalSyncHistory(baseline.state, {
    id: 12,
    status: "success",
  });

  assertEquals(completed.shouldInvalidate, true);
  assertEquals(completed.state.completedInvalidationId, 12);
});

Deno.test("stream error and later history success each invalidate once", () => {
  const pending = observeGlobalSyncHistory(initialSyncCacheLifecycleState, {
    id: 13,
    status: "pending",
  });
  const streamError = observeGlobalSyncStream(
    pending.state,
    13,
    false,
    "Lost connection",
  );
  const repeatedError = observeGlobalSyncStream(
    streamError.state,
    13,
    false,
    "Lost connection",
  );
  const completed = observeGlobalSyncHistory(streamError.state, {
    id: 13,
    status: "success",
  });

  assertEquals(streamError.shouldInvalidate, true);
  assertEquals(repeatedError.shouldInvalidate, false);
  assertEquals(completed.shouldInvalidate, true);
});

Deno.test("history reset establishes a fresh server baseline", () => {
  const oldServer = observeGlobalSyncHistory(initialSyncCacheLifecycleState, {
    id: 20,
    status: "success",
  });
  const reset = observeGlobalSyncHistory(oldServer.state, undefined);
  const newServer = observeGlobalSyncHistory(reset.state, {
    id: 7,
    status: "error",
  });

  assertEquals(reset.state.historyReady, false);
  assertEquals(newServer.shouldInvalidate, false);
  assertEquals(newServer.state.completedInvalidationId, 7);
});

Deno.test("stream completion invalidates exactly once", () => {
  const completed = observeGlobalSyncStream(
    initialSyncCacheLifecycleState,
    14,
    true,
    null,
  );
  const repeated = observeGlobalSyncStream(
    completed.state,
    14,
    true,
    null,
  );

  assertEquals(completed.shouldInvalidate, true);
  assertEquals(repeated.shouldInvalidate, false);
});
