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
Deno.test("manual access feedback includes actual root, status and diagnostic", () => {
  assertEquals(historicalCheckMessage([failed]), "/downloads: setup needed. missing");
  assertEquals(
    historicalCheckMessage([{
      ...failed,
      status: "waiting_for_sample",
      reason: "No exact sample",
    }]),
    "/downloads: waiting for sample. No exact sample",
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
