import { canCancelDeletionTarget } from "./-deletionOperationState.ts";
import { assertEquals } from "@std/assert";
import {
  deletionAttemptSummary,
  deletionAttentionSummary,
  deletionOperationPollInterval,
  deletionOperationTitle,
  deletionTargetProgress,
  deletionWarningSummary,
  hardlinkOutcomeSummary,
  isRelocationGuidanceActive,
  lastConfirmedDeletionAction,
  nonSupersededCancelledCount,
  noVerifiedDiskSpaceReclaimed,
  retryableRelocationSafeTargetCount,
  storageOutcomeExplanations,
} from "./-deletionOperationState.ts";

Deno.test("ordinary activity reports unmeasured disk recovery instead of a hardlink warning", () => {
  assertEquals(
    hardlinkOutcomeSummary({ serviceOwnedDeletion: true, unknownTargetCount: 1 }),
    "Disk space recovered unknown — not measured",
  );
});

Deno.test("deletion operation UI polls only while work can still change", () => {
  assertEquals(deletionOperationPollInterval("queued"), 2000);
  assertEquals(deletionOperationPollInterval("waiting_retry"), 10000);
  assertEquals(deletionOperationPollInterval("completed"), false);
  assertEquals(deletionOperationPollInterval("completed_with_warning"), false);
  assertEquals(deletionOperationPollInterval("needs_attention"), false);
  assertEquals(deletionOperationPollInterval("cancelled"), false);
});

Deno.test("partial Sonarr failures report confirmed removals", () => {
  assertEquals(deletionAttentionSummary(1, 1), "1 removed · 1 need attention");
});

Deno.test("warning summaries do not claim removal after a safe rollback", () => {
  assertEquals(deletionWarningSummary(0, 1), "No Plex media removal was confirmed");
  assertEquals(deletionWarningSummary(2, 1), "2 removed · 1 warning");
});

Deno.test("relocation guidance is active only before its sync barrier", () => {
  const base = {
    status: "needs_attention",
    phase: "validating",
    relocationGuidanceState: "valid" as const,
    relocationSyncBarrierState: "none" as const,
  };
  assertEquals(isRelocationGuidanceActive(base), true);
  assertEquals(isRelocationGuidanceActive({ ...base, status: "cancelled" }), false);
  assertEquals(isRelocationGuidanceActive({ ...base, phase: "arr_coordination" }), false);
  assertEquals(
    isRelocationGuidanceActive({ ...base, relocationSyncBarrierState: "incomplete" }),
    false,
  );
});

Deno.test("superseded targets are excluded from the ordinary cancelled total", () => {
  assertEquals(nonSupersededCancelledCount(3, 2), 1);
  assertEquals(nonSupersededCancelledCount(1, 1), 0);
  assertEquals(nonSupersededCancelledCount(0, 1), 0);
});

Deno.test("generic retry counts exclude every present relocation workflow state", () => {
  const target = (
    status: string,
    relocationGuidanceState: "none" | "valid" | "invalid" = "none",
    relocationSyncBarrierState: "none" | "incomplete" | "completed" | "invalid" = "none",
    phase = "validating",
  ) => ({ status, phase, relocationGuidanceState, relocationSyncBarrierState });
  const targets = [
    target("needs_attention"),
    target("needs_attention", "valid"),
    target("needs_attention", "invalid"),
    target("needs_attention", "none", "invalid"),
    target("completed_with_warning"),
    target("completed_with_warning", "none", "none", "finalizing"),
    target("completed_with_warning", "invalid"),
    target("completed_with_warning", "none", "incomplete"),
  ];

  assertEquals(retryableRelocationSafeTargetCount(targets, "needs_attention"), 1);
  assertEquals(retryableRelocationSafeTargetCount(targets, "completed_with_warning"), 1);
});

Deno.test("generic terminal warnings do not assume confirmed removal or a particular service", () => {
  assertEquals(
    deletionOperationTitle("completed_with_warning"),
    "Deletion completed with warning",
  );
});

Deno.test("queued and validating work do not claim deletion has started", () => {
  assertEquals(deletionOperationTitle("queued", "validating"), "Deletion queued");
  assertEquals(deletionOperationTitle("running", "validating"), "Checking deletion safety");
  assertEquals(
    deletionTargetProgress({ status: "waiting_retry", phase: "plex_reconciliation" }),
    "Waiting to retry",
  );
  assertEquals(
    deletionOperationTitle("running", "plex_reconciliation"),
    "Removing media and reconciling Plex",
  );
  assertEquals(
    lastConfirmedDeletionAction({ removalConfirmedAt: null, plexReconciledAt: null }),
    "No media removal confirmed",
  );
  assertEquals(
    lastConfirmedDeletionAction({ removalConfirmedAt: 10, plexReconciledAt: null }),
    "Media removal confirmed",
  );
  assertEquals(
    lastConfirmedDeletionAction({ removalConfirmedAt: 10, plexReconciledAt: 11 }),
    "Plex reconciliation confirmed",
  );
});

Deno.test("ordinary service checkpoints take precedence over the legacy phase and counter", () => {
  assertEquals(
    lastConfirmedDeletionAction({
      serviceOwnedDeletion: true,
      removalConfirmedAt: 10,
      plexReconciledAt: 10,
    }),
    "Service deletion workflow completed",
  );
  const target = {
    status: "running",
    phase: "validating",
    serviceOwnedDeletion: true,
    plexAttemptCount: 0,
    serviceOutcomes: [{ status: "failed" }, { status: "reconciled" }],
  };
  assertEquals(deletionTargetProgress(target), "Processing service deletion");
  assertEquals(deletionAttemptSummary(target), "Recorded service requests: 1");
  assertEquals(
    deletionAttemptSummary({ ...target, serviceOutcomes: [{ status: "uncertain" }] }),
    "Recorded service requests: 1",
  );
  assertEquals(deletionAttemptSummary({ plexAttemptCount: 2 }), "Plex deletion attempts: 2");
});

Deno.test("terminal failures are presented as needing attention", () => {
  assertEquals(
    deletionOperationTitle("needs_attention"),
    "Deletion needs attention",
  );
});

Deno.test("hardlink outcomes use durable counts instead of a rounded byte total", () => {
  assertEquals(
    hardlinkOutcomeSummary({
      verifiedHardlinkDataRemoved: 0,
      verifiedTargetCount: 1,
      unknownTargetCount: 0,
      mixedTargetCount: 0,
    }),
    "0 KB verified hardlink data removed",
  );
  assertEquals(
    hardlinkOutcomeSummary({
      verifiedHardlinkDataRemoved: 0,
      verifiedTargetCount: 0,
      unknownTargetCount: 1,
      mixedTargetCount: 0,
    }),
    "Hardlink data removal not verified",
  );
  assertEquals(hardlinkOutcomeSummary({}), null);
});

Deno.test("completed removals call out an entirely unverified storage outcome", () => {
  assertEquals(
    noVerifiedDiskSpaceReclaimed({
      status: "completed",
      removalConfirmedCount: 1,
      verifiedHardlinkDataRemoved: 0,
      verifiedTargetCount: 0,
      unknownTargetCount: 1,
      mixedTargetCount: 0,
    }),
    true,
  );
  assertEquals(
    noVerifiedDiskSpaceReclaimed({
      status: "completed",
      removalConfirmedCount: 1,
      verifiedHardlinkDataRemoved: 40,
      verifiedTargetCount: 1,
      unknownTargetCount: 0,
      mixedTargetCount: 0,
    }),
    false,
  );
});

Deno.test("storage outcome reasons are readable, unique, and forward compatible", () => {
  assertEquals(
    storageOutcomeExplanations([
      {
        storageOutcomeReasons: [
          "incomplete_two_link_proof",
          "ambiguous_sonarr_instance",
        ],
      },
      {
        storageOutcomeReasons: [
          "incomplete_two_link_proof",
          "future_reason",
          "another_future_reason",
        ],
      },
    ]),
    [
      "Plex Librarian could not establish and confirm the required two-link hardlink identity.",
      "More than one Sonarr instance matched this media, so historical hardlink cleanup was not authorized.",
      "Plex Librarian could not verify storage reclamation for at least one target.",
    ],
  );
});

Deno.test("upgrade-held cancellation follows durable eligibility rather than UI status", () => {
  assertEquals(
    canCancelDeletionTarget({
      status: "needs_attention",
      upgradeHold: true,
      upgradeHoldCancellable: true,
    }),
    true,
  );
  assertEquals(
    canCancelDeletionTarget({ status: "queued", upgradeHold: true, upgradeHoldCancellable: false }),
    false,
  );
  assertEquals(canCancelDeletionTarget({ status: "needs_attention", upgradeHold: true }), false);
  assertEquals(canCancelDeletionTarget({ status: "needs_attention" }), false);
  assertEquals(canCancelDeletionTarget({ status: "queued" }), true);
});

Deno.test("ordinary cancellation uses durable no-attempt eligibility, including preflight holds", () => {
  assertEquals(
    canCancelDeletionTarget({ status: "needs_attention", ordinaryCancellable: true }),
    true,
  );
  assertEquals(
    canCancelDeletionTarget({ status: "waiting_retry", ordinaryCancellable: true }),
    true,
  );
  assertEquals(canCancelDeletionTarget({ status: "queued", ordinaryCancellable: false }), false);
});
