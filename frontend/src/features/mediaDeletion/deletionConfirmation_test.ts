import { assertEquals } from "@std/assert";
import { deletionConfirmationBlocked } from "./deletionConfirmation.ts";

const ready = {
  pending: false,
  hasSelection: true,
  preview: "ready" as const,
  fallbackRequired: false,
  fallbackAcknowledged: false,
};

Deno.test("loading and error previews terminate deletion confirmation", () => {
  assertEquals(
    deletionConfirmationBlocked({ ...ready, preview: "loading" }),
    true,
  );
  assertEquals(
    deletionConfirmationBlocked({ ...ready, preview: "error" }),
    true,
  );
  assertEquals(deletionConfirmationBlocked(ready), false);
});

Deno.test("fallback acknowledgement cannot be bypassed", () => {
  assertEquals(
    deletionConfirmationBlocked({ ...ready, fallbackRequired: true }),
    true,
  );
  assertEquals(
    deletionConfirmationBlocked({
      ...ready,
      fallbackRequired: true,
      fallbackAcknowledged: true,
    }),
    false,
  );
});

Deno.test("pending, empty, and semantic blocks always win", () => {
  assertEquals(deletionConfirmationBlocked({ ...ready, pending: true }), true);
  assertEquals(
    deletionConfirmationBlocked({ ...ready, hasSelection: false }),
    true,
  );
  assertEquals(
    deletionConfirmationBlocked({ ...ready, semanticBlock: true }),
    true,
  );
});
