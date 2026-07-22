import { createFileRoute } from "@tanstack/react-router";
import { requireAuth } from "../lib/requireAuth.ts";
import { ArrIntegrationDialog } from "../features/arr/ArrIntegrationDialog.tsx";

// A real, direct-linkable URL for the media-manager dialog — mounted (and thus opened)
// only while this route is active, via the <Outlet/> in the parent /settings route.
export const Route = createFileRoute("/settings/sonarr-radarr")({
  beforeLoad: ({ context }) => requireAuth(context.queryClient),
  component: ArrIntegrationDialog,
});
