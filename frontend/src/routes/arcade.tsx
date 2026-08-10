import { createFileRoute } from "@tanstack/react-router";
import { requireAuth } from "../lib/requireAuth.ts";

export const Route = createFileRoute("/arcade")({
  beforeLoad: ({ context }) => requireAuth(context.queryClient),
});
