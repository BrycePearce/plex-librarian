import { assertEquals } from "@std/assert";
import {
  deletionOperationPollInterval,
  deletionOperationTitle,
} from "./-deletionOperationState.ts";

Deno.test("deletion operation UI polls only while work can still change", () => {
  assertEquals(deletionOperationPollInterval("queued"), 2000);
  assertEquals(deletionOperationPollInterval("waiting_retry"), 2000);
  assertEquals(deletionOperationPollInterval("completed"), false);
  assertEquals(deletionOperationPollInterval("needs_attention"), false);
  assertEquals(deletionOperationPollInterval("cancelled"), false);
});

Deno.test("terminal failures are presented as needing attention", () => {
  assertEquals(
    deletionOperationTitle("needs_attention"),
    "Deletion needs attention",
  );
});
