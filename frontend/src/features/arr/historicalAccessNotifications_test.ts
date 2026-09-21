import { assertEquals } from "@std/assert";
import {
  historicalAccessNotification,
  historicalCheckMessage,
} from "./historicalAccessNotifications.ts";
import type { HistoricalAccessStatus } from "../../../../shared/historicalDownloads.ts";
const failed: HistoricalAccessStatus = {
  id: "1:1:/downloads",
  instanceId: 1,
  configuration: {
    enabled: true,
    remoteRoot: "/downloads",
    localRoot: "/cleanup",
    noRemainingClient: false,
  },
  revision: "1",
  status: "setup_needed",
  sample: "/downloads/file",
  reason: "missing",
  checkedAt: 1,
  succeededAt: null,
  problemRevision: "problem",
  dismissedRevision: null,
};
Deno.test("access guidance is actionable and never copies raw exceptions or sample paths", () => {
  for (
    const [code, expected] of [
      ["missing_root", "Add its host-folder mount"],
      ["access_denied", "container identity"],
      ["read_only", "Read/Write"],
      ["sample_absent", "old sample file is gone"],
      ["timeout", "retry Check access"],
      ["unsupported", "/usr/bin/test"],
    ] as const
  ) {
    const text = historicalCheckMessage([{
      ...failed,
      reason: "secret-token raw exception",
      diagnostic: { code, folder: "/cleanup/release" },
    }]);
    assertEquals(text.includes(expected), true);
    assertEquals(text.includes("secret-token"), false);
    assertEquals(text.includes("/downloads/file"), false);
  }
  assertEquals(
    historicalCheckMessage([{ ...failed, status: "available", reason: null }]).includes(
      "passed read-only",
    ),
    true,
  );
});
Deno.test("access recovery notifies once, stays quiet on retries, and never carries notices across servers", () => {
  const initial = historicalAccessNotification(undefined, 1, [failed]);
  assertEquals(initial.message, null);
  const retry = historicalAccessNotification(initial.snapshot, 1, [{ ...failed, checkedAt: 2 }]);
  assertEquals(retry.message, null);
  const recovered = { ...failed, status: "available" as const, problemRevision: null };
  const recovery = historicalAccessNotification(retry.snapshot, 1, [recovered]);
  assertEquals(!!recovery.message, true);
  assertEquals(historicalAccessNotification(recovery.snapshot, 1, [recovered]).message, null);
  assertEquals(historicalAccessNotification(retry.snapshot, 2, [recovered]).message, null);
  assertEquals(historicalAccessNotification(retry.snapshot, null, []).message, null);
  assertEquals(
    historicalAccessNotification(retry.snapshot, 1, [{
      ...recovered,
      configuration: { ...failed.configuration, enabled: false },
    }]).message,
    null,
  );
});
