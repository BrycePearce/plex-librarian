import { assertEquals } from "@std/assert";
import { deletionRecoveryGuidance, deletionRecoverySummary } from "./recoveryGuidance.ts";

Deno.test("retained Radarr folder failures recommend making the kept file visible", () => {
  const guidance = deletionRecoveryGuidance({
    error:
      "Radarr has no visible retained Plex version in its exact current movie folder with known size and no competing file",
    phase: "validating",
  });
  assertEquals(guidance.title, "Make the retained file visible to Radarr");
  assertEquals(guidance.steps.length, 3);
});

Deno.test("manually disappeared sources recommend cross-service verification", () => {
  const guidance = deletionRecoveryGuidance({
    error: "The Plex source disappeared before Arr ownership was persisted",
    phase: "validating",
  });
  assertEquals(guidance.title, "Verify the manual deletion in both services");
});

Deno.test("structured recovery workflows take precedence over error text", () => {
  const guidance = deletionRecoveryGuidance({
    error: "anything",
    phase: "validating",
    relocationGuidanceState: "valid",
    relocationSyncBarrierState: "none",
  });
  assertEquals(guidance.title, "Move the retained version into Radarr's managed location");
});

Deno.test("attention summaries return the first concrete recovery step", () => {
  assertEquals(
    deletionRecoverySummary(["Plex is unreachable: connection refused"]),
    "Confirm Plex, Sonarr/Radarr, and any configured download client are reachable.",
  );
});

Deno.test("warning summaries explain automatic recovery after a Plex sync", () => {
  assertEquals(
    deletionRecoverySummary(["unexpected metadata response"], "completed_with_warning"),
    "Scan the Plex library. Plex Librarian will recheck after the next successful sync.",
  );
});

Deno.test("structured recovery state never recommends an unavailable dismiss action", () => {
  const guidance = deletionRecoveryGuidance({
    error: "anything",
    phase: "validating",
    relocationGuidanceState: "invalid",
    relocationSyncBarrierState: "none",
  });
  assertEquals(guidance.title, "Continue the recovery workflow");
  assertEquals(guidance.steps, [
    "Use the recovery workflow below to finish the required repair or sync.",
  ]);
});
