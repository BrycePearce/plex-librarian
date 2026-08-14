import { ArcadeGame } from "archive-defender";
import "archive-defender/style.css";
import { createLazyFileRoute, useNavigate } from "@tanstack/react-router";

function ArcadeRoute() {
  const navigate = useNavigate();
  return (
    <ArcadeGame
      startup="resume-or-new"
      audioStart="immediate"
      onExit={() => void navigate({ to: "/" })}
    />
  );
}

export const Route = createLazyFileRoute("/arcade")({
  component: ArcadeRoute,
});
