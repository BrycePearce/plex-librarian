import { createFileRoute } from "@tanstack/react-router";
import { requireAuth } from "../lib/requireAuth.ts";
import { ArcadeGame } from "../features/arcade/ArcadeGame.tsx";

export const Route = createFileRoute("/arcade")({
  beforeLoad: ({ context }) => requireAuth(context.queryClient),
  component: ArcadeGame,
});
